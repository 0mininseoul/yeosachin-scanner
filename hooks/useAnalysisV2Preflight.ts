'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
    freshAdmissionErrorResponseV1Schema,
    preflightAcceptedV1Schema,
    preflightStatusV1Schema,
    testEntitlementResponseV1Schema,
    type FreshPlanSnapshotV1,
    type PreflightExclusionDecisionV1,
    type PreflightStatusV1,
} from '@/lib/contracts/analysis-v2';
import type { PlanId } from '@/lib/domain/analysis/plan-catalog';
import {
    getAnalysisStartIdempotency,
    type AnalysisStartIdempotency,
} from '@/lib/services/analysis/client-idempotency';
import {
    consumeTestAdmissionCredential,
    consumeTestEntitlementToken,
    normalizeInstagramUsername,
    readTestAdmissionCredential,
    readTestEntitlementToken,
} from '@/lib/services/analysis/v2-client-credentials';
import {
    availablePendingTargetStorage,
    clearPendingAnalysisTargetForTerminalState,
    clearPreflightDisplayTarget,
    clearPreflightDisplayTargetForTerminalState,
    storePreflightDisplayTarget,
    type PendingTargetStorage,
} from '@/lib/services/pending-analysis-target';
import { EVENTS, trackEvent } from '@/lib/services/analytics';
import {
    availableAnalyticsStorage,
    classifyPreflightAnalyticsOutcome,
    classifyPreflightRequestAnalyticsOutcome,
    persistPreflightStartedAt,
    preflightOutcomeEventKey,
    readPreflightStartedAt,
    relationshipBucket,
    safeAnalyticsErrorCode,
    safeAnalyticsHttpErrorCode,
    trustedDurationMs,
    tryClaimAnalyticsEvent,
} from '@/lib/services/analytics-funnel';
import { anonymousPreflightDeviceId } from '@/lib/services/analysis/anonymous-preflight-device';

export type ExclusionState = 'undecided' | 'saving' | 'excluded' | 'skipped';

export type AnalysisV2PreflightFlow = 'standard' | 'betatest';

export interface AnalysisV2PreflightFlowConfig {
    readonly createEndpoint: string;
    readonly statusEndpoint: (preflightId: string) => string;
    readonly admitEndpoint?: (preflightId: string) => string;
    readonly acceptsTestCredentials: boolean;
}

const STANDARD_PREFLIGHT_FLOW: AnalysisV2PreflightFlowConfig = {
    createEndpoint: '/api/analysis/preflight',
    statusEndpoint: preflightId => `/api/analysis/preflight/${encodeURIComponent(preflightId)}`,
    acceptsTestCredentials: true,
};
const BETATEST_PREFLIGHT_FLOW: AnalysisV2PreflightFlowConfig = {
    createEndpoint: '/api/analysis/betatest/preflight',
    // The status and exclusion resources are owner-scoped shared state.
    statusEndpoint: preflightId => `/api/analysis/preflight/${encodeURIComponent(preflightId)}`,
    admitEndpoint: preflightId => (
        `/api/analysis/betatest/preflight/${encodeURIComponent(preflightId)}/admit`
    ),
    acceptsTestCredentials: false,
};

export function getAnalysisV2PreflightFlowConfig(
    flow: AnalysisV2PreflightFlow = 'standard'
): AnalysisV2PreflightFlowConfig {
    return flow === 'betatest' ? BETATEST_PREFLIGHT_FLOW : STANDARD_PREFLIGHT_FLOW;
}

export function betaAdmissionFailureMessage(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const code = Reflect.get(payload, 'code');
    if (code === 'BETA_CAPACITY_UNAVAILABLE') {
        return '현재 무료 판독 가능 인원이 모두 찼습니다. 잠시 후 다시 시도해주세요.';
    }
    if (code === 'BETA_ADMISSION_PENDING') {
        return '판독 배정을 확인하고 있습니다. 잠시 후 다시 시도해주세요.';
    }
    if (code === 'BETA_ACCESS_UNAVAILABLE') {
        return '베타 테스트 이용 권한을 확인할 수 없습니다.';
    }
    return null;
}

const ANONYMOUS_LOGIN_FALLBACK_CODES = new Set([
    'PREFLIGHT_RATE_LIMITED',
    'ANONYMOUS_PREFLIGHT_UNAVAILABLE',
]);

export function shouldOfferAnonymousPreflightLogin(
    payload: unknown,
    status: number,
    flow: AnalysisV2PreflightFlow = 'standard',
): boolean {
    if (flow !== 'standard') return false;
    if (status < 400) return false;
    if (status === 429) return true;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    return ANONYMOUS_LOGIN_FALLBACK_CODES.has(String(Reflect.get(payload, 'code')));
}

