'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { BrandMark, Eyebrow } from './case-ui';
import { AuthButtons } from './auth-buttons';

// Login as an overlay modal (used from the landing hero instead of routing to /login).
export function LoginModal({
    open,
    onClose,
    redirectTo = '/analyze',
}: {
    open: boolean;
    onClose: () => void;
    redirectTo?: string;
}) {
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.removeEventListener('keydown', onKey);
            document.body.style.overflow = prev;
        };
    }, [open, onClose]);

    if (!open) return null;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-5" role="dialog" aria-modal="true" aria-label="로그인">
            <div className="absolute inset-0 bg-ink/80 backdrop-blur-sm" onClick={onClose} />

            <div className="relative w-full max-w-[400px] border border-line bg-ink-2 p-6 shadow-2xl">
                <button
                    onClick={onClose}
                    aria-label="닫기"
                    className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center text-fg-mute transition-colors hover:text-fg"
                >
                    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
                    </svg>
                </button>

                <div className="mb-6 text-center">
                    <div className="mb-4 flex justify-center">
                        <div className="flex h-14 w-14 items-center justify-center border border-line bg-ink">
                            <BrandMark size={26} className="text-blood" />
                        </div>
                    </div>
                    <Eyebrow className="justify-center">접근 인증 필요</Eyebrow>
                    <h2 className="mt-3 text-[19px] font-extrabold tracking-tight text-fg">로그인하고 판독을 시작하세요</h2>
                    <p className="mt-1.5 text-[13px] text-fg-dim">입력한 아이디는 로그인 후 그대로 이어집니다.</p>
                </div>

                <AuthButtons redirectTo={redirectTo} />

                <p className="mt-5 text-center text-[12px] leading-relaxed text-fg-mute">
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

                <p className="mt-3 text-center text-[12px] text-fg-mute">
                    아직 회원이 아니신가요?{' '}
                    <Link href="/signup" className="font-semibold text-blood underline underline-offset-2 hover:text-blood-2">
                        회원가입
                    </Link>
                </p>
            </div>
        </div>
    );
}
