'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { BrandMark, Eyebrow, CaseCard } from '@/components/case-ui';
import { AuthButtons } from '@/components/auth-buttons';

function LoginContent() {
    const searchParams = useSearchParams();
    const redirectTo = searchParams.get('redirectTo') || '/analyze';
    const error = searchParams.get('error');

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

                    <AuthButtons redirectTo={redirectTo} />
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
