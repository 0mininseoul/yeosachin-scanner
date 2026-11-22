'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

async function post(url: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
    return { status: response.status, data: await response.json().catch(() => ({})) as Record<string, unknown> };
}

type Action = 'cancel' | 'resume' | 'cancel_preparing';
const CONFIRM: Record<Action, string | null> = {
    cancel: '해지하면 다음 결제가 없고, 남은 기간까지 이용할 수 있어요. 해지할까요?',
    resume: null,
    cancel_preparing: '준비를 멈추고 결제한 금액 전액을 환불받을까요?',
};

export function CherryActionButton({ action, label, quiet = true }: { action: Action; label: string; quiet?: boolean }) {
    const router = useRouter();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    async function run() {
        const question = CONFIRM[action];
        if (busy || (question && !window.confirm(question))) return;
        setBusy(true);
        setError(null);
        try {
            const { data } = await post('/api/cherry/subscription', { action });
            if (data.outcome === 'done') router.refresh();
            else setError('지금은 처리할 수 없어요. 화면을 새로고침한 뒤 다시 시도해 주세요.');
        } catch {
            setError('인터넷 연결을 확인하고 다시 시도해 주세요.');
        }
        setBusy(false);
    }
    return <div>
        <button type="button" className={quiet ? 'ch-text-button' : 'ch-button ch-button--quiet'} disabled={busy} onClick={run}>{busy ? '처리 중' : label}</button>
        {error ? <p className="ch-error" role="alert">{error}</p> : null}
    </div>;
}

export function CherryRenewButton({ label }: { label: string }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    async function run() {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            const { data } = await post('/api/cherry/renew', {});
            if (data.outcome === 'ready' && typeof data.redirectUrl === 'string') return window.location.assign(data.redirectUrl);
            setError('지금은 연장 결제를 시작할 수 없어요. 잠시 뒤 다시 시도해 주세요.');
        } catch {
            setError('인터넷 연결을 확인하고 다시 시도해 주세요.');
        }
        setBusy(false);
    }
    return <div style={{ width: '100%' }}>
        <button type="button" className="ch-button" disabled={busy} onClick={run}>{busy ? '결제창을 여는 중' : label}</button>
        {error ? <p className="ch-error" role="alert" style={{ marginTop: 10 }}>{error}</p> : null}
    </div>;
}
