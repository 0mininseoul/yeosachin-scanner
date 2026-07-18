import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { NextResponse } from 'next/server';
import type { User } from '@supabase/supabase-js';
import { buildAuthProfilePatch } from '@/lib/services/identity/auth-profile';

const USER_RESPONSE_COLUMNS = 'id, email, provider, analysis_count, is_paid_user, is_unlimited, created_at, updated_at';
const USER_INTERNAL_COLUMNS = `${USER_RESPONSE_COLUMNS}, name, nickname, profile_image, gender, birthyear, phone_number, phone_number_normalized`;
const SAFE_DATABASE_CODE = /^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$/;

interface UserResponseDto {
    id: string;
    email: string;
    provider: string;
    analysis_count: number;
    is_paid_user: boolean;
    is_unlimited: boolean;
    created_at: string;
    updated_at: string;
}

type DatabaseOperation = 'read' | 'insert' | 'update';

// 소셜 로그인(카카오/구글)이 내려준 프로필 정보를 users 테이블 컬럼으로 매핑.
// user_metadata는 사용자가 수정할 수 있으므로 결제 식별용 전화번호로 사용하지 않는다.
// ⚠️ user_metadata 키는 공급자/Supabase 매핑에 따라 다를 수 있어 방어적으로 조회한다.
//    실제 로그인 후 users 테이블에 값이 비어 있으면 키 매핑을 조정할 것.
function extractProfile(user: User) {
    const m = (user.user_metadata ?? {}) as Record<string, unknown>;
    const phone = (
        typeof user.phone === 'string'
        && user.phone.trim()
        && typeof user.phone_confirmed_at === 'string'
        && user.phone_confirmed_at.trim()
    )
        ? { mode: 'synchronize' as const, value: user.phone }
        : { mode: 'preserve' as const };
    return buildAuthProfilePatch({
        name: [m.name, m.full_name],
        nickname: [m.nickname, m.preferred_username, m.user_name, m.name],
        profileImage: [m.avatar_url, m.picture, m.profile_image],
        gender: [m.gender],
        birthyear: [m.birthyear, m.birth_year],
        phone,
    });
}

function toUserResponse(row: Record<string, unknown>): UserResponseDto {
    return {
        id: row.id as string,
        email: row.email as string,
        provider: row.provider as string,
        analysis_count: row.analysis_count as number,
        is_paid_user: row.is_paid_user as boolean,
        is_unlimited: row.is_unlimited as boolean,
        created_at: row.created_at as string,
        updated_at: row.updated_at as string,
    };
}

function databaseErrorCode(error: unknown): string {
    if (typeof error !== 'object' || error === null) return 'unknown';
    const code = (error as { code?: unknown }).code;
    if (typeof code !== 'string') return 'unknown';
    const normalized = code.toUpperCase();
    return SAFE_DATABASE_CODE.test(normalized) ? normalized : 'unknown';
}

function logDatabaseFailure(operation: DatabaseOperation, error: unknown) {
    console.error('user.me database failure', operation, databaseErrorCode(error));
}

export async function GET() {
    try {
        const supabase = await createClient();

        // 인증 체크
        const { data: { user }, error: authError } = await supabase.auth.getUser();

        if (authError || !user) {
            return NextResponse.json(
                { error: '로그인이 필요합니다.' },
                { status: 401 }
            );
        }

        const profile = extractProfile(user);

        // Admin 클라이언트로 사용자 정보 조회 (RLS 우회)
        const { data: dbUser, error: dbError } = await supabaseAdmin
            .from('users')
            .select(USER_INTERNAL_COLUMNS)
            .eq('id', user.id)
            .single();

        if (dbError && databaseErrorCode(dbError) !== 'PGRST116') {
            logDatabaseFailure('read', dbError);
            return NextResponse.json(
                { error: '사용자 정보 조회에 실패했습니다.' },
                { status: 500 }
            );
        }

        if (!dbUser) {
            // 사용자 레코드가 없으면 생성 (소셜 프로필 정보 포함)
            const { data: newUser, error: createError } = await supabaseAdmin
                .from('users')
                .insert({
                    id: user.id,
                    email: user.email!,
                    provider: user.app_metadata.provider || 'google',
                    analysis_count: 0,
                    is_paid_user: false,
                    is_unlimited: false,
                    ...profile,
                })
                .select(USER_RESPONSE_COLUMNS)
                .single();

            if (createError || !newUser) {
                logDatabaseFailure('insert', createError);
                return NextResponse.json(
                    { error: '사용자 정보 생성에 실패했습니다.' },
                    { status: 500 }
                );
            }

            return NextResponse.json({
                user: toUserResponse(newUser as Record<string, unknown>),
            });
        }

        // 기존 유저: 새로 승인된 프로필 항목이 비어 있으면 백필
        const existing = dbUser as Record<string, unknown>;
        const patch: Record<string, string | null> = {};
        for (const [key, value] of Object.entries(profile)) {
            if (key === 'phone_number' || key === 'phone_number_normalized') {
                continue;
            }
            if (typeof value === 'string' && value && !existing[key]) {
                patch[key] = value;
            }
        }
        if (
            'phone_number' in profile
            || 'phone_number_normalized' in profile
        ) {
            patch.phone_number = profile.phone_number ?? null;
            patch.phone_number_normalized = profile.phone_number_normalized ?? null;
        }
        if (Object.keys(patch).length > 0) {
            const { data: updated, error: updateError } = await supabaseAdmin
                .from('users')
                .update(patch)
                .eq('id', user.id)
                .select(USER_RESPONSE_COLUMNS)
                .single();
            if (updateError || !updated) {
                logDatabaseFailure('update', updateError);
                return NextResponse.json(
                    { error: '사용자 정보 업데이트에 실패했습니다.' },
                    { status: 500 }
                );
            }
            return NextResponse.json({
                user: toUserResponse(updated as Record<string, unknown>),
            });
        }

        return NextResponse.json({ user: toUserResponse(existing) });
    } catch {
        console.error('user.me failure', 'unexpected');
        return NextResponse.json(
            { error: '서버 오류가 발생했습니다.' },
            { status: 500 }
        );
    }
}
