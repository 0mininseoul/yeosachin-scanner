'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CaseCard, Eyebrow, Panel, PrimaryButton, TopBar } from '@/components/case-ui';
import { InstagramLookupLink } from '@/components/instagram-lookup-link';
import { AnalysisPlanCards, AnalysisPlanSection } from '@/components/analysis-plan-selection';
import {
    AnalysisExclusionPanel,
    AnalysisInstagramInput,
    AnalysisPreflightHeading,
    AnalysisTargetCard,
    AnalysisTargetHeading,
} from '@/components/analysis-preflight-presentation';
import { PrecheckoutImmersive } from '@/components/precheckout-immersive';
import { PreflightPendingStatus } from '@/components/preflight-pending-status';
import { normalizeInstagramUsername } from '@/lib/services/analysis/v2-client-credentials';
import { preflightAcceptedV1Schema, preflightStatusV1Schema, type PreflightStatusV1 } from '@/lib/contracts/analysis-v2';

const selector = 'devAnalysis=live';
const planHeader = 'x-dev-live-plan';
const ownerAttemptStoragePrefix = 'dev-live-attempt:';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const defaultRetryDelayMs = 2_000;
type LivePlanId = 'basic' | 'standard';
type Admission = { preflightId: string; planId: LivePlanId; retryAfterMs?: number };

