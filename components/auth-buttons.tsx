'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
    appOriginForRequest,
    appRedirectUrlForRequest,
} from '@/lib/constants/app-url';

// Kakao / Google OAuth buttons, shared by the /login 페이지·로그인 모달·회원가입 페이지.
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
    const googleText = label === 'signup' ? 'Google로 회원가입' : 'Google로 3초 만에 시작하기';

    const signIn = async (provider: 'kakao' | 'google') => {
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
            const { error } = await supabase.auth.signInWithOAuth({
                provider,
                options: {
                    redirectTo: callbackUrl.toString(),
                },
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

            <button
                onClick={() => signIn('google')}
                disabled={busy}
                className="flex w-full items-center justify-center gap-2.5 border border-line-2 bg-paper px-4 py-3.5 text-[14px] font-bold text-[#1f1c1a] transition-opacity hover:opacity-90 disabled:opacity-50"
            >
                <svg width="18" height="18" viewBox="0 0 24 24">
                    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                </svg>
                {googleText}
            </button>
        </div>
    );
}