export function isBetaAdmissionPending(
    payload: unknown,
): payload is Record<PropertyKey, unknown> {
    return Boolean(
        payload
        && typeof payload === 'object'
        && !Array.isArray(payload)
        && Reflect.get(payload, 'status') === 'admission_pending'
    );
}

const BETA_ADMISSION_MAX_POLL_ATTEMPTS = 120;

function betaAdmissionRetryAfterMs(
    payload: unknown,
    expectedPreflightId: string,
): number | null {
    if (!isBetaAdmissionPending(payload)) return null;
    const code = Reflect.get(payload, 'code');
    const schemaVersion = Reflect.get(payload, 'schemaVersion');
    const preflightId = Reflect.get(payload, 'preflightId');
    const retryAfterMs = Reflect.get(payload, 'retryAfterMs');
    if (
        code !== 'BETA_ADMISSION_PENDING'
        || schemaVersion !== 1
        || preflightId !== expectedPreflightId
        || typeof retryAfterMs !== 'number'
        || !Number.isInteger(retryAfterMs)
        || retryAfterMs < 250
        || retryAfterMs > 30_000
    ) {
        return null;
    }
    return retryAfterMs;
}

export function restoreExclusionState(
    current: ExclusionState,
    decision: PreflightExclusionDecisionV1
): ExclusionState {
    if (decision === 'exclude') return 'excluded';
    if (decision === 'skip') return 'skipped';
    return current;
}

export function mergeLoadedPreflight(
    current: PreflightStatusV1 | null,
    incoming: PreflightStatusV1
): PreflightStatusV1 {
    if (
        !current
        || current.preflightId !== incoming.preflightId
        || current.exclusionDecision === 'pending'
        || incoming.exclusionDecision !== 'pending'
    ) {
        return incoming;
    }
    return preflightStatusV1Schema.parse({
        ...incoming,
        exclusionDecision: current.exclusionDecision,
    });
}

interface ConsumedPreflightRedirectDependencies {
    replace: (href: string) => void;
    storage: PendingTargetStorage | undefined;
}

export function redirectConsumedPreflight(
    status: PreflightStatusV1,
    { replace, storage }: ConsumedPreflightRedirectDependencies,
): boolean {
    if (status.status !== 'consumed') return false;
    if (storage) {
        clearPendingAnalysisTargetForTerminalState(storage, status.status);
        clearPreflightDisplayTargetForTerminalState(storage, {
            preflightId: status.preflightId,
            status: status.status,
        });
    }
    replace(`/progress/${encodeURIComponent(status.requestId)}`);
    return true;
}

interface ApiErrorPayload {
    code?: string;
    error?: string;
}

class AnalyticsRequestError extends Error {
    readonly code: string;
    readonly terminal: boolean;
    readonly outcome: 'blocked' | 'failed';

    constructor(
        message: string,
        code: string,
        terminal = false,
        outcome: 'blocked' | 'failed' = 'failed',
    ) {
        super(message);
        this.name = 'AnalyticsRequestError';
        this.code = code;
        this.terminal = terminal;
        this.outcome = outcome;
    }
}

const BLOCKED_PREFLIGHT_COPY: Readonly<Record<string, string>> = {
    TARGET_NOT_FOUND: '해당 인스타그램 계정을 찾을 수 없습니다.',
    TARGET_PRIVATE: '비공개 계정은 판독할 수 없습니다.',
    TARGET_UNSUPPORTED: '현재 판독할 수 없는 계정입니다.',
    OVER_PLUS_CAPACITY: '팔로워 또는 팔로잉 수가 현재 최대 지원 범위인 각각 1,200명을 초과해 판독할 수 없습니다.',
    QUEUE_UNAVAILABLE: '사전 점검 작업이 지연되고 있습니다. 잠시 후 다시 시도해주세요.',
    BETA_CAPACITY_UNAVAILABLE: '현재 무료 판독 가능 인원이 모두 찼습니다. 잠시 후 다시 시도해주세요.',
    ANALYSIS_FAILED: '사전 점검을 완료하지 못했습니다.',
};
export function blockedPreflightMessage(code: string): string {
    return BLOCKED_PREFLIGHT_COPY[code] ?? '사전 점검을 완료하지 못했습니다.';
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function messageFromPayload(payload: unknown, fallback: string): string {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return fallback;
    const candidate = payload as ApiErrorPayload;
    return typeof candidate.error === 'string' && candidate.error.trim()
        ? candidate.error
        : fallback;
}

async function readPayload(response: Response): Promise<unknown> {
    try {
        return await response.json();
    } catch {
        return null;
    }
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const handleAbort = () => {
            window.clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
        };
        const timer = window.setTimeout(() => {
            signal.removeEventListener('abort', handleAbort);
            resolve();
        }, delayMs);
        signal.addEventListener('abort', handleAbort, { once: true });
    });
}

