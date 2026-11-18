'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CaseCard, Eyebrow, PrimaryButton, TopBar } from '@/components/case-ui';
import { preflightAcceptedV1Schema, preflightStatusV1Schema, type PreflightStatusV1 } from '@/lib/contracts/analysis-v2';

const selector = 'devAnalysis=live';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function call(path: string, method: string, body: object, signal?: AbortSignal, attemptId?: string) {
    const response = await fetch(`${path}?${selector}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(attemptId ? { 'x-dev-live-attempt-id': attemptId } : {}) },
        body: JSON.stringify(body),
        cache: 'no-store',
        signal,
    });
    const payload = await response.json();
    if (!response.ok) {
        throw new Error(typeof payload.error === 'string' ? payload.error : '요청을 처리하지 못했습니다.');
    }
    return payload;
}

export function DevLiveAnalysis({ initialPreflightId }: { initialPreflightId: string }) {
    const router = useRouter();
    const [available, setAvailable] = useState<boolean | null>(null);
    const [recentPreflightId, setRecentPreflightId] = useState('');
    const [target, setTarget] = useState('');
    const [preflightId, setPreflightId] = useState(uuid.test(initialPreflightId) ? initialPreflightId : '');
    useEffect(() => {
        if (uuid.test(initialPreflightId)) setPreflightId(initialPreflightId);
    }, [initialPreflightId]);
    const [preflight, setPreflight] = useState<PreflightStatusV1 | null>(null);
    const [excluded, setExcluded] = useState('');
    const [confirmed, setConfirmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [admissionPending, setAdmissionPending] = useState(false);
    const [error, setError] = useState('');
    const [readRevision, setReadRevision] = useState(0);
    const busyRef = useRef(false);
    const startAttempt = useRef<{ target: string; id: string } | null>(null);

    useEffect(() => {
        const controller = new AbortController();
        void fetch('/api/dev-ui/live/availability', { cache: 'no-store', signal: controller.signal })
            .then(async response => response.ok ? await response.json() : {})
            .then(payload => {
                if (controller.signal.aborted) return;
                setAvailable(payload.available === true);
                if (typeof payload.recentPreflightId === 'string' && uuid.test(payload.recentPreflightId)) {
                    setRecentPreflightId(payload.recentPreflightId);
                }
            })
            .catch(() => { if (!controller.signal.aborted) setAvailable(false); });
        return () => controller.abort();
    }, []);

    useEffect(() => {
        if (!preflightId) return;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        async function refresh() {
            try {
                const response = await fetch(`/api/analysis/preflight/${preflightId}?${selector}`, {
                    cache: 'no-store', signal: controller.signal,
                });
                const payload = await response.json();
                if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : '사전 점검을 조회하지 못했습니다.');
                const status = preflightStatusV1Schema.parse(payload);
                if (controller.signal.aborted) return;
                setPreflight(status);
                if (status.status === 'consumed') router.replace(`/progress/${status.requestId}?${selector}`);
                else if (admissionPending && status.status === 'ready') {
                    const admission = await call(`/api/analysis/preflight/${preflightId}/entitle`, 'POST', { planId: 'basic' }, controller.signal);
                    if (controller.signal.aborted) return;
                    if (typeof admission.requestId === 'string' && uuid.test(admission.requestId)) {
                        router.replace(`/progress/${admission.requestId}?${selector}`);
                    } else if (admission.status === 'admission_pending') timer = setTimeout(refresh, 2_000);
                    else throw new Error('실제 분석 요청의 상태를 확인하지 못했습니다.');
                } else if (status.status === 'pending') timer = setTimeout(refresh, 2_000);
            } catch (cause) {
                if (!controller.signal.aborted) {
                    setError(cause instanceof Error ? cause.message : '사전 점검을 조회하지 못했습니다.');
                    setAdmissionPending(false);
                }
            }
        }
        void refresh();
        return () => {
            controller.abort();
            clearTimeout(timer);
        };
    }, [admissionPending, preflightId, readRevision, router]);

    async function submit(work: () => Promise<void>) {
        if (available !== true || busyRef.current) return;
        busyRef.current = true;
        setBusy(true);
        setError('');
        try { await work(); }
        catch (cause) { setError(cause instanceof Error ? cause.message : '요청을 처리하지 못했습니다.'); }
        finally {
            busyRef.current = false;
            setBusy(false);
        }
    }

    function start(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        if (!confirmed) return;
        void submit(async () => {
            const targetInstagramId = target.trim().toLowerCase();
            if (startAttempt.current?.target !== targetInstagramId) {
                startAttempt.current = { target: targetInstagramId, id: crypto.randomUUID() };
            }
            const accepted = preflightAcceptedV1Schema.parse(await call('/api/analysis/preflight', 'POST', {
                targetInstagramId,
            }, undefined, startAttempt.current.id));
            startAttempt.current = null;
            setPreflightId(accepted.preflightId);
            router.replace(`/dev-ui/live?preflight=${accepted.preflightId}`);
        });
    }

    function confirmExclusion() {
        void submit(async () => {
            const excludedInstagramId = excluded.trim().toLowerCase();
            const result = await call(`/api/analysis/preflight/${preflightId}`, 'PATCH', excludedInstagramId
                ? { decision: 'exclude', excludedInstagramId } : { decision: 'skip' });
            setPreflight(preflightStatusV1Schema.parse(result));
        });
    }

    function beginAnalysis() {
        void submit(async () => {
            const result = await call(`/api/analysis/preflight/${preflightId}/entitle`, 'POST', { planId: 'basic' });
            if (typeof result.requestId === 'string' && uuid.test(result.requestId)) {
                router.replace(`/progress/${result.requestId}?${selector}`);
            } else if (result.status === 'admission_pending') {
                setAdmissionPending(true);
            } else {
                throw new Error('실제 분석 요청의 상태를 확인하지 못했습니다.');
            }
        });
    }

    const basicIsAvailable = preflight?.status === 'ready'
        && preflight.plans.some(plan => plan.planId === 'basic' && plan.selectionState !== 'unavailable');

    return <>
        <TopBar />
        <main className="mx-auto max-w-[560px] px-5 py-8">
            <Eyebrow>Dev · 실제 공급자</Eyebrow>
            <h1 className="mt-3 text-[26px] font-extrabold">실제 분석 · 카드 결제 없음</h1>
            <p className="mt-2 text-sm text-fg-dim">공개 테스트 계정을 Basic으로 판독합니다. 사전 점검부터 1회 최대 $7의 분석 예산을 사용합니다.</p>
            <CaseCard className="mt-5 space-y-4 p-5">
                {available === null && <p role="status">실제 분석을 준비하고 있습니다.</p>}
                {available === false && <p role="status">실제 분석 설정을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.</p>}
                {preflightId && <a href="/dev-ui/live" className="block text-sm underline">새 실제 분석</a>}
                {!preflightId && recentPreflightId && <Link href={`/dev-ui/live?preflight=${recentPreflightId}`} className="block text-sm underline">최근 실제 분석 다시 열기</Link>}
                {!preflightId && available === true && <form onSubmit={start} className="space-y-4">
                    <label className="block text-sm" htmlFor="dev-live-target">대상 인스타그램 아이디</label>
                    <input id="dev-live-target" className="w-full border border-line bg-ink p-3" value={target} onChange={event => setTarget(event.target.value)} maxLength={30} required />
                    <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> 실제 사전 점검에서 분석 예산을 사용합니다.</label>
                    <PrimaryButton type="submit" disabled={busy || !confirmed || !target.trim()}>실제 사전 점검 시작</PrimaryButton>
                </form>}
                {preflightId && (!preflight || preflight.status === 'pending') && !error && <p role="status">실제 사전 점검이 진행 중입니다.</p>}
                {preflight?.status === 'blocked' && <p role="alert">이 계정의 사전 점검을 완료할 수 없습니다. ({preflight.code})</p>}
                {preflight?.status === 'ready' && <>
                    <p>사전 점검 완료 · 팔로워 {preflight.target.followersCount} · 팔로잉 {preflight.target.followingCount}</p>
                    {preflight.exclusionDecision === 'pending' ? <>
                        <label className="block text-sm" htmlFor="dev-live-exclusion">제외할 계정 (선택)</label>
                        <input id="dev-live-exclusion" className="w-full border border-line bg-ink p-3" value={excluded} onChange={event => setExcluded(event.target.value)} maxLength={30} />
                        <PrimaryButton onClick={confirmExclusion} disabled={busy || available !== true}>{excluded.trim() ? '이 계정 제외' : '제외 없이 계속'}</PrimaryButton>
                    </> : <>
                        {admissionPending && <p role="status">최신 계정 정보를 확인하고 분석 작업을 준비하고 있습니다.</p>}
                        {basicIsAvailable ? <PrimaryButton onClick={beginAnalysis} disabled={busy || admissionPending || available !== true}>
                            {admissionPending ? '분석 시작 상태 다시 확인' : 'Basic 분석 시작 · 카드 결제 없음'}
                        </PrimaryButton> : <p>현재 계정은 이번 Basic 실행 범위에 해당하지 않습니다.</p>}
                    </>}
                </>}
                {error && <p role="alert" className="text-sm text-blood-2">{error}</p>}
                {error && preflightId && <button type="button" className="text-sm underline" onClick={() => {
                    setError('');
                    setReadRevision(value => value + 1);
                }}>상태 다시 확인</button>}
            </CaseCard>
            <Link href="/analyze" className="mt-6 inline-block underline">모의 분석으로 돌아가기</Link>
        </main>
    </>;
}
