'use client';

import { useAuth } from '@/hooks/useAuth';
import Image from 'next/image';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

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
        <div className="min-h-screen bg-black flex flex-col items-center justify-center p-4">
            {/* 로고 */}
            <div className="mb-8 text-center">
                <div className="w-20 h-20 mx-auto mb-4">
                    <Image
                        src="/logo.png"
                        alt="AI 위장 여사친 판독기"
                        width={80}
                        height={80}
                        className="w-full h-full"
                        priority
                    />
                </div>
                <h1 className="text-2xl font-bold text-white">AI 위장 여사친 판독기</h1>
                <p className="text-gray-400 mt-2">로그인하고 분석을 시작하세요</p>
            </div>

            {/* 에러 메시지 */}
            {error && (
                <div className="w-full max-w-sm mb-4 p-3 bg-red-900/50 border border-red-500 rounded-lg text-red-200 text-sm text-center">
                    로그인에 실패했습니다. 다시 시도해주세요.
                </div>
            )}

            {/* 로그인 버튼 */}
            <div className="w-full max-w-sm space-y-3">
                {/* 카카오 로그인 */}
                <button
                    onClick={handleKakaoLogin}
                    disabled={loading}
                    className="w-full flex items-center justify-center gap-3 bg-[#FEE500] hover:bg-[#FDD835] text-[#3C1E1E] font-medium py-3.5 px-4 rounded-xl transition-all disabled:opacity-50"
                >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 3C6.48 3 2 6.58 2 11c0 2.83 1.89 5.31 4.71 6.73l-.97 3.59c-.11.41.32.73.69.51l4.09-2.61c.49.05.99.08 1.48.08 5.52 0 10-3.58 10-8s-4.48-8-10-8z" />
                    </svg>
                    카카오로 시작하기
                </button>

                {/* 구글 로그인 */}
                <button
                    onClick={handleGoogleLogin}
                    disabled={loading}
                    className="w-full flex items-center justify-center gap-3 bg-white hover:bg-gray-100 text-gray-800 font-medium py-3.5 px-4 rounded-xl transition-all disabled:opacity-50"
                >
                    <svg width="20" height="20" viewBox="0 0 24 24">
                        <path
                            fill="#4285F4"
                            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                        />
                        <path
                            fill="#34A853"
                            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                        />
                        <path
                            fill="#FBBC05"
                            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                        />
                        <path
                            fill="#EA4335"
                            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                        />
                    </svg>
                    Google로 시작하기
                </button>
            </div>

            {/* 안내 문구 */}
            <p className="mt-8 text-xs text-gray-500 text-center max-w-sm">
                로그인 시 <span className="text-emerald-400">이용약관</span> 및{' '}
                <span className="text-emerald-400">개인정보처리방침</span>에 동의하게 됩니다.
            </p>
        </div>
    );
}

export default function LoginPage() {
    return (
        <Suspense fallback={<div className="min-h-screen bg-black" />}>
            <LoginContent />
        </Suspense>
    );
}