export interface PreflightRequestScope {
    readonly generation: number;
    readonly preflightId: string | null;
    readonly signal: AbortSignal;
    isCurrent(): boolean;
    finish(): void;
    abort(): void;
}

export class PreflightRequestCoordinator {
    private generation = 0;
    private currentPreflightId: string | null = null;
    private readonly controllers = new Set<AbortController>();
    private pollToken: object | null = null;

    beginLifecycle(preflightId: string | null = null): number {
        this.generation += 1;
        this.currentPreflightId = preflightId;
        this.pollToken = null;
        for (const controller of this.controllers) controller.abort();
        this.controllers.clear();
        return this.generation;
    }

    get currentGeneration(): number {
        return this.generation;
    }

    attachPreflight(generation: number, preflightId: string): boolean {
        if (!this.isCurrent(generation)) return false;
        this.currentPreflightId = preflightId;
        return true;
    }

    isCurrent(generation: number, preflightId?: string | null): boolean {
        return generation === this.generation
            && (preflightId === undefined || preflightId === this.currentPreflightId);
    }

    beginRequest(
        generation: number,
        preflightId?: string | null
    ): PreflightRequestScope | null {
        if (!this.isCurrent(generation, preflightId)) return null;
        const controller = new AbortController();
        this.controllers.add(controller);
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            this.controllers.delete(controller);
        };
        return {
            generation,
            preflightId: preflightId ?? null,
            signal: controller.signal,
            isCurrent: () => !finished
                && !controller.signal.aborted
                && this.isCurrent(generation, preflightId),
            finish,
            abort: () => {
                controller.abort();
                finish();
            },
        };
    }

    beginPoll(generation: number, preflightId: string): PreflightRequestScope | null {
        if (this.pollToken !== null) return null;
        const scope = this.beginRequest(generation, preflightId);
        if (!scope) return null;
        const token = {};
        this.pollToken = token;
        const finish = scope.finish;
        return {
            ...scope,
            finish: () => {
                if (this.pollToken === token) this.pollToken = null;
                finish();
            },
            abort: () => {
                scope.abort();
                if (this.pollToken === token) this.pollToken = null;
            },
        };
    }

    dispose(): void {
        this.beginLifecycle();
    }
}

type ReadyPreflight = Extract<PreflightStatusV1, { status: 'ready' }>;

export function mergeFreshPlanSnapshot(
    current: ReadyPreflight,
    latest: FreshPlanSnapshotV1
): ReadyPreflight | null {
    if (latest.capacityRequiredPlanId === null || latest.requiredPlanId === null) return null;
    const parsed = preflightStatusV1Schema.safeParse({
        ...current,
        target: {
            ...current.target,
            followersCount: latest.followersCount,
            followingCount: latest.followingCount,
        },
        capacityRequiredPlan: latest.capacityRequiredPlanId,
        requiredPlan: latest.requiredPlanId,
        plans: latest.plans,
        pricingVersion: latest.pricingVersion,
    });
    return parsed.success && parsed.data.status === 'ready' ? parsed.data : null;
}

