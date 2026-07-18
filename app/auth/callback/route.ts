import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    appOriginForRequest,
    appRedirectUrlForRequest,
} from '@/lib/constants/app-url';
import { buildAuthProfilePatch } from '@/lib/services/identity/auth-profile';
import {
    observeRoute,
    type OperationalRequestContext,
} from '@/lib/observability/request';
import { operationalLogger } from '@/lib/observability/server';

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
): Promise<'PROVIDER_ERROR' | 'INTERNAL_ERROR' | null> {
    const res = await fetch('https://kapi.kakao.com/v2/user/me', {
        headers: { Authorization: `Bearer ${providerToken}` },
        cache: 'no-store',
    });
    if (!res.ok) {
        console.error('Kakao /v2/user/me failed:', res.status);
        return 'PROVIDER_ERROR';
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
        phone: {
            mode: 'synchronize',
            value: account.phone_number,
        },
    });

    const { error } = await supabaseAdmin
        .from('users')
        .upsert({
            id: userId,
            ...(email ? { email } : {}),
            provider: 'kakao',
            ...profilePatch,
        }, { onConflict: 'id' });
    if (error) {
        console.error('users upsert (kakao profile) failed:', error.code);
        return 'INTERNAL_ERROR';
    }
    return null;
}

function authProvider(value: unknown): 'google' | 'kakao' | undefined {
    return value === 'google' || value === 'kakao' ? value : undefined;
}

async function handleGET(
    request: Request,
    context: OperationalRequestContext,
): Promise<NextResponse> {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const appOrigin = appOriginForRequest(request.url);

    if (!code) {
        console.error('Auth callback: No code provided');
        operationalLogger.emit({
            event: 'auth.callback_completed',
            severity: 'warn',
            fields: {
                ...context,
                operation: 'callback',
                disposition: 'rejected',
                error_code: 'INVALID_REQUEST',
            },
        });
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
    const exchangeResult = await supabase.auth.exchangeCodeForSession(code).catch(() => null);

    if (!exchangeResult || exchangeResult.error) {
        console.error('Auth callback exchange failed');
        operationalLogger.emit({
            event: 'auth.callback_completed',
            severity: 'warn',
            fields: {
                ...context,
                operation: 'callback',
                disposition: 'rejected',
                error_code: 'PROVIDER_ERROR',
            },
        });
        const loginUrl = new URL('/login', appOrigin);
        loginUrl.searchParams.set('error', 'exchange_failed');
        return NextResponse.redirect(loginUrl);
    }
    const exchange = exchangeResult.data;

    // 세션 검증을 통해 쿠키 설정 강제 (setAll 트리거)
    await supabase.auth.getUser();

    // 카카오: REST API로 성별·출생연도·전화번호 등 보강 저장
    const session = exchange?.session;
    const authedUser = exchange?.user;
    const provider = authProvider(authedUser?.app_metadata?.provider);
    if (authedUser && provider === 'kakao') {
        let errorCode: 'PROVIDER_ERROR' | 'INTERNAL_ERROR' | null;
        if (!session?.provider_token) {
            errorCode = 'PROVIDER_ERROR';
        } else {
            try {
                errorCode = await syncKakaoProfile(
                    authedUser.id,
                    authedUser.email ?? undefined,
                    session.provider_token
                );
            } catch {
                console.error('Kakao profile sync failed');
                errorCode = 'INTERNAL_ERROR';
            }
        }
        if (errorCode) {
            operationalLogger.emit({
                event: 'auth.profile_sync_failed',
                severity: 'warn',
                fields: {
                    ...context,
                    user_id: authedUser.id,
                    provider,
                    operation: 'profile_sync',
                    disposition: 'failed',
                    error_code: errorCode,
                },
            });
        }
    }

    const redirectUrl = appRedirectUrlForRequest(request.url, searchParams.get('next'));
    redirectUrl.searchParams.set('verified', 'true');

    operationalLogger.emit({
        event: 'auth.callback_completed',
        severity: 'info',
        fields: {
            ...context,
            ...(authedUser ? { user_id: authedUser.id } : {}),
            ...(provider ? { provider } : {}),
            operation: 'callback',
            disposition: 'completed',
        },
    });

    return NextResponse.redirect(redirectUrl);
}

export async function GET(request: Request): Promise<NextResponse> {
    return observeRoute(request, '/auth/callback', context => handleGET(request, context));
}
