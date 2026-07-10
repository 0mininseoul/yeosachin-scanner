'use client';

import { useAuth } from '@/hooks/useAuth';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { BrandMark, Eyebrow, CaseCard } from '@/components/case-ui';

function LoginContent() {
    const { signInWithKakao, signInWithGoogle, loading } = useAuth();
    const searchParams = useSearchParams();
    const redirectTo = searchParams.get('redirectTo') || '/analyze';
    const error = searchParams.get('error');

    const handleKakaoLogin = async () => {
        try {
            await signInWithKakao(redirectTo);
        } catch (error) {
            console.error('Kakao login error:', error);
        }
    };

    const handleGoogleLogin = async () => {
        try {
            await signInWithGoogle(redirectTo);
        } catch (error) {
            console.error('Google login error:', error);
        }
    };

    return (
        <div className="flex min-h-dvh flex-col items-center justify-center px-5 py-12">
            <div className="w-full max-w-[400px]">
                {/* brand + header */}
                <div className="mb-8 text-center">
                    <div className="mb-5 flex justify-center">
                        <div className="flex h-16 w-16 items-center justify-center border border-line bg-ink-2">
                            <BrandMark size={30} className="text-blood" />
                        </div>
                    </div>
                    <Eyebrow className="justify-center">접근 인증</Eyebrow>
                    <h1 className="mt-4 text-[22px] font-extrabold tracking-tight text-fg">
                        AI 위장 여사친 판독기
                    </h1>
                    <p className="mt-2 text-[13px] text-fg-dim">인증 후 판독을 시작하세요.</p>
                </div>

                <CaseCard className="p-5">
                    <div className="mb-4 flex items-center justify-between">
                        <span className="eyebrow">인증 수단 선택</span>
                        <span className="num text-[11px] tracking-[0.18em] text-fg-mute">SECURE</span>
                    </div>

                    {error && (
                        <div className="mb-4 border border-blood/45 bg-blood/10 px-3 py-2.5 text-[13px] text-blood">
                            인증에 실패했습니다. 다시 시도해 주세요.
                        </div>
                    )}

                    <div className="space-y-2.5">
                        <button
                            onClick={handleKakaoLogin}
                            disabled={loading}
                            className="flex w-full items-center justify-center gap-2.5 bg-[#FEE500] px-4 py-3.5 text-[14px] font-bold text-[#3C1E1E] transition-opacity hover:opacity-90 disabled:opacity-50"
                        >
                            <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M12 3C6.48 3 2 6.58 2 11c0 2.83 1.89 5.31 4.71 6.73l-.97 3.59c-.11.41.32.73.69.51l4.09-2.61c.49.05.99.08 1.48.08 5.52 0 10-3.58 10-8s-4.48-8-10-8z" />
                            </svg>
                            카카오로 시작하기
                        </button>

                        <button
                            onClick={handleGoogleLogin}
                            disabled={loading}
                            className="flex w-full items-center justify-center gap-2.5 border border-line-2 bg-paper px-4 py-3.5 text-[14px] font-bold text-[#1f1c1a] transition-opacity hover:opacity-90 disabled:opacity-50"
                        >
                            <svg width="18" height="18" viewBox="0 0 24 24">
                                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                            </svg>
                            Google로 시작하기
                        </button>
                    </div>
                </CaseCard>

                <p className="mt-6 text-center text-[12px] leading-relaxed text-fg-mute">
                    인증 시{' '}
                    <Link href="/terms" className="text-fg-dim underline underline-offset-2 hover:text-fg">
                        이용약관
                    </Link>{' '}
                    및{' '}
                    <Link href="/privacy" className="text-fg-dim underline underline-offset-2 hover:text-fg">
                        개인정보처리방침
                    </Link>
                    에 동의하게 됩니다.
                </p>
            </div>
        </div>
    );
}

export default function LoginPage() {
    return (
        <Suspense fallback={<div className="min-h-dvh" />}>
            <LoginContent />
        </Suspense>
    );
}
