import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import type { User } from '@supabase/supabase-js';
import { buildAuthProfilePatch } from '@/lib/services/identity/auth-profile';
import {
    AccountPrincipalPersistenceError,
    ensureAccountPrincipal,
    loadAccountPrincipal,
    type AccountPrincipal,
    type SocialAccountProfile,
} from '@/lib/services/identity/account-principal-store';

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
const SOCIAL_PROFILE_FIELDS = [
    'name',
    'nickname',
    'profile_image',
    'gender',
    'birthyear',
] as const;

function extractProfile(user: User): SocialAccountProfile {
    const m = (user.user_metadata ?? {}) as Record<string, unknown>;
    const patch = buildAuthProfilePatch({
        name: [m.name, m.full_name],
        nickname: [m.nickname, m.preferred_username, m.user_name, m.name],
        profileImage: [m.avatar_url, m.picture, m.profile_image],
        gender: [m.gender],
        birthyear: [m.birthyear, m.birth_year],
    });
    return {
        ...(patch.name ? { name: patch.name } : {}),
        ...(patch.nickname ? { nickname: patch.nickname } : {}),
        ...(patch.profile_image ? { profile_image: patch.profile_image } : {}),
        ...(patch.gender ? { gender: patch.gender } : {}),
        ...(patch.birthyear ? { birthyear: patch.birthyear } : {}),
    };
}

function toUserResponse(row: AccountPrincipal): UserResponseDto {
    return {
        id: row.id,
        email: row.email,
        provider: row.provider,
        analysis_count: row.analysis_count,
        is_paid_user: row.is_paid_user,
        is_unlimited: row.is_unlimited,
        created_at: row.created_at,
        updated_at: row.updated_at,
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

function bridgeDatabaseError(error: unknown) {
    return {
        code: error instanceof AccountPrincipalPersistenceError
            ? error.databaseCode
            : 'unknown',
    };
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

        // Stable service-role RPC boundary keeps this revision valid before
        // and after the physical users -> account_principals cutover.
        let dbUser: AccountPrincipal | null;
        try {
            dbUser = await loadAccountPrincipal(user.id);
        } catch (error) {
            logDatabaseFailure('read', bridgeDatabaseError(error));
            return NextResponse.json(
                { error: '사용자 정보 조회에 실패했습니다.' },
                { status: 500 }
            );
        }

        if (!dbUser) {
            if (!user.email) {
                logDatabaseFailure('insert', { code: 'ACCOUNT_EMAIL_REQUIRED' });
                return NextResponse.json(
                    { error: '사용자 정보 생성에 실패했습니다.' },
                    { status: 500 }
                );
            }
            const provider = user.app_metadata.provider === 'kakao'
                ? 'kakao'
                : 'google';
            let newUser: AccountPrincipal;
            try {
                newUser = await ensureAccountPrincipal({
                    userId: user.id,
                    email: user.email,
                    provider,
                    profile,
                });
            } catch (error) {
                logDatabaseFailure('insert', bridgeDatabaseError(error));
                return NextResponse.json(
                    { error: '사용자 정보 생성에 실패했습니다.' },
                    { status: 500 }
                );
            }

            return NextResponse.json({
                user: toUserResponse(newUser),
            });
        }

        // /api/user/me is the browser session bootstrap path. A retired
        // principal must not receive a live-looking DTO that keeps the app
        // session admitted while later APIs reject it.
        if (dbUser.lifecycle !== 'active') {
            return NextResponse.json(
                {
                    error: '계정을 사용할 수 없습니다.',
                    code: 'ACCOUNT_ADMISSION_DENIED',
                },
                { status: 403 },
            );
        }

        // 기존 유저: 새로 승인된 프로필 항목이 비어 있으면 백필
        const existing = dbUser;
        const patch: SocialAccountProfile = {};
        for (const field of SOCIAL_PROFILE_FIELDS) {
            const value = profile[field];
            if (value && !existing[field]) {
                patch[field] = value;
            }
        }
        if (Object.keys(patch).length > 0) {
            if (!user.email) {
                logDatabaseFailure('update', { code: 'ACCOUNT_EMAIL_REQUIRED' });
                return NextResponse.json(
                    { error: '사용자 정보 업데이트에 실패했습니다.' },
                    { status: 500 }
                );
            }
            const provider = user.app_metadata.provider === 'kakao'
                ? 'kakao'
                : 'google';
            let updated: AccountPrincipal;
            try {
                updated = await ensureAccountPrincipal({
                    userId: user.id,
                    email: user.email,
                    provider,
                    profile: patch,
                });
            } catch (error) {
                logDatabaseFailure('update', bridgeDatabaseError(error));
                return NextResponse.json(
                    { error: '사용자 정보 업데이트에 실패했습니다.' },
                    { status: 500 }
                );
            }
            return NextResponse.json({
                user: toUserResponse(updated),
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