export function useAnalysisV2Preflight({
    flow = 'standard',
}: { flow?: AnalysisV2PreflightFlow } = {}) {
    const flowConfig = getAnalysisV2PreflightFlowConfig(flow);
    const [targetInstagramId, setTargetInstagramId] = useState<string | null>(null);
    const [preflight, setPreflight] = useState<PreflightStatusV1 | null>(null);
    const [creating, setCreating] = useState(false);
    const [exclusionState, setExclusionState] = useState<ExclusionState>('undecided');
    const [starting, setStarting] = useState(false);
    const [, setCredentialRevision] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [analyticsEligible, setAnalyticsEligible] = useState(true);
    const [claimToken, setClaimToken] = useState<string | null>(null);
    const [loginFallbackRequired, setLoginFallbackRequired] = useState(false);
    const [coordinator] = useState(() => new PreflightRequestCoordinator());
    const idempotencyRef = useRef<AnalysisStartIdempotency | null>(null);
    const claimTokenRef = useRef<string | null>(null);
    const entitlementScopeRef = useRef<PreflightRequestScope | null>(null);
    const preflightStartedAtRef = useRef<number | null>(null);
    const preflightOutcomeTrackedRef = useRef(new Set<string>());
    const analyticsEligibleRef = useRef(true);

    const trackPreflightOutcome = useCallback((status: PreflightStatusV1) => {
        if (!analyticsEligibleRef.current) return;
        if (status.status !== 'ready' && status.status !== 'blocked') return;
        const outcome = classifyPreflightAnalyticsOutcome(
            status.status,
            status.status === 'blocked' ? status.code : undefined,
        );
        const localKey = `${outcome}:${status.preflightId}`;
        if (preflightOutcomeTrackedRef.current.has(localKey)) return;
        const eventKey = preflightOutcomeEventKey(outcome, status.preflightId);
        if (!tryClaimAnalyticsEvent(availableAnalyticsStorage(), eventKey)) {
            preflightOutcomeTrackedRef.current.add(localKey);
            return;
        }
        preflightOutcomeTrackedRef.current.add(localKey);
        const durationMs = trustedDurationMs(preflightStartedAtRef.current, Date.now());
        const durationProperties = durationMs === undefined ? {} : { duration_ms: durationMs };
        if (status.status === 'ready') {
            trackEvent(EVENTS.PREFLIGHT_SUCCEEDED, {
                ...durationProperties,
                required_plan_id: status.requiredPlan,
                followers_bucket: relationshipBucket(status.target.followersCount),
                following_bucket: relationshipBucket(status.target.followingCount),
                preflight_id: status.preflightId,
            });
            return;
        }
        trackEvent(
            outcome === 'blocked' ? EVENTS.PREFLIGHT_BLOCKED : EVENTS.PREFLIGHT_FAILED,
            {
                ...durationProperties,
                error_code: safeAnalyticsErrorCode({ code: status.code }),
                stage: 'preflight',
                preflight_id: status.preflightId,
            },
        );
    }, []);

    const trackPreflightAttemptFailure = useCallback((
        cause: unknown,
        preflightId?: string,
    ) => {
        if (!analyticsEligibleRef.current) return;
        const durationMs = trustedDurationMs(preflightStartedAtRef.current, Date.now());
        const event = cause instanceof AnalyticsRequestError && cause.outcome === 'blocked'
            ? EVENTS.PREFLIGHT_BLOCKED
            : EVENTS.PREFLIGHT_FAILED;
        trackEvent(event, {
            ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
            error_code: safeAnalyticsErrorCode(cause),
            stage: 'preflight',
            ...(preflightId ? { preflight_id: preflightId } : {}),
        });
    }, []);

    const loadPreflight = useCallback(async (
        preflightId: string,
        scope: PreflightRequestScope
    ): Promise<PreflightStatusV1 | null> => {
        const headers = new Headers();
        if (claimTokenRef.current) {
            headers.set('x-preflight-claim-token', claimTokenRef.current);
        }
        const deviceId = flow === 'standard' ? anonymousPreflightDeviceId() : null;
        if (deviceId) headers.set('x-anonymous-device-id', deviceId);
        const response = await fetch(
            flowConfig.statusEndpoint(preflightId),
            { cache: 'no-store', headers, signal: scope.signal }
        );
        const payload = await readPayload(response);
        analyticsEligibleRef.current = response.headers.get('x-analytics-eligible') !== '0';
        setAnalyticsEligible(analyticsEligibleRef.current);
        if (!response.ok) {
            const responseCode = payload && typeof payload === 'object' && !Array.isArray(payload)
                ? Reflect.get(payload, 'code')
                : null;
            const terminal = (
                response.status === 410 && responseCode === 'PREFLIGHT_EXPIRED'
            ) || (
                response.status === 401 && responseCode === 'UNAUTHORIZED'
            );
            throw new AnalyticsRequestError(
                messageFromPayload(payload, '사전 점검 상태를 확인할 수 없습니다.'),
                safeAnalyticsHttpErrorCode(response.status, payload),
                terminal,
                classifyPreflightRequestAnalyticsOutcome(response.status),
            );
        }
        const parsed = preflightStatusV1Schema.safeParse(payload);
        if (!parsed.success) {
            throw new AnalyticsRequestError(
                '사전 점검 응답을 확인할 수 없습니다.',
                'VALIDATION_ERROR',
            );
        }
        if (!scope.isCurrent()) return null;
        trackPreflightOutcome(parsed.data);
        if (redirectConsumedPreflight(parsed.data, {
            storage: availablePendingTargetStorage(),
            replace: href => window.location.replace(href),
        })) {
            return parsed.data;
        }
        const storage = availablePendingTargetStorage();
        if (storage) {
            clearPreflightDisplayTargetForTerminalState(storage, {
                preflightId: parsed.data.preflightId,
                status: parsed.data.status,
            });
        }
        setPreflight(current => mergeLoadedPreflight(current, parsed.data));
        setExclusionState(current => restoreExclusionState(
            current,
            parsed.data.exclusionDecision
        ));
        if (parsed.data.status === 'ready') {
            setTargetInstagramId(parsed.data.target.username);
        }
        if (parsed.data.status === 'blocked') {
            setError(blockedPreflightMessage(parsed.data.code));
        } else {
            setError(null);
        }
        return parsed.data;
    }, [flow, flowConfig, trackPreflightOutcome]);

    const resumePreflight = useCallback(async (
        preflightId: string,
        rawTargetInstagramId?: string,
        anonymousClaimToken?: string,
    ) => {
        if (!UUID_PATTERN.test(preflightId)) return false;
        if (anonymousClaimToken !== undefined) {
            claimTokenRef.current = anonymousClaimToken || null;
            setClaimToken(anonymousClaimToken || null);
        }
        const normalizedTarget = rawTargetInstagramId
            ? normalizeInstagramUsername(rawTargetInstagramId)
            : null;
        const generation = coordinator.beginLifecycle(preflightId);
        const scope = coordinator.beginRequest(generation, preflightId);
        if (!scope) return false;
        if (normalizedTarget) setTargetInstagramId(normalizedTarget);
        setPreflight(null);
        setExclusionState('undecided');
        setCreating(true);
        setError(null);
        preflightStartedAtRef.current = readPreflightStartedAt(
            availableAnalyticsStorage(),
            preflightId,
        );
        try {
            return await loadPreflight(preflightId, scope) !== null;
        } catch (cause) {
            if (scope.isCurrent()) {
                const terminal = cause instanceof AnalyticsRequestError && cause.terminal;
                if (terminal) {
                    const storage = availablePendingTargetStorage();
                    if (storage) clearPreflightDisplayTarget(storage, preflightId);
                }
                trackPreflightAttemptFailure(cause, preflightId);
                setError(cause instanceof Error
                    ? cause.message
                    : '사전 점검 상태를 확인할 수 없습니다.');
            }
            return false;
        } finally {
            const current = scope.isCurrent();
            scope.finish();
            if (current) setCreating(false);
        }
    }, [coordinator, loadPreflight, trackPreflightAttemptFailure]);

    const startPreflight = useCallback(async (rawTargetInstagramId: string) => {
        const normalized = normalizeInstagramUsername(rawTargetInstagramId);
        if (!normalized) {
            setError('인스타그램 아이디를 확인해주세요.');
            return null;
        }
        const generation = coordinator.beginLifecycle();
        const scope = coordinator.beginRequest(generation);
        if (!scope) return null;
        setCreating(true);
        setError(null);
        setTargetInstagramId(normalized);
        setPreflight(null);
        setExclusionState('undecided');
        setLoginFallbackRequired(false);
        claimTokenRef.current = null;
        setClaimToken(null);
        preflightStartedAtRef.current = Date.now();

        try {
            const testAdmission = flowConfig.acceptsTestCredentials
                ? readTestAdmissionCredential(sessionStorage, normalized)
                : null;
            idempotencyRef.current = getAnalysisStartIdempotency(
                idempotencyRef.current,
                normalized,
                'male',
                testAdmission ? () => testAdmission.idempotencyKey : undefined
            );
            const headers = new Headers({
                'Content-Type': 'application/json',
                'Idempotency-Key': idempotencyRef.current.key,
            });
            const deviceId = flow === 'standard' ? anonymousPreflightDeviceId() : null;
            if (deviceId) headers.set('X-Anonymous-Device-Id', deviceId);
            if (testAdmission) {
                headers.set('X-Analysis-Test-Admission', testAdmission.token);
            }

            const response = flow === 'betatest'
                ? await fetch(flowConfig.createEndpoint, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ targetInstagramId: rawTargetInstagramId }),
                    signal: scope.signal,
                })
                : await fetch('/api/analysis/preflight', {
                method: 'POST',
                headers,
                // Preserve the presented value for the server-only exact demo gate.
                // The server still applies canonical normalization for production preflight.
                body: JSON.stringify({ targetInstagramId: rawTargetInstagramId }),
                signal: scope.signal,
            });
            const payload = await readPayload(response);
            analyticsEligibleRef.current = response.headers.get('x-analytics-eligible') !== '0';
            setAnalyticsEligible(analyticsEligibleRef.current);
            if (!response.ok) {
                if (shouldOfferAnonymousPreflightLogin(payload, response.status, flow)) {
                    setLoginFallbackRequired(true);
                }
                throw new AnalyticsRequestError(
                    (flow === 'betatest' ? betaAdmissionFailureMessage(payload) : null)
                    ?? messageFromPayload(payload, '사전 점검을 시작할 수 없습니다.'),
                    safeAnalyticsHttpErrorCode(response.status, payload),
                    false,
                    classifyPreflightRequestAnalyticsOutcome(response.status),
                );
            }
            const accepted = preflightAcceptedV1Schema.safeParse(payload);
            if (!accepted.success) {
                throw new AnalyticsRequestError(
                    '사전 점검 응답을 확인할 수 없습니다.',
                    'VALIDATION_ERROR',
                );
            }
            if (analyticsEligibleRef.current) trackEvent(EVENTS.PREFLIGHT_STARTED);
            setLoginFallbackRequired(false);
            if (!scope.isCurrent()) return null;
            if (!coordinator.attachPreflight(generation, accepted.data.preflightId)) return null;
            if (flow === 'standard') {
                const storage = availablePendingTargetStorage();
                if (storage) {
                    storePreflightDisplayTarget(storage, {
                        preflightId: accepted.data.preflightId,
                        target: normalized,
                    });
                }
            }
            if (preflightStartedAtRef.current !== null) {
                persistPreflightStartedAt(
                    availableAnalyticsStorage(),
                    accepted.data.preflightId,
                    preflightStartedAtRef.current,
                );
            }
            if (testAdmission) {
                consumeTestAdmissionCredential(sessionStorage, normalized);
            }
            claimTokenRef.current = accepted.data.claimToken ?? null;
            setClaimToken(accepted.data.claimToken ?? null);
            setPreflight(accepted.data);
            return accepted.data;
        } catch (cause) {
            if (scope.isCurrent()) {
                trackPreflightAttemptFailure(cause);
                setError(cause instanceof Error
                    ? cause.message
                    : '사전 점검을 시작할 수 없습니다.');
            }
            return null;
        } finally {
            const current = coordinator.isCurrent(generation);
            scope.finish();
            if (current) setCreating(false);
        }
    }, [coordinator, flow, flowConfig, trackPreflightAttemptFailure]);

    const submitExclusion = useCallback(async (rawExcludedInstagramId?: string) => {
        if (!preflight || preflight.status === 'consumed') return false;
        if (preflight.exclusionDecision !== 'pending') {
            setExclusionState(current => restoreExclusionState(
                current,
                preflight.exclusionDecision
            ));
            return true;
        }
        const excludedInstagramId = rawExcludedInstagramId === undefined
            ? null
            : normalizeInstagramUsername(rawExcludedInstagramId);
        if (rawExcludedInstagramId !== undefined && !excludedInstagramId) {
            setError('본인의 인스타그램 아이디를 확인해주세요.');
            return false;
        }

        const generation = coordinator.currentGeneration;
        const scope = coordinator.beginRequest(generation, preflight.preflightId);
        if (!scope) return false;

        setExclusionState('saving');
        setError(null);
        try {
            const response = await fetch(
                `/api/analysis/preflight/${encodeURIComponent(preflight.preflightId)}`,
                {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(claimTokenRef.current
                            ? { 'x-preflight-claim-token': claimTokenRef.current }
                            : {}),
                    },
                    body: JSON.stringify(excludedInstagramId
                        ? { decision: 'exclude', excludedInstagramId }
                        : { decision: 'skip' }),
                    signal: scope.signal,
                }
            );
            if (!response.ok) {
                const payload = await readPayload(response);
                throw new Error(messageFromPayload(payload, '제외할 계정을 저장하지 못했습니다.'));
            }
            if (!scope.isCurrent()) return false;
            const exclusionDecision = excludedInstagramId ? 'exclude' : 'skip';
            setPreflight(current => current?.preflightId === preflight.preflightId
                ? { ...current, exclusionDecision }
                : current);
            setExclusionState(exclusionDecision === 'exclude' ? 'excluded' : 'skipped');
            if (analyticsEligibleRef.current) trackEvent(EVENTS.EXCLUSION_DECIDED, {
                preflight_id: preflight.preflightId,
                decision: exclusionDecision,
            });
            return true;
        } catch (cause) {
            if (scope.isCurrent()) {
                setError(cause instanceof Error
                    ? cause.message
                    : '제외할 계정을 저장하지 못했습니다.');
                setExclusionState('undecided');
            }
            return false;
        } finally {
            scope.finish();
        }
    }, [coordinator, preflight]);

    const refreshPreflight = useCallback(async (): Promise<void> => {
        if (!preflight || preflight.status !== 'ready') return;
        const generation = coordinator.currentGeneration;
        const scope = coordinator.beginRequest(generation, preflight.preflightId);
        if (!scope) return;
        try {
            await loadPreflight(preflight.preflightId, scope);
        } catch {
            // Best-effort refresh triggered by a checkout rejection; the caller
            // owns surfacing its own error message regardless of this outcome.
        } finally {
            scope.finish();
        }
    }, [coordinator, loadPreflight, preflight]);

    const hasTestEntitlement = useCallback((planId: PlanId): boolean => {
        if (!preflight || preflight.status !== 'ready' || typeof window === 'undefined') {
            return false;
        }
        if (preflight.plans.find(plan => plan.planId === planId)?.selectionState === 'unavailable') {
            return false;
        }
        return readTestEntitlementToken(sessionStorage, preflight.preflightId, planId) !== null;
    }, [preflight]);

    const startAnalysis = useCallback(async (planId: PlanId) => {
        if (!preflight || preflight.status !== 'ready') return null;
        if (preflight.plans.find(plan => plan.planId === planId)?.selectionState === 'unavailable') {
            setError('현재 계정 규모에 맞는 플랜을 선택해주세요.');
            return null;
        }
        const token = readTestEntitlementToken(sessionStorage, preflight.preflightId, planId);
        if (!token) {
            setError('결제 연동 후 이용할 수 있습니다.');
            return null;
        }

        entitlementScopeRef.current?.abort();
        const generation = coordinator.currentGeneration;
        const scope = coordinator.beginRequest(generation, preflight.preflightId);
        if (!scope) return null;
        entitlementScopeRef.current = scope;
        setStarting(true);
        setError(null);

        try {
            for (let attempt = 0; attempt < 120; attempt += 1) {
                const response = await fetch(
                    `/api/analysis/preflight/${encodeURIComponent(preflight.preflightId)}/entitle`,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Analysis-Test-Entitlement': token,
                        },
                        body: JSON.stringify({ planId }),
                        signal: scope.signal,
                    }
                );
                const payload = await readPayload(response);
                if (!response.ok) {
                    if (response.status === 409) {
                        const freshError = freshAdmissionErrorResponseV1Schema.safeParse(payload);
                        if (
                            freshError.success
                            && freshError.data.code === 'ANALYSIS_V2_PLAN_NOT_ALLOWED'
                            && freshError.data.latestPlan?.selectedPlanId === planId
                        ) {
                            const updated = mergeFreshPlanSnapshot(
                                preflight,
                                freshError.data.latestPlan
                            );
                            if (updated && scope.isCurrent()) {
                                setPreflight(updated);
                                setError(
                                    '계정 규모가 변경되어 이용 가능한 플랜을 다시 계산했습니다. '
                                    + '새 플랜을 선택해주세요.'
                                );
                                return null;
                            }
                        }
                        if (scope.isCurrent()) {
                            coordinator.beginLifecycle();
                            idempotencyRef.current = null;
                            setPreflight(null);
                            setExclusionState('undecided');
                            setCreating(false);
                            setStarting(false);
                            setError(
                                '계정 정보가 변경되어 사전 점검이 다시 필요합니다. '
                                + '대상 계정을 다시 확인해주세요.'
                            );
                        }
                        return null;
                    }
                    throw new Error(messageFromPayload(payload, '판독 작업을 시작할 수 없습니다.'));
                }
                const parsed = testEntitlementResponseV1Schema.safeParse(payload);
                if (!parsed.success) {
                    throw new Error('판독 시작 응답을 확인할 수 없습니다.');
                }
                if (!scope.isCurrent()) return null;
                if (parsed.data.status !== 'admission_pending') {
                    consumeTestEntitlementToken(
                        sessionStorage,
                        preflight.preflightId,
                        planId
                    );
                    const requestId = parsed.data.requestId;
                    return requestId;
                }
                await waitForRetry(parsed.data.retryAfterMs, scope.signal);
            }
            throw new Error('최신 계정 정보를 확인하는 데 시간이 걸리고 있습니다. 다시 시도해주세요.');
        } catch (cause) {
            if (cause instanceof Error && cause.name === 'AbortError') return null;
            if (scope.isCurrent()) {
                setError(cause instanceof Error
                    ? cause.message
                    : '판독 작업을 시작할 수 없습니다.');
            }
            return null;
        } finally {
            const current = scope.isCurrent();
            if (entitlementScopeRef.current === scope) {
                entitlementScopeRef.current = null;
            }
            scope.finish();
            if (current) setStarting(false);
        }
    }, [coordinator, preflight]);

    const admitBetaAnalysis = useCallback(async (planId: PlanId) => {
        if (flow !== 'betatest' || !flowConfig.admitEndpoint) return null;
        if (!preflight || preflight.status !== 'ready') return null;
        if (preflight.plans.find(plan => plan.planId === planId)?.selectionState === 'unavailable') {
            setError('현재 계정 규모에 맞는 플랜을 선택해주세요.');
            return null;
        }

        const generation = coordinator.currentGeneration;
        const scope = coordinator.beginRequest(generation, preflight.preflightId);
        if (!scope) return null;
        setStarting(true);
        setError(null);
        try {
            for (let attempt = 0; attempt < BETA_ADMISSION_MAX_POLL_ATTEMPTS; attempt += 1) {
                const response = await fetch(flowConfig.admitEndpoint(preflight.preflightId), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ planId }),
                    signal: scope.signal,
                });
                const payload = await readPayload(response);
                if (!scope.isCurrent()) return null;
                if (!response.ok) {
                    throw new Error(
                        betaAdmissionFailureMessage(payload)
                        ?? messageFromPayload(payload, '무료 판독 배정을 완료하지 못했습니다. 잠시 후 다시 시도해주세요.')
                    );
                }
                const retryAfterMs = betaAdmissionRetryAfterMs(
                    payload,
                    preflight.preflightId,
                );
                if (retryAfterMs !== null) {
                    if (attempt + 1 < BETA_ADMISSION_MAX_POLL_ATTEMPTS) {
                        await waitForRetry(retryAfterMs, scope.signal);
                        if (!scope.isCurrent()) return null;
                    }
                    continue;
                }
                const requestId = payload && typeof payload === 'object'
                    ? Reflect.get(payload, 'requestId')
                    : null;
                if (typeof requestId !== 'string' || !UUID_PATTERN.test(requestId)) {
                    throw new Error('판독 시작 응답을 확인할 수 없습니다.');
                }
                return requestId;
            }
            throw new Error('무료 판독 배정을 확인하는 데 시간이 걸리고 있습니다. 다시 시도해주세요.');
        } catch (cause) {
            if (cause instanceof Error && cause.name === 'AbortError') return null;
            if (scope.isCurrent()) {
                setError(cause instanceof Error
                    ? cause.message
                    : '무료 판독 배정을 완료하지 못했습니다. 잠시 후 다시 시도해주세요.');
            }
            return null;
        } finally {
            const current = scope.isCurrent();
            scope.finish();
            if (current) setStarting(false);
        }
    }, [coordinator, flow, flowConfig, preflight]);

    const reset = useCallback(() => {
        coordinator.beginLifecycle();
        entitlementScopeRef.current = null;
        idempotencyRef.current = null;
        claimTokenRef.current = null;
        setClaimToken(null);
        preflightStartedAtRef.current = null;
        setTargetInstagramId(null);
        setPreflight(null);
        setCreating(false);
        setExclusionState('undecided');
        setStarting(false);
        setLoginFallbackRequired(false);
        analyticsEligibleRef.current = true;
        setAnalyticsEligible(true);
        setError(null);
    }, [coordinator]);

    const pollingPreflightId = preflight?.preflightId ?? null;
    const pollingPreflightStatus = preflight?.status ?? null;

    useEffect(() => {
        if (!pollingPreflightId || pollingPreflightStatus !== 'pending') return;
        let cancelled = false;
        let timer: number | null = null;
        let activeScope: PreflightRequestScope | null = null;
        const generation = coordinator.currentGeneration;
        const schedule = () => {
            if (cancelled || !coordinator.isCurrent(generation, pollingPreflightId)) return;
            timer = window.setTimeout(() => void poll(), 1_500);
        };
        const poll = async () => {
            if (cancelled) return;
            const scope = coordinator.beginPoll(generation, pollingPreflightId);
            if (!scope) return;
            activeScope = scope;
            try {
                const next = await loadPreflight(pollingPreflightId, scope);
                if (next?.status === 'pending') schedule();
            } catch (cause) {
                if (scope.isCurrent()) {
                    const terminal = cause instanceof AnalyticsRequestError && cause.terminal;
                    if (terminal) {
                        const storage = availablePendingTargetStorage();
                        if (storage) clearPreflightDisplayTarget(storage, pollingPreflightId);
                    }
                    setError(cause instanceof Error ? cause.message : '사전 점검 상태를 확인할 수 없습니다.');
                    if (terminal) {
                        coordinator.beginLifecycle();
                        idempotencyRef.current = null;
                        preflightStartedAtRef.current = null;
                        setPreflight(null);
                        setExclusionState('undecided');
                        setCreating(false);
                        setStarting(false);
                    } else {
                        schedule();
                    }
                }
            } finally {
                if (activeScope === scope) activeScope = null;
                scope.finish();
            }
        };
        void poll();
        return () => {
            cancelled = true;
            if (timer !== null) window.clearTimeout(timer);
            activeScope?.abort();
        };
    }, [coordinator, loadPreflight, pollingPreflightId, pollingPreflightStatus]);

    useEffect(() => () => coordinator.dispose(), [coordinator]);

    useEffect(() => {
        const refreshCredentials = () => setCredentialRevision(value => value + 1);
        window.addEventListener('analysis-v2-test-credentials-updated', refreshCredentials);
        return () => {
            window.removeEventListener(
                'analysis-v2-test-credentials-updated',
                refreshCredentials
            );
        };
    }, []);

    return {
        targetInstagramId,
        preflightStartedAt: preflightStartedAtRef.current,
        claimToken,
        preflight,
        creating,
        exclusionState,
        starting,
        analyticsEligible,
        loginFallbackRequired,
        error,
        setError,
        startPreflight,
        resumePreflight,
        submitExclusion,
        refreshPreflight,
        hasTestEntitlement,
        startAnalysis,
        admitBetaAnalysis,
        reset,
    };
}
