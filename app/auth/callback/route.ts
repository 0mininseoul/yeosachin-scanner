import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    appOriginForRequest,
    appRedirectUrlForRequest,
} from '@/lib/constants/app-url';
import { buildAuthProfilePatch } from '@/lib/services/identity/auth-profile';

function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

// 카카오 성별·출생연도·전화번호 등은 OIDC ID 토큰에 없고 REST API(/v2/user/me)에만 있으므로,
// 로그인 직후 확보한 provider_token(카카오 access token)으로 직접 조회해 users 테이블에 저장한다.
async function syncKakaoProfile(
    userId: string,
    email: string | undefined,
    providerToken: string
) {
    const res = await fetch('https://kapi.kakao.com/v2/user/me', {
        headers: { Authorization: `Bearer ${providerToken}` },
        cache: 'no-store',
    });
    if (!res.ok) {
        console.error('Kakao /v2/user/me failed:', res.status);
        return;
    }
    const data: unknown = await res.json();
    const account = asRecord(asRecord(data).kakao_account);
    const profile = asRecord(account.profile);
    const profilePatch = buildAuthProfilePatch({
        name: [account.name, profile.nickname],
        nickname: [profile.nickname],
        profileImage: [profile.profile_image_url, profile.thumbnail_image_url],
        gender: [account.gender],
        birthyear: [account.birthyear],
        phoneNumber: [account.phone_number],
    });

    const { error } = await supabaseAdmin
        .from('users')
        .upsert({
            id: userId,
            ...(email ? { email } : {}),
            provider: 'kakao',
            ...profilePatch,
        }, { onConflict: 'id' });
    if (error) console.error('users upsert (kakao profile) failed:', error.code);
}

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const appOrigin = appOriginForRequest(request.url);

    if (!code) {
        console.error('Auth callback: No code provided');
        return NextResponse.redirect(new URL('/login?error=no_code', appOrigin));
    }

    const cookieStore = await cookies();

    // Supabase 클라이언트 생성 - cookieStore.set() 사용 (Next.js 네이티브 방식)
    const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                getAll() {
                    return cookieStore.getAll();
                },
                setAll(cookiesToSet) {
                    cookiesToSet.forEach(({ name, value, options }) => {
                        cookieStore.set(name, value, options);
                    });
                },
            },
        }
    );

    // 코드 교환 실행
    const { data: exchange, error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
        console.error('Auth callback error:', error);
        const loginUrl = new URL('/login', appOrigin);
        loginUrl.searchParams.set('error', error.message);
        return NextResponse.redirect(loginUrl);
    }

    // 세션 검증을 통해 쿠키 설정 강제 (setAll 트리거)
    await supabase.auth.getUser();

    // 카카오: REST API로 성별·출생연도·전화번호 등 보강 저장
    const session = exchange?.session;
    const authedUser = exchange?.user;
    if (
        authedUser &&
        session?.provider_token &&
        authedUser.app_metadata?.provider === 'kakao'
    ) {
        try {
            await syncKakaoProfile(authedUser.id, authedUser.email ?? undefined, session.provider_token);
        } catch {
            console.error('Kakao profile sync failed');
        }
    }

    const redirectUrl = appRedirectUrlForRequest(request.url, searchParams.get('next'));
    redirectUrl.searchParams.set('verified', 'true');

    return NextResponse.redirect(redirectUrl);
}