function admissionRetryDelay(value: unknown) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 250 && value <= 30_000) return value;
    return defaultRetryDelayMs;
}

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
    if (response.status === 204 && method === 'PATCH') return null;
    const payload = await response.json();
    if (!response.ok) {
        throw new DevLiveRequestError(
            typeof payload?.error === 'string' ? payload.error : '요청을 처리하지 못했습니다.',
            typeof payload?.code === 'string' ? payload.code : undefined,
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
    const [savedExclusionId, setSavedExclusionId] = useState('');
    const [planViewId, setPlanViewId] = useState('');
    const [bliteResultId, setBliteResultId] = useState('');
    const [launched, setLaunched] = useState<{ id: string; target: string; at: number } | null>(null);
    const [confirmed, setConfirmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [admission, setAdmission] = useState<Admission | null>(null);
    const [error, setError] = useState('');
    const [readRevision, setReadRevision] = useState(0);
    const busyRef = useRef(false);
    const preflightController = useRef<AbortController | null>(null);
    const activeAdmission = admission?.preflightId === preflightId ? admission : null;
    const preparing = !!activeAdmission;
    const pendingAdmission = activeAdmission?.retryAfterMs !== undefined ? activeAdmission : null;
    const current = snapshot?.status.preflightId.toLowerCase() === preflightId ? snapshot : null;
    const preflight = current?.status;
    const targetInstagramId = normalizeInstagramUsername(target);
    const readyPreflight = preflight?.status === 'ready' ? preflight : null;
    const exclusionDecided = !!preflight && (preflight.exclusionDecision !== 'pending' || savedExclusionId === preflightId);
    const plansVisible = !!preflightId && planViewId === preflightId;
    const launchedPreflight = launched?.id === preflightId ? launched : null;
    const displayTarget = readyPreflight?.target.username ?? launchedPreflight?.target ?? null;
    const standardTarget = standard?.target ?? null;
    const startPlanId = targetInstagramId && targetInstagramId === standardTarget ? 'standard' : 'basic';
    const canStartPlan = startPlanId === 'basic' || standard?.available === true;
    const displayedPlanId = preflightId ? current?.planId : canStartPlan ? startPlanId : undefined;
    const displayedPlan = displayedPlanId === 'standard' ? 'Standard' : 'Basic';
    const approvedPlanAvailable = !!readyPreflight && !!current && isPlanAvailable(readyPreflight, current.planId);
    const showExclusion = !preparing && !!preflight && (preflight.status === 'pending' || preflight.status === 'ready') && !exclusionDecided;
    const showImmersive = !preparing && !!preflight && (preflight.status === 'pending' || preflight.status === 'ready')
        && exclusionDecided && !plansVisible;
    const goToPlans = useCallback(() => {
        setPlanViewId(preflightId);
        setBliteResultId('');
    }, [preflightId]);
    useEffect(() => {
        if (!plansVisible) return;
        const frame = requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: 'auto' }));
        return () => cancelAnimationFrame(frame);
    }, [plansVisible, preparing]);
    const markBliteShown = useCallback(() => setBliteResultId(preflightId), [preflightId]);

    useLayoutEffect(() => {
        setAdmission(previous => previous?.preflightId === preflightId ? previous : null);
        setSavedExclusionId(id => id === preflightId ? id : '');
        setPlanViewId(id => id === preflightId ? id : '');
        setBliteResultId(id => id === preflightId ? id : '');
        setExcluded('');
        setError('');
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
            if (controller.signal.aborted) return;
            try {
                const response = await fetch(`/api/analysis/preflight/${preflightId}?${selector}`, {
                    cache: 'no-store', signal: controller.signal,
                });
                const payload = await response.json();
                if (controller.signal.aborted) return;
                if (!response.ok) {
                    if (response.status === 410) setSnapshot(null);
                    throw new Error(typeof payload?.error === 'string' ? payload.error : '사전 점검을 조회하지 못했습니다.');
                }
                const parsed = preflightStatusV1Schema.safeParse(payload);
                if (!parsed.success) throw new Error('사전 점검 상태를 확인하지 못했습니다.');
                const status = parsed.data;
                if (status.preflightId.toLowerCase() !== preflightId) throw new Error('조회한 사전 점검이 현재 실행과 일치하지 않습니다.');
                const planId = response.headers.get(planHeader);
                if (planId !== 'basic' && planId !== 'standard') throw new Error('사전 점검의 분석 플랜을 확인하지 못했습니다.');
                setSnapshot({ status, planId });
                if (status.status === 'consumed') router.replace(`/progress/${status.requestId}?${selector}`);
                else if (pendingAdmission) {
                    if (status.status === 'blocked') {
                        setAdmission(null);
                        return;
                    }
                    if (status.status !== 'ready' || planId !== pendingAdmission.planId
                        || status.exclusionDecision === 'pending' || !isPlanAvailable(status, planId)) {
                        throw new Error('사전 점검이 변경되었습니다. 현재 계정과 플랜을 다시 확인해 주세요.');
                    }
                    const result = await call(`/api/analysis/preflight/${preflightId}/entitle`, 'POST', { planId }, controller.signal);
                    if (controller.signal.aborted) return;
                    if (typeof result?.requestId === 'string' && uuid.test(result.requestId)) {
                        router.replace(`/progress/${result.requestId}?${selector}`);
                    } else if (result?.status === 'admission_pending') timer = setTimeout(refresh, admissionRetryDelay(result.retryAfterMs));
                    else throw new Error('실제 분석 요청의 상태를 확인하지 못했습니다.');
                } else if (status.status === 'pending') timer = setTimeout(refresh, defaultRetryDelayMs);
            } catch (cause) {
                if (!controller.signal.aborted) {
                    if (cause instanceof DevLiveRequestError && cause.status === 410) setSnapshot(null);
                    setError(cause instanceof Error ? cause.message : '사전 점검을 조회하지 못했습니다.');
                    setAdmission(null);
                }
            }
        }
        if (pendingAdmission) timer = setTimeout(refresh, pendingAdmission.retryAfterMs);
        else void refresh();
        return () => {
            controller.abort();
            clearTimeout(timer);
        };
    }, [pendingAdmission, preflightId, readRevision, router]);

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
                const id = accepted.preflightId.toLowerCase();
                setLaunched({ id, target: targetInstagramId, at: Date.now() });
                setAcceptedPreflightId(id);
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

    function resetTarget() {
        preflightController.current?.abort();
        setAcceptedPreflightId('');
        setSnapshot(null);
        setLaunched(null);
        setSavedExclusionId('');
        setPlanViewId('');
        setBliteResultId('');
        setTarget('');
        setConfirmed(false);
        setExcluded('');
        setError('');
        router.replace('/dev-ui/live');
    }

    function confirmExclusion(rawUsername?: string) {
        const signal = preflightController.current?.signal;
        if (!signal || signal.aborted || !showExclusion) return;
        const excludedInstagramId = rawUsername === undefined ? null : normalizeInstagramUsername(rawUsername);
        if (rawUsername !== undefined && !excludedInstagramId) {
            setError('본인의 인스타그램 아이디를 확인해주세요.');
            return;
        }
        void submit(async () => {
            await call(`/api/analysis/preflight/${preflightId}`, 'PATCH', excludedInstagramId
                ? { decision: 'exclude', excludedInstagramId } : { decision: 'skip' }, signal)
                .catch(cause => { if (!signal.aborted) throw cause; });
            if (!signal.aborted) setSavedExclusionId(preflightId);
        });
    }

    function beginAnalysis() {
        const signal = preflightController.current?.signal;
        if (!signal || signal.aborted || !plansVisible || !exclusionDecided || !current
            || activeAdmission || !isPlanAvailable(current.status, current.planId)) return;
        void submit(async () => {
            const { planId } = current;
            setAdmission({ preflightId, planId });
            try {
                const result = await call(`/api/analysis/preflight/${preflightId}/entitle`, 'POST', { planId }, signal);
                if (signal.aborted) return;
                if (typeof result?.requestId === 'string' && uuid.test(result.requestId)) {
                    router.replace(`/progress/${result.requestId}?${selector}`);
                } else if (result?.status === 'admission_pending') {
                    setAdmission({ preflightId, planId, retryAfterMs: admissionRetryDelay(result.retryAfterMs) });
                } else {
                    throw new Error('실제 분석 요청의 상태를 확인하지 못했습니다.');
                }
            } catch (cause) {
                if (signal.aborted) return;
                if (cause instanceof DevLiveRequestError && cause.status === 410) setSnapshot(null);
                setAdmission(null);
                throw cause;
            }
        });
    }

    return <div className="min-h-dvh">
        <TopBar />
        <main className="mx-auto max-w-[500px] px-5 pb-16 pt-7">
            <p className="mb-5 border-l-2 border-amber pl-3 text-[13px] text-fg-dim">Dev 실제 분석 · 카드 결제 없음</p>
            {available === null && <p role="status" className="mb-5 text-sm text-fg-dim">실제 분석을 준비하고 있습니다.</p>}
            {available === false && <p role="status" className="mb-5 text-sm text-fg-dim">실제 분석 설정을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.</p>}
            {!preflightId && <>
                <AnalysisTargetHeading />
                {available === true && <Panel className="mt-8 p-5">
                    <form onSubmit={start}>
                        <AnalysisInstagramInput
                            id="dev-live-target"
                            label="대상 인스타그램 아이디"
                            placeholder="username"
                            value={target}
                            onChange={value => {
                                if (normalizeInstagramUsername(value) !== targetInstagramId) setConfirmed(false);
                                setTarget(value);
                                setError('');
                            }}
                        />
                        <InstagramLookupLink />
                        <p className="mt-4 border-l-2 border-amber pl-3 text-[12px] leading-relaxed text-fg-dim">
                            <span className="font-semibold text-amber">공개 계정</span>만 판독 가능합니다.
                        </p>
                        {standardTarget && <p data-amp-mask className="mt-3 text-sm text-fg-dim">Standard 대상은 @{standardTarget}입니다.</p>}
                        {!canStartPlan && <p role="status" className="mt-3 text-sm text-fg-dim">현재 Standard 사전 점검을 시작할 수 없습니다. 잠시 후 다시 시도해 주세요.</p>}
                        {displayedPlanId && <p className="mt-3 text-sm text-fg-dim">{displayedPlanId === 'standard'
                            ? '공개 테스트 계정을 Standard로 판독합니다. 사전 점검부터 분석 1회에 Apify 최대 $6, Vertex 최대 $4로 총 $10까지 사용합니다.'
                            : '공개 테스트 계정을 Basic으로 판독합니다. 사전 점검부터 1회 최대 $7의 분석 예산을 사용합니다.'}</p>}
                        <label className="mt-4 flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> 실제 사전 점검에서 분석 예산을 사용합니다.</label>
                        <div className="mt-5">
                            <PrimaryButton type="submit" disabled={busy || !confirmed || !canStartPlan || !targetInstagramId}>
                                {busy ? '계정 확인 중…' : '실제 사전 점검 시작'}
                            </PrimaryButton>
                        </div>
                    </form>
                </Panel>}
                {recentPreflightId && <Link href={`/dev-ui/live?preflight=${recentPreflightId}`} className="mt-5 block text-sm underline">최근 실제 분석 다시 열기</Link>}
            </>}

            {preflightId && preflight?.status === 'blocked' ? (
                <CaseCard bracket="var(--color-blood)" className="p-7 text-center">
                    <Eyebrow className="justify-center">사전 점검 중단</Eyebrow>
                    <h1 className="mt-4 text-[22px] font-extrabold text-fg">판독 대상을 확인해주세요</h1>
                    <p role="alert" data-amp-mask className="mt-3 text-[13px] leading-relaxed text-fg-dim">
                        현재 이 계정은 판독할 수 없습니다. ({preflight.code})
                    </p>
                    <div className="mt-7">
                        <PrimaryButton type="button" onClick={resetTarget}>다른 계정 확인하기</PrimaryButton>
                    </div>
                </CaseCard>
            ) : preflightId && <>
                <AnalysisPreflightHeading
                    exclusionDecided={preparing || !preflight || exclusionDecided}
                    ready={preparing || !!readyPreflight}
                    bliteResultShown={bliteResultId === preflightId}
                    onChangeTarget={resetTarget}
                />
                {showExclusion && <AnalysisExclusionPanel
                    value={excluded}
                    onChange={value => { setExcluded(value); setError(''); }}
                    onExclude={() => confirmExclusion(excluded)}
                    onSkip={() => confirmExclusion()}
                    saving={busy}
                    disabled={available !== true}
                    error={error}
                />}
                {showImmersive && <PrecheckoutImmersive
                    key={preflightId}
                    preflightId={preflightId}
                    devLive
                    claimToken={null}
                    submittedAtMs={launchedPreflight?.at}
                    targetUsername={displayTarget}
                    onGoToPlans={goToPlans}
                    onRetry={resetTarget}
                    onBliteResultShown={markBliteShown}
                />}
                {!preparing && !readyPreflight && !error && (!preflight || plansVisible) && <PreflightPendingStatus
                    targetInstagramId={displayTarget}
                    startedAt={launchedPreflight?.at ?? null}
                />}
                {preparing && <CaseCard className="mt-7 p-7 text-center">
                    <div role="status" aria-live="polite" aria-atomic="true">
                        <Eyebrow className="justify-center">분석 준비 중</Eyebrow>
                        <h2 className="mt-4 text-[20px] font-extrabold text-fg">최신 계정 정보를 확인하고 있어요</h2>
                        <div className="mt-6 h-1.5 w-full overflow-hidden bg-line" aria-hidden="true">
                            <div className="h-full w-1/3 bg-blood anim-indeterminate" />
                        </div>
                        <p className="mt-5 text-[13px] leading-relaxed text-fg-dim">준비가 끝나면 분석 진행 화면으로 이동합니다.</p>
                    </div>
                </CaseCard>}
                {!preparing && plansVisible && readyPreflight && current && <>
                    <AnalysisTargetCard target={readyPreflight.target} />
                    <AnalysisPlanSection>
                        <AnalysisPlanCards
                            plans={readyPreflight.plans}
                            requiredPlan={readyPreflight.requiredPlan}
                            selectedPlan={current.planId}
                            lockedPlan={current.planId}
                        />
                        <p className="mt-4 text-[11.5px] leading-relaxed text-fg-dim">
                            실제 분석은 이번에 승인된 {displayedPlan} 플랜으로만 진행합니다. 카드 결제는 없습니다.
                        </p>
                        {approvedPlanAvailable ? <div className="mt-5">
                            <PrimaryButton type="button" size="lg" onClick={beginAnalysis} disabled={busy || available !== true}>
                                {`${displayedPlan} 분석 시작 · 카드 결제 없음`}
                            </PrimaryButton>
                        </div> : <p className="mt-5 text-sm text-fg-dim">현재 계정은 이번 {displayedPlan} 실행 범위에 해당하지 않습니다.</p>}
                    </AnalysisPlanSection>
                </>}
            </>}

            {error && !showExclusion && <p role="alert" data-amp-mask className="mt-4 border-l-2 border-blood pl-3 text-[13px] text-blood-2">{error}</p>}
            {error && preflightId && <button type="button" className="mt-4 text-sm underline" onClick={() => {
                setError('');
                setReadRevision(value => value + 1);
            }}>상태 다시 확인</button>}
            <Link href="/analyze" className="mt-6 inline-block text-sm underline">모의 분석으로 돌아가기</Link>
        </main>
    </div>;
}
