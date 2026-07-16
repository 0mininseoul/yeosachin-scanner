'use client';

import { useState } from 'react';
import Link from 'next/link';
import { TopBar, BrandMark, Eyebrow, CaseCard } from '@/components/case-ui';
import { AuthButtons } from '@/components/auth-buttons';

// 회원가입 화면 — 카카오 소셜 로그인 개인정보 동의항목 심사용.
// 카카오/구글 계정에서 아래 필수/선택 회원정보를 제공받아 가입한다.

function FieldRow({ label, required, note }: { label: string; required?: boolean; note: string }) {
    return (
        <div className="flex items-center gap-3 py-2.5">
            <span className="w-20 shrink-0 text-[13px] text-fg-dim">
                {label}
                {required ? <span className="text-blood"> *</span> : null}
            </span>
            <div className="flex-1 border border-line bg-ink px-3 py-2 text-[13px] text-fg-mute">{note}</div>
        </div>
    );
}

function Check({
    checked,
    onChange,
    strong,
    children,
}: {
    checked: boolean;
    onChange: () => void;
    strong?: boolean;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            onClick={onChange}
            className="flex w-full items-center gap-2.5 text-left"
            aria-pressed={checked}
        >
            <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center border ${
                    checked ? 'border-blood bg-blood text-white' : 'border-line-2 text-transparent'
                }`}
            >
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="3">
                    <path d="M5 12l5 5 9-11" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            </span>
            <span className={`text-[13px] ${strong ? 'font-bold text-fg' : 'text-fg-dim'}`}>{children}</span>
        </button>
    );
}

export default function SignupPage() {
    const [terms, setTerms] = useState(false);
    const [privacy, setPrivacy] = useState(false);
    const [mkt, setMkt] = useState(false);

    const allRequired = terms && privacy;
    const all = terms && privacy && mkt;
    const toggleAll = () => {
        const v = !all;
        setTerms(v);
        setPrivacy(v);
        setMkt(v);
    };

    return (
        <div className="min-h-dvh">
            <TopBar />
            <main className="mx-auto max-w-[440px] px-5 py-10">
                {/* header */}
                <div className="text-center">
                    <div className="mb-5 flex justify-center">
                        <div className="flex h-16 w-16 items-center justify-center border border-line bg-ink-2">
                            <BrandMark size={30} className="text-blood" />
                        </div>
                    </div>
                    <Eyebrow className="justify-center">회원가입</Eyebrow>
                    <h1 className="mt-4 text-[22px] font-extrabold tracking-tight text-fg">위장여사친 판독기 회원가입</h1>
                    <p className="mt-2 text-[13px] text-fg-dim">카카오·구글 계정으로 3초 만에 가입하세요.</p>
                </div>

                {/* 필수 회원정보 */}
                <CaseCard className="mt-7 p-5">
                    <div className="flex items-center justify-between">
                        <span className="eyebrow">필수 회원정보</span>
                        <span className="text-[11px] text-blood">* 필수</span>
                    </div>
                    <div className="mt-2 divide-y divide-line">
                        <FieldRow label="이름" required note="카카오·구글 계정에서 제공" />
                        <FieldRow label="연락처" required note="카카오계정(전화번호)" />
                        <FieldRow label="이메일" required note="카카오·구글 계정에서 제공" />
                    </div>
                </CaseCard>

                {/* 선택 회원정보 */}
                <CaseCard className="mt-3 p-5">
                    <span className="eyebrow">선택 회원정보</span>
                    <div className="mt-2 divide-y divide-line">
                        <FieldRow label="성별" note="카카오 계정에서 제공 (선택)" />
                        <FieldRow label="출생 연도" note="카카오 계정에서 제공 (선택)" />
                    </div>
                </CaseCard>

                {/* 약관 동의 */}
                <div className="mt-5 border border-line bg-ink-2 p-4">
                    <Check checked={all} onChange={toggleAll} strong>
                        약관 전체 동의
                    </Check>
                    <div className="mt-3 space-y-3 border-t border-line pt-3">
                        <Check checked={terms} onChange={() => setTerms(!terms)}>
                            <span className="text-blood">(필수)</span>{' '}
                            <Link href="/terms" className="underline underline-offset-2 hover:text-fg">
                                이용약관
                            </Link>{' '}
                            동의
                        </Check>
                        <Check checked={privacy} onChange={() => setPrivacy(!privacy)}>
                            <span className="text-blood">(필수)</span>{' '}
                            <Link href="/privacy" className="underline underline-offset-2 hover:text-fg">
                                개인정보처리방침
                            </Link>{' '}
                            동의
                        </Check>
                        <Check checked={mkt} onChange={() => setMkt(!mkt)}>
                            (선택) 마케팅 정보 수신 동의
                        </Check>
                    </div>
                </div>

                {/* 가입 버튼 */}
                <div className="mt-5">
                    <AuthButtons redirectTo="/analyze" disabled={!allRequired} label="signup" />
                    {!allRequired && (
                        <p className="mt-2.5 text-center text-[12px] text-fg-mute">
                            필수 약관에 동의하면 가입할 수 있어요.
                        </p>
                    )}
                </div>

                <p className="mt-6 text-center text-[12px] text-fg-mute">
                    이미 회원이신가요?{' '}
                    <Link href="/login" className="text-fg-dim underline underline-offset-2 hover:text-fg">
                        로그인
                    </Link>
                </p>
            </main>
        </div>
    );
}
