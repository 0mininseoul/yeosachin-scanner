'use client';

import { useState } from 'react';

export function AccountDeletionPanel() {
    const [open, setOpen] = useState(false);
    const [confirmation, setConfirmation] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState(false);

    async function submit() {
        if (confirmation !== '탈퇴' || submitting) return;
        setSubmitting(true);
        setError(false);
        try {
            const response = await fetch('/api/account/delete', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ confirmation }),
            });
            if (!response.ok) throw new Error('account deletion failed');
            window.location.assign('/?account_deleted=1');
        } catch {
            setError(true);
            setSubmitting(false);
        }
    }

    return (
        <section className="mt-14 border-t border-line py-8" aria-labelledby="account-management-title">
            <h2 id="account-management-title" className="text-[14px] font-bold text-fg">계정 관리</h2>
            <p className="mt-2 text-[12px] leading-relaxed text-fg-mute">
                탈퇴하면 분석 결과와 공유 링크가 즉시 영구 삭제됩니다.
            </p>
            {!open ? (
                <button
                    type="button"
                    className="mt-4 border border-blood/70 px-4 py-2 text-[12px] font-semibold text-blood"
                    onClick={() => setOpen(true)}
                >
                    탈퇴하기
                </button>
            ) : (
                <div className="mt-4 border border-blood/50 bg-blood/10 p-4">
                    <p className="text-[13px] font-bold text-fg">삭제된 분석 결과와 공유 링크는 복구할 수 없습니다.</p>
                    <p className="mt-2 text-[12px] leading-relaxed text-fg-dim">
                        결제·환불 대응에 필요한 주문 원장은 개인 식별 정보를 제거한 뒤 보존합니다. 계속하려면 아래에 <strong>탈퇴</strong>를 입력하세요.
                    </p>
                    <input
                        value={confirmation}
                        onChange={(event) => setConfirmation(event.target.value)}
                        aria-label="탈퇴 확인 문구"
                        autoComplete="off"
                        className="mt-4 w-full border border-line bg-ink-2 px-3 py-2 text-[13px] text-fg focus:border-blood focus:outline-none"
                        placeholder="탈퇴"
                    />
                    {error && (
                        <p role="alert" className="mt-3 text-[12px] text-blood">
                            탈퇴 처리 중 오류가 발생했습니다. 다시 시도해 주세요.
                        </p>
                    )}
                    <div className="mt-4 flex gap-2">
                        <button
                            type="button"
                            className="border border-line px-4 py-2 text-[12px] font-semibold text-fg-dim"
                            disabled={submitting}
                            onClick={() => { setOpen(false); setConfirmation(''); setError(false); }}
                        >
                            취소
                        </button>
                        <button
                            type="button"
                            className="bg-blood px-4 py-2 text-[12px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-40"
                            disabled={confirmation !== '탈퇴' || submitting}
                            onClick={submit}
                        >
                            {submitting ? '삭제 중…' : '영구 삭제하고 탈퇴'}
                        </button>
                    </div>
                </div>
            )}
        </section>
    );
}
