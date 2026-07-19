'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
    appOriginForRequest,
    appRedirectUrlForRequest,
} from '@/lib/constants/app-url';
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

// Kakao OAuth button, shared by the /login 페이지·로그인 모달·회원가입 페이지.
// 로그인 버튼만 필요하므로 full useAuth(유저 조회/구독) 대신 supabase를 직접 호출한다.
export function AuthButtons({
    redirectTo = '/analyze',
    disabled = false,
    label = 'login',
}: {
    redirectTo?: string;
    disabled?: boolean;
    label?: 'login' | 'signup';
}) {
    const [pending, setPending] = useState<'kakao' | 'google' | null>(null);
    const busy = disabled || pending !== null;
    const kakaoText = label === 'signup' ? '카카오로 회원가입' : '카카오로 3초 만에 시작하기';

    const signIn = async (provider: OAuthProvider) => {
        setPending(provider);
        try {
            const supabase = createClient();
            const appOrigin = appOriginForRequest(window.location.href);
            const nextUrl = appRedirectUrlForRequest(window.location.href, redirectTo);
            const callbackUrl = new URL('/auth/callback', appOrigin);
            callbackUrl.searchParams.set(
                'next',
                `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`
            );
            // 카카오는 승인된 동의항목(이름·성별·출생연도·전화번호 등)을 받기 위해 scope를 명시.
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
                },
                signInWithOAuth: (input) => supabase.auth.signInWithOAuth(input),
                storage: availableAnalyticsSessionStorage(),
            });
            if (error) {
                console.error(`${provider} login error:`, error);
                setPending(null);
            }
            // 성공 시 브라우저가 OAuth 제공자로 리다이렉트됨
        } catch (e) {
            console.error(`${provider} login error:`, e);
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
