import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { NextResponse } from 'next/server';
import type { User } from '@supabase/supabase-js';

// 소셜 로그인(카카오/구글)이 내려준 프로필 정보를 users 테이블 컬럼으로 매핑.
// 카카오 승인 항목: 이름·성별·출생연도·전화번호·닉네임·프로필사진·이메일.
// ⚠️ user_metadata 키는 공급자/Supabase 매핑에 따라 다를 수 있어 방어적으로 조회한다.
//    실제 로그인 후 users 테이블에 값이 비어 있으면 키 매핑을 조정할 것.
function extractProfile(user: User) {
    const m = (user.user_metadata ?? {}) as Record<string, unknown>;
    const s = (v: unknown): string | null =>
        typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null;
    return {
        name: s(m.name) ?? s(m.full_name),
        nickname: s(m.nickname) ?? s(m.preferred_username) ?? s(m.user_name) ?? s(m.name),
        profile_image: s(m.avatar_url) ?? s(m.picture) ?? s(m.profile_image),
        phone_number: s(user.phone) ?? s(m.phone_number) ?? s(m.phone),
        gender: s(m.gender),
        birthyear: s(m.birthyear) ?? s(m.birth_year),
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

        // Admin 클라이언트로 사용자 정보 조회 (RLS 우회)
        const { data: dbUser, error: dbError } = await supabaseAdmin
            .from('users')
            .select('*')
            .eq('id', user.id)
            .single();

        if (dbError || !dbUser) {
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
                .select()
                .single();

            if (createError) {
                console.error('User creation error:', createError);
                return NextResponse.json(
                    { error: '사용자 정보 생성에 실패했습니다.' },
                    { status: 500 }
                );
            }

            return NextResponse.json({ user: newUser });
        }

        // 기존 유저: 새로 승인된 프로필 항목이 비어 있으면 백필
        const existing = dbUser as Record<string, unknown>;
        const patch: Record<string, string> = {};
        for (const [key, value] of Object.entries(profile)) {
            if (value && !existing[key]) patch[key] = value;
        }
        if (Object.keys(patch).length > 0) {
            const { data: updated } = await supabaseAdmin
                .from('users')
                .update(patch)
                .eq('id', user.id)
                .select()
                .single();
            if (updated) return NextResponse.json({ user: updated });
        }

        return NextResponse.json({ user: dbUser });
    } catch (error) {
        console.error('User fetch error:', error);
        return NextResponse.json(
            { error: '서버 오류가 발생했습니다.' },
            { status: 500 }
        );
    }
}
