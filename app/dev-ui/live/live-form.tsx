'use client';

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CaseCard, Eyebrow, PrimaryButton, TopBar } from '@/components/case-ui';
import { preflightAcceptedV1Schema, preflightStatusV1Schema, type PreflightStatusV1 } from '@/lib/contracts/analysis-v2';

const selector = 'devAnalysis=live';
const planHeader = 'x-dev-live-plan';
const ownerAttemptStoragePrefix = 'dev-live-attempt:';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type LivePlanId = 'basic' | 'standard';
type PendingAdmission = { preflightId: string; planId: LivePlanId };

function isPlanAvailable(status: PreflightStatusV1, planId: LivePlanId) {
    return status.status === 'ready'
        && status.plans.some(plan => plan.planId === planId && plan.selectionState !== 'unavailable');
}

class DevLiveRequestError extends Error {
    constructor(message: string, readonly code: string | undefined, readonly status: number) {
        super(message);
    }
}

async function call(
    path: string, method: string, body: object, signal?: AbortSignal,
    ownerStart?: { attemptId: string; planId: LivePlanId },
) {
    const response = await fetch(`${path}?${selector}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(ownerStart && { 'x-dev-live-attempt-id': ownerStart.attemptId, [planHeader]: ownerStart.planId }),
        },
        body: JSON.stringify(body),
        cache: 'no-store',
        signal,
    });
    const payload = await response.json();
    if (!response.ok) {
        throw new DevLiveRequestError(
            typeof payload.error === 'string' ? payload.error : '요청을 처리하지 못했습니다.',
            typeof payload.code === 'string' ? payload.code : undefined,
            response.status,
        );
    }
    return payload;
}

export function DevLiveAnalysis({ initialPreflightId }: { initialPreflightId: string }) {
    const router = useRouter();
    const [available, setAvailable] = useState<boolean | null>(null);
    const [recentPreflightId, setRecentPreflightId] = useState('');
    const [standard, setStandard] = useState<{ target: string; available: boolean } | null>(null);
    const [target, setTarget] = useState('');
    const routePreflightId = uuid.test(initialPreflightId) ? initialPreflightId.toLowerCase() : '';
    const [acceptedPreflightId, setAcceptedPreflightId] = useState('');
    const preflightId = routePreflightId || acceptedPreflightId;
    useEffect(() => {
        if (routePreflightId) setAcceptedPreflightId('');
    }, [routePreflightId]);
    const [snapshot, setSnapshot] = useState<{ status: PreflightStatusV1; planId: LivePlanId } | null>(null);
    const [excluded, setExcluded] = useState('');
    const [confirmed, setConfirmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [pendingAdmission, setPendingAdmission] = useState<PendingAdmission | null>(null);
    const [error, setError] = useState('');
    const [readRevision, setReadRevision] = useState(0);
    const busyRef = useRef(false);
    const preflightController = useRef<AbortController | null>(null);
    const activeAdmission = pendingAdmission?.preflightId === preflightId ? pendingAdmission : null;
    const current = snapshot?.status.preflightId.toLowerCase() === preflightId ? snapshot : null;
    const preflight = current?.status;
    const targetInstagramId = target.trim().toLowerCase();
    const standardTarget = standard?.target ?? null;
    const startPlanId = targetInstagramId === standardTarget ? 'standard' : 'basic';
    const canStartPlan = startPlanId === 'basic' || standard?.available === true;
    const displayedPlanId = preflightId ? current?.planId : canStartPlan ? startPlanId : undefined;
    const displayedPlan = displayedPlanId === 'standard' ? 'Standard' : 'Basic';

    useLayoutEffect(() => {
        setPendingAdmission(pending => pending?.preflightId === preflightId ? pending : null);
        // Abort the previous preflight at navigation commit, before a queued poll can resume it.
        return () => preflightController.current?.abort();
    }, [preflightId]);

    useEffect(() => {
        const controller = new AbortController();
        void fetch('/api/dev-ui/live/availability', { cache: 'no-store', signal: controller.signal })
            .then(async response => response.ok ? await response.json() : {})
            .then(payload => {
                if (controller.signal.aborted) return;
                setAvailable(payload.available === true);
                if (payload.available === true && typeof payload.standardTarget === 'string' && payload.standardTarget.trim()) {
                    setStandard({ target: payload.standardTarget.trim().toLowerCase(), available: payload.standardAvailable === true });
                }
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
        preflightController.current = controller;
        let timer: ReturnType<typeof setTimeout> | undefined;
        async function refresh() {
            try {
                const response = await fetch(`/api/analysis/preflight/${preflightId}?${selector}`, {
                    cache: 'no-store', signal: controller.signal,
                });
                const payload = await response.json();
                if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : '사전 점검을 조회하지 못했습니다.');
                const status = preflightStatusV1Schema.parse(payload);
                if (status.preflightId.toLowerCase() !== preflightId) throw new Error('조회한 사전 점검이 현재 실행과 일치하지 않습니다.');
                const reportedPlan = response.headers.get(planHeader);
                const planId = reportedPlan ?? 'basic';
                if (planId !== 'basic' && planId !== 'standard') throw new Error('사전 점검의 분석 플랜을 확인하지 못했습니다.');
                if (controller.signal.aborted) return;
                setSnapshot({ status, planId });
                if (status.status === 'consumed') router.replace(`/progress/${status.requestId}?${selector}`);
                else if (activeAdmission && status.status === 'ready') {
                    if (reportedPlan !== activeAdmission.planId || status.exclusionDecision === 'pending' || !isPlanAvailable(status, planId)) {
                        setPendingAdmission(null);
                        return;
                    }
                    const admission = await call(`/api/analysis/preflight/${preflightId}/entitle`, 'POST', { planId }, controller.signal);
                    if (controller.signal.aborted) return;
                    if (typeof admission.requestId === 'string' && uuid.test(admission.requestId)) {
                        router.replace(`/progress/${admission.requestId}?${selector}`);
                    } else if (admission.status === 'admission_pending') timer = setTimeout(refresh, 2_000);
                    else throw new Error('실제 분석 요청의 상태를 확인하지 못했습니다.');
                } else if (status.status === 'pending') timer = setTimeout(refresh, 2_000);
            } catch (cause) {
                if (!controller.signal.aborted) {
                    setError(cause instanceof Error ? cause.message : '사전 점검을 조회하지 못했습니다.');
                    setPendingAdmission(null);
                }
            }
        }
        void refresh();
        return () => {
            controller.abort();
            clearTimeout(timer);
        };
    }, [activeAdmission, preflightId, readRevision, router]);

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
        if (!confirmed || !canStartPlan || !targetInstagramId) return;
        void submit(async () => {
            const attemptScope = startPlanId === 'standard' ? 'standard:' : '';
            const storageKey = ownerAttemptStoragePrefix + attemptScope + targetInstagramId;
            const saved = sessionStorage.getItem(storageKey);
            const attemptId = saved && uuid.test(saved) ? saved : crypto.randomUUID();
            sessionStorage.setItem(storageKey, attemptId);
            try {
                const accepted = preflightAcceptedV1Schema.parse(await call('/api/analysis/preflight', 'POST', {
                    targetInstagramId,
                }, undefined, { attemptId, planId: startPlanId }));
                sessionStorage.removeItem(storageKey);
                setAcceptedPreflightId(accepted.preflightId.toLowerCase());
                router.replace(`/dev-ui/live?preflight=${accepted.preflightId}`);
            } catch (cause) {
                if (cause instanceof DevLiveRequestError && (cause.code === 'DEV_LIVE_START_ATTEMPT_EXPIRED'
                    || (cause.status === 410 && cause.code === 'PREFLIGHT_EXPIRED')
                    || (cause.status === 409 && cause.code === 'PREFLIGHT_CONSUMED'))) {
                    sessionStorage.removeItem(storageKey);
                }
                throw cause;
            }
        });
    }

    function confirmExclusion() {
        void submit(async () => {
            const excludedInstagramId = excluded.trim().toLowerCase();
            const result = await call(`/api/analysis/preflight/${preflightId}`, 'PATCH', excludedInstagramId
                ? { decision: 'exclude', excludedInstagramId } : { decision: 'skip' });
            const status = preflightStatusV1Schema.parse(result);
            setSnapshot(previous => previous?.status.preflightId === status.preflightId ? { ...previous, status } : previous);
        });
    }

    function beginAnalysis() {
        const signal = preflightController.current?.signal;
        if (!signal || signal.aborted || !current || activeAdmission || !isPlanAvailable(current.status, current.planId)) return;
        void submit(async () => {
            const { planId } = current;
            const result = await call(`/api/analysis/preflight/${preflightId}/entitle`, 'POST', { planId }, signal)
                .catch(cause => {
                    if (!signal.aborted) throw cause;
                });
            if (signal.aborted) return;
            if (typeof result.requestId === 'string' && uuid.test(result.requestId)) {
                router.replace(`/progress/${result.requestId}?${selector}`);
            } else if (result.status === 'admission_pending') {
                setPendingAdmission({ preflightId, planId });
            } else {
                throw new Error('실제 분석 요청의 상태를 확인하지 못했습니다.');
            }
        });
    }

    return <>
        <TopBar />
        <main className="mx-auto max-w-[560px] px-5 py-8">
            <Eyebrow>Dev · 실제 공급자</Eyebrow>
            <h1 className="mt-3 text-[26px] font-extrabold">실제 분석 · 카드 결제 없음</h1>
            {displayedPlanId && <p className="mt-2 text-sm text-fg-dim">{displayedPlanId === 'standard'
                ? '공개 테스트 계정을 Standard로 판독합니다. 사전 점검부터 분석 1회에 Apify 최대 $6, Vertex 최대 $4로 총 $10까지 사용합니다.'
                : '공개 테스트 계정을 Basic으로 판독합니다. 사전 점검부터 1회 최대 $7의 분석 예산을 사용합니다.'}</p>}
            <CaseCard className="mt-5 space-y-4 p-5">
                {available === null && <p role="status">실제 분석을 준비하고 있습니다.</p>}
                {available === false && <p role="status">실제 분석 설정을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.</p>}
                {preflightId && <a href="/dev-ui/live" className="block text-sm underline">새 실제 분석</a>}
                {!preflightId && recentPreflightId && <Link href={`/dev-ui/live?preflight=${recentPreflightId}`} className="block text-sm underline">최근 실제 분석 다시 열기</Link>}
                {!preflightId && available === true && <form onSubmit={start} className="space-y-4">
                    <label className="block text-sm" htmlFor="dev-live-target">대상 인스타그램 아이디</label>
                    <input id="dev-live-target" className="w-full border border-line bg-ink p-3" value={target} onChange={event => {
                        const value = event.target.value;
                        if ((value.trim().toLowerCase() === standardTarget) !== (startPlanId === 'standard')) setConfirmed(false);
                        setTarget(value);
                    }} maxLength={30} required />
                    {standardTarget && <p className="text-sm text-fg-dim">Standard 대상은 @{standardTarget}입니다.</p>}
                    {!canStartPlan && <p role="status">현재 Standard 사전 점검을 시작할 수 없습니다. 잠시 후 다시 시도해 주세요.</p>}
                    <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> 실제 사전 점검에서 분석 예산을 사용합니다.</label>
                    <PrimaryButton type="submit" disabled={busy || !confirmed || !canStartPlan || !targetInstagramId}>실제 사전 점검 시작</PrimaryButton>
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
                        {activeAdmission && <p role="status">최신 계정 정보를 확인하고 분석 작업을 준비하고 있습니다.</p>}
                        {current && isPlanAvailable(preflight, current.planId) ? <PrimaryButton onClick={beginAnalysis} disabled={busy || !!activeAdmission || available !== true}>
                            {activeAdmission ? '분석 시작 상태 다시 확인' : `${displayedPlan} 분석 시작 · 카드 결제 없음`}
                        </PrimaryButton> : <p>현재 계정은 이번 {displayedPlan} 실행 범위에 해당하지 않습니다.</p>}
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
