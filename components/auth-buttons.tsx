'use client';

import { useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
    appOriginForRequest,
    appRedirectUrlForRequest,
} from '@/lib/constants/app-url';
import {
    addAnonymousPreflightOAuthContinuation,
    writeOAuthRedirectIntentCookie,
} from '@/lib/services/auth/oauth-redirect-intent';
import {
    availableAnalyticsSessionStorage,
    beginPendingAuthEvent,
    clearPendingAuthEvent,
    type AuthMarkerStorage,
} from '@/lib/services/analytics-auth';

type OAuthProvider = 'kakao' | 'google';

interface OAuthOptions {
    redirectTo: string;
    scopes?: string;
    queryParams?: Record<string, string>;
}

interface OAuthResult {
    error: unknown | null;
}

interface PerformOAuthSignInInput {
    now?: number;
    options: OAuthOptions;
    provider: 'kakao' | 'google';
    signInWithOAuth: (input: {
        options: OAuthOptions;
        provider: OAuthProvider;
    }) => Promise<OAuthResult>;
    storage?: AuthMarkerStorage;
}

export async function performOAuthSignIn({
    now,
    options,
    provider,
    signInWithOAuth,
    storage,
}: PerformOAuthSignInInput): Promise<OAuthResult> {
    beginPendingAuthEvent({ now, provider, storage });
    try {
        const result = await signInWithOAuth({ provider, options });
        if (result.error) clearPendingAuthEvent(storage);
        return result;
    } catch (error) {
        clearPendingAuthEvent(storage);
        throw error;
    }
}

// Kakao OAuth button, shared by the /login 페이지·로그인 모달.
// 로그인 버튼만 필요하므로 full useAuth(유저 조회/구독) 대신 supabase를 직접 호출한다.
export function AuthButtons({
    redirectTo = '/analyze',
    disabled = false,
    promptKakaoLogin = false,
}: {
    redirectTo?: string;
    disabled?: boolean;
    promptKakaoLogin?: boolean;
}) {
    const [pending, setPending] = useState<'kakao' | 'google' | null>(null);
    const signInStarted = useRef(false);
    const busy = disabled || pending !== null;
    const kakaoText = '카카오로 3초 만에 시작하기';

    const signIn = async (provider: OAuthProvider) => {
        if (disabled || signInStarted.current) return;
        signInStarted.current = true;
        setPending(provider);
        try {
            const supabase = createClient();
            const appOrigin = appOriginForRequest(window.location.href);
            const nextUrl = appRedirectUrlForRequest(window.location.href, redirectTo);
            const nextPath = `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
            writeOAuthRedirectIntentCookie(
                nextPath,
                value => { document.cookie = value; },
                window.location.protocol === 'https:',
            );
            const callbackUrl = new URL('/auth/callback', appOrigin);
            callbackUrl.searchParams.set(
                'next',
                nextPath
            );
            addAnonymousPreflightOAuthContinuation(callbackUrl, nextUrl);
            // Dev와 운영 앱에 승인된 동일한 7개 동의항목을 요청한다.
            // 구글은 기본 scope(email·profile) 사용.
            const scopes =
                provider === 'kakao'
                    ? 'account_email profile_nickname profile_image name gender birthyear phone_number'
                    : undefined;
            const { error } = await performOAuthSignIn({
                provider,
                options: {
                    redirectTo: callbackUrl.toString(),
                    scopes,
                    ...(provider === 'kakao' && promptKakaoLogin ? { queryParams: { prompt: 'login' } } : {}),
                },
                signInWithOAuth: (input) => supabase.auth.signInWithOAuth(input),
                storage: availableAnalyticsSessionStorage(),
            });
            if (error) {
                console.error(`${provider} login error:`, error);
                signInStarted.current = false;
                setPending(null);
            }
            // 성공 시 브라우저가 OAuth 제공자로 리다이렉트됨
        } catch (e) {
            console.error(`${provider} login error:`, e);
            signInStarted.current = false;
            setPending(null);
        }
    };

    return (
        <div className="space-y-2.5">
            <button
                onClick={() => signIn('kakao')}
                disabled={busy}
                className="flex w-full items-center justify-center gap-2.5 bg-[#FEE500] px-4 py-3.5 text-[14px] font-bold text-[#3C1E1E] transition-opacity hover:opacity-90 disabled:opacity-50"
            >
                <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 3C6.48 3 2 6.58 2 11c0 2.83 1.89 5.31 4.71 6.73l-.97 3.59c-.11.41.32.73.69.51l4.09-2.61c.49.05.99.08 1.48.08 5.52 0 10-3.58 10-8s-4.48-8-10-8z" />
                </svg>
                {kakaoText}
            </button>
        </div>
    );
}
