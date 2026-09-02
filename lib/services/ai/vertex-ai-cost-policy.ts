import {
    estimateGeminiRequestCostStrict,
    type GeminiRequestCostEstimate,
} from './gemini-cost';

export const VERTEX_AI_COST_POLICY_VERSION = 'vertex-ai-cost-v1' as const;
export const VERTEX_AI_DEFAULT_MODEL = 'gemini-3.1-flash-lite' as const;
export const VERTEX_AI_ESCALATION_MODEL = 'gemini-3.7-flash' as const;
export const VERTEX_AI_BUDGET_RPC_NAMES = Object.freeze({
    reserve: 'reserve_vertex_ai_budget',
    settle: 'settle_vertex_ai_budget',
    cancel: 'cancel_vertex_ai_budget',
    snapshot: 'snapshot_vertex_ai_budget',
});

function vertexAiModelId(modelName: string): string {
    return modelName.trim().split('/').at(-1) ?? modelName.trim();
}

/** Recognizes the canonical v2.12 default Flash-Lite family, including revision aliases. */
export function isVertexAiDefaultModel(modelName: string): boolean {
    return /^gemini-3\.1-flash-lite(?:-preview|-\d{3})?$/.test(vertexAiModelId(modelName));
}

/** Recognizes the billed 3.7 release family, including a versioned model resource ID. */
export function isVertexAiEscalationModel(modelName: string): boolean {
    const modelId = vertexAiModelId(modelName);
    return /^gemini-3\.7-flash(?:-\d{3})?$/.test(modelId);
}

export type VertexAiCostRoute = 'default' | 'high_value' | 'ambiguous';
export type VertexAiEscalationReason = Exclude<VertexAiCostRoute, 'default'>;

/** Enforce the v2.12 route/model pairing before a provider or budget request is assembled. */
export function assertVertexAiCostRouteModel(input: {
    route: VertexAiCostRoute;
    modelName: string;
}): void {
    if (input.route === 'default' && !isVertexAiDefaultModel(input.modelName)) {
        throw new Error('VERTEX_AI_DEFAULT_MODEL_MISMATCH');
    }
    if (input.route !== 'default' && !isVertexAiEscalationModel(input.modelName)) {
        throw new Error('VERTEX_AI_ESCALATION_MODEL_MISMATCH');
    }
}
export type VertexAiCostStage =
    | 'genderTriage'
    | 'featureAnalysis'
    | 'partnerSafety'
    | 'highRiskNarrative'
    | 'privateAccountName'
    | 'genderResolution';
export type VertexAiThinkingLevel = 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
export type VertexAiMediaResolution = 'LOW' | 'MEDIUM' | 'HIGH';

export interface VertexAiCostRoutePolicy {
    route: VertexAiCostRoute;
    escalationReason: VertexAiEscalationReason | null;
    modelName: string;
    thinkingLevel: VertexAiThinkingLevel;
    mediaResolution: VertexAiMediaResolution;
    maxOutputTokens: number;
    maxAttempts: number;
    retryResponseRejections: boolean;
}

const STAGE_DEFAULTS: Readonly<Record<VertexAiCostStage, Omit<
    VertexAiCostRoutePolicy,
    'route' | 'escalationReason' | 'modelName' | 'maxAttempts' | 'retryResponseRejections'
>>> = Object.freeze({
    genderTriage: {
        thinkingLevel: 'MINIMAL',
        mediaResolution: 'LOW',
        maxOutputTokens: 512,
    },
    featureAnalysis: {
        thinkingLevel: 'LOW',
        mediaResolution: 'LOW',
        maxOutputTokens: 1_024,
    },
    partnerSafety: {
        thinkingLevel: 'LOW',
        mediaResolution: 'LOW',
        maxOutputTokens: 512,
    },
    highRiskNarrative: {
        thinkingLevel: 'LOW',
        mediaResolution: 'LOW',
        maxOutputTokens: 2_048,
    },
    privateAccountName: {
        thinkingLevel: 'MINIMAL',
        mediaResolution: 'LOW',
        maxOutputTokens: 2_048,
    },
    genderResolution: {
        thinkingLevel: 'LOW',
        mediaResolution: 'LOW',
        maxOutputTokens: 1_024,
    },
});

const ESCALATION_OUTPUT_TOKENS: Readonly<Record<VertexAiCostStage, number>> = Object.freeze({
    genderTriage: 1_024,
    featureAnalysis: 4_096,
    partnerSafety: 1_024,
    highRiskNarrative: 4_096,
    privateAccountName: 4_096,
    genderResolution: 2_048,
});

function isEscalationReason(value: unknown): value is VertexAiEscalationReason {
    return value === 'high_value' || value === 'ambiguous';
}

/**
 * Select the cost route before constructing a request/result identity. The absence of a reason is
 * intentionally a complete decision: normal work never inherits the expensive model.
 */
export function selectVertexAiRoute(input: {
    stage: VertexAiCostStage;
    escalationReason?: VertexAiEscalationReason | null;
}): VertexAiCostRoutePolicy {
    if (!Object.prototype.hasOwnProperty.call(STAGE_DEFAULTS, input.stage)) {
        throw new Error('VERTEX_AI_STAGE_UNKNOWN');
    }
    if (input.escalationReason !== undefined && input.escalationReason !== null
        && !isEscalationReason(input.escalationReason)) {
        throw new Error('VERTEX_AI_ESCALATION_REASON_INVALID');
    }

    const reason = input.escalationReason ?? null;
    const escalated = reason !== null;
    return Object.freeze({
        ...STAGE_DEFAULTS[input.stage],
        route: reason ?? 'default',
        escalationReason: reason,
        modelName: escalated ? VERTEX_AI_ESCALATION_MODEL : VERTEX_AI_DEFAULT_MODEL,
        maxOutputTokens: escalated
            ? ESCALATION_OUTPUT_TOKENS[input.stage]
            : STAGE_DEFAULTS[input.stage].maxOutputTokens,
        // A single bounded retry is available only after an explicit escalation. The default
        // first pass is never allowed to spend a second attempt on a malformed response. The
        // existing transport only permits response-rejection retries for featureAnalysis; other
        // escalations may retry a transport rate limit but never spend a second parse attempt.
        maxAttempts: escalated ? 2 : 1,
        retryResponseRejections: escalated && input.stage === 'featureAnalysis',
    });
}

export interface VertexAiPreDispatchCostInput {
    modelName: string;
    location?: string;
    inputTokens: number;
    maxOutputTokens: number;
}

/** Estimate the maximum standard on-demand charge before the SDK is reached. */
export function estimateVertexAiPreDispatchCost(
    input: VertexAiPreDispatchCostInput,
): GeminiRequestCostEstimate {
    if (
        !Number.isSafeInteger(input.inputTokens)
        || input.inputTokens < 0
        || !Number.isSafeInteger(input.maxOutputTokens)
        || input.maxOutputTokens < 1
    ) {
        throw new Error('VERTEX_AI_TOKEN_ESTIMATE_INVALID');
    }
    return estimateGeminiRequestCostStrict(
        {
            promptTokens: input.inputTokens,
            completionTokens: 0,
            totalTokens: input.inputTokens + input.maxOutputTokens,
            // Vertex's max output ceiling includes reasoning tokens for this guard. Treating the
            // complete ceiling as billable output is conservative and keeps unknown usage paid.
            thinkingTokens: input.maxOutputTokens,
        },
        input.modelName,
        input.location ?? 'global',
    );
}

/** Deterministic, conservative prompt/media estimate used only when response usage is unavailable. */
export function estimateVertexAiInputTokens(
    prompt: string,
    mediaCount = 0,
): number {
    if (typeof prompt !== 'string' || !Number.isSafeInteger(mediaCount) || mediaCount < 0) {
        throw new Error('VERTEX_AI_TOKEN_ESTIMATE_INVALID');
    }
    const promptBytes = new TextEncoder().encode(prompt).byteLength;
    // A media token floor avoids treating an image as free while remaining deterministic for
    // pre-dispatch admission. Response usage always supersedes this estimate when complete.
    return Math.max(1, Math.ceil(promptBytes / 4)) + mediaCount * 256;
}

export interface VertexAiBudgetLimits {
    perRunUsd: number;
    perOrderUsd: number;
    dailyUsd: number;
}

export const DEFAULT_VERTEX_AI_BUDGET_LIMITS: Readonly<VertexAiBudgetLimits> = Object.freeze({
    perRunUsd: 2,
    perOrderUsd: 5,
    dailyUsd: 100,
});

const BUDGET_ENV_KEYS: Readonly<Record<keyof VertexAiBudgetLimits, string>> = Object.freeze({
    perRunUsd: 'VERTEX_AI_PER_RUN_BUDGET_USD',
    perOrderUsd: 'VERTEX_AI_PER_ORDER_BUDGET_USD',
    dailyUsd: 'VERTEX_AI_DAILY_BUDGET_USD',
});

function parsePositiveBudget(value: string | undefined, key: string, fallback: number): number {
    if (value === undefined || value.trim() === '') return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1_000_000) {
        throw new Error(`VERTEX_AI_BUDGET_CONFIG_INVALID:${key}`);
    }
    return Math.round(parsed * 1_000_000) / 1_000_000;
}

export function vertexAiBudgetLimitsFromEnv(
    env: NodeJS.ProcessEnv = process.env,
): VertexAiBudgetLimits {
    return {
        perRunUsd: parsePositiveBudget(
            env[BUDGET_ENV_KEYS.perRunUsd],
            BUDGET_ENV_KEYS.perRunUsd,
            DEFAULT_VERTEX_AI_BUDGET_LIMITS.perRunUsd,
        ),
        perOrderUsd: parsePositiveBudget(
            env[BUDGET_ENV_KEYS.perOrderUsd],
            BUDGET_ENV_KEYS.perOrderUsd,
            DEFAULT_VERTEX_AI_BUDGET_LIMITS.perOrderUsd,
        ),
        dailyUsd: parsePositiveBudget(
            env[BUDGET_ENV_KEYS.dailyUsd],
            BUDGET_ENV_KEYS.dailyUsd,
            DEFAULT_VERTEX_AI_BUDGET_LIMITS.dailyUsd,
        ),
    };
}

export function vertexAiUtcDayKey(value: Date = new Date()): string {
    if (Number.isNaN(value.getTime())) throw new Error('VERTEX_AI_DAY_KEY_INVALID');
    return value.toISOString().slice(0, 10);
}

export interface VertexAiBudgetReservationInput extends VertexAiPreDispatchCostInput {
    reservationKey: string;
    runId: string;
    orderId?: string | null;
    operationKey: string;
    attempt: number;
    route: VertexAiCostRoute;
    dayKey?: string;
}

export interface VertexAiBudgetReservation {
    reservationId: string;
    reservationKey: string;
    runId: string;
    orderId: string;
    dayKey: string;
    route: VertexAiCostRoute;
    modelName: string;
    attempt: number;
    estimatedCostUsd: number;
    actualCostUsd: number | null;
}

export interface VertexAiBudgetSnapshot {
    run: Readonly<Record<string, number>>;
    order: Readonly<Record<string, number>>;
    day: Readonly<Record<string, number>>;
}

export class VertexAiBudgetExceededError extends Error {
    constructor(
        public readonly scope: 'run' | 'order' | 'day',
        public readonly scopeKey: string,
        public readonly limitUsd: number,
        public readonly currentUsd: number,
        public readonly requestedUsd: number,
    ) {
        super(`VERTEX_AI_BUDGET_EXCEEDED:${scope}`);
        this.name = 'VertexAiBudgetExceededError';
    }
}

export interface VertexAiBudgetStore {
    reserve(input: VertexAiBudgetReservationInput): Promise<VertexAiBudgetReservation>;
    settle(
        reservation: VertexAiBudgetReservation,
        input: { actualCostUsd: number | null | undefined },
    ): Promise<VertexAiBudgetReservation>;
    cancel(reservation: VertexAiBudgetReservation): Promise<void>;
    snapshot(): Promise<VertexAiBudgetSnapshot>;
}

function finiteNonNegative(value: number, code: string): number {
    if (!Number.isFinite(value) || value < 0) throw new Error(code);
    return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

function addTotal(totals: Record<string, number>, key: string, delta: number): void {
    totals[key] = finiteNonNegative((totals[key] ?? 0) + delta, 'VERTEX_AI_BUDGET_TOTAL_INVALID');
    if (totals[key] === 0) delete totals[key];
}

function reservationFingerprint(input: VertexAiBudgetReservationInput): string {
    return JSON.stringify({
        reservationKey: input.reservationKey,
        runId: input.runId,
        orderId: input.orderId ?? null,
        operationKey: input.operationKey,
        attempt: input.attempt,
        route: input.route,
        modelName: input.modelName,
        location: input.location ?? 'global',
        inputTokens: input.inputTokens,
        maxOutputTokens: input.maxOutputTokens,
    });
}

interface StoredReservation {
    reservation: VertexAiBudgetReservation;
    fingerprint: string;
}

/**
 * Process-local reference implementation. Production should provide a shared implementation of
 * VertexAiBudgetStore backed by the monetary-reservation RPC; this class keeps the exact atomic
 * semantics available to unit tests and dry runs.
 */
export class InMemoryVertexAiBudgetStore implements VertexAiBudgetStore {
    private readonly reservations = new Map<string, StoredReservation>();
    private readonly runTotals: Record<string, number> = {};
    private readonly orderTotals: Record<string, number> = {};
    private readonly dayTotals: Record<string, number> = {};
    private reservationSequence = 0;

    constructor(
        private readonly limits: VertexAiBudgetLimits = vertexAiBudgetLimitsFromEnv(),
        private readonly now: () => Date = () => new Date(),
    ) {}

    async reserve(input: VertexAiBudgetReservationInput): Promise<VertexAiBudgetReservation> {
        if (!input.reservationKey || !input.runId || !input.operationKey || !Number.isSafeInteger(input.attempt)
            || input.attempt < 1 || !['default', 'high_value', 'ambiguous'].includes(input.route)) {
            throw new Error('VERTEX_AI_BUDGET_RESERVATION_INVALID');
        }
        const dayKey = input.dayKey ?? vertexAiUtcDayKey(this.now());
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
            throw new Error('VERTEX_AI_BUDGET_RESERVATION_INVALID');
        }
        const fingerprint = reservationFingerprint(input);
        const existing = this.reservations.get(input.reservationKey);
        if (existing) {
            if (
                existing.fingerprint !== fingerprint
                || input.dayKey != null && existing.reservation.dayKey !== dayKey
            ) {
                throw new Error('VERTEX_AI_BUDGET_RESERVATION_IDENTITY_DRIFT');
            }
            return { ...existing.reservation };
        }

        const estimate = estimateVertexAiPreDispatchCost(input).totalCostUsd;
        const orderId = input.orderId?.trim() || input.runId;
        const scopes: ReadonlyArray<{
            kind: 'run' | 'order' | 'day';
            key: string;
            limit: number;
            totals: Record<string, number>;
        }> = [
            { kind: 'run', key: input.runId, limit: this.limits.perRunUsd, totals: this.runTotals },
            { kind: 'order', key: orderId, limit: this.limits.perOrderUsd, totals: this.orderTotals },
            { kind: 'day', key: dayKey, limit: this.limits.dailyUsd, totals: this.dayTotals },
        ];
        for (const scope of scopes) {
            const current = scope.totals[scope.key] ?? 0;
            if (current + estimate > scope.limit + 1e-12) {
                throw new VertexAiBudgetExceededError(
                    scope.kind,
                    scope.key,
                    scope.limit,
                    current,
                    estimate,
                );
            }
        }
        for (const scope of scopes) addTotal(scope.totals, scope.key, estimate);

        const reservation: VertexAiBudgetReservation = {
            reservationId: `vertex-budget:${input.reservationKey}:${++this.reservationSequence}`,
            reservationKey: input.reservationKey,
            runId: input.runId,
            orderId,
            dayKey,
            route: input.route,
            modelName: input.modelName,
            attempt: input.attempt,
            estimatedCostUsd: estimate,
            actualCostUsd: null,
        };
        this.reservations.set(input.reservationKey, { reservation, fingerprint });
        return { ...reservation };
    }

    async settle(
        reservation: VertexAiBudgetReservation,
        input: { actualCostUsd: number | null | undefined },
    ): Promise<VertexAiBudgetReservation> {
        const stored = this.reservations.get(reservation.reservationKey);
        if (!stored) throw new Error('VERTEX_AI_BUDGET_RESERVATION_UNKNOWN');
        if (stored.reservation.reservationId !== reservation.reservationId) {
            throw new Error('VERTEX_AI_BUDGET_RESERVATION_IDENTITY_DRIFT');
        }
        if (stored.reservation.actualCostUsd !== null) {
            if (
                input.actualCostUsd !== null
                && input.actualCostUsd !== undefined
                && finiteNonNegative(input.actualCostUsd, 'VERTEX_AI_ACTUAL_COST_INVALID')
                    !== stored.reservation.actualCostUsd
            ) {
                throw new Error('VERTEX_AI_BUDGET_SETTLEMENT_IDENTITY_DRIFT');
            }
            return { ...stored.reservation };
        }
        if (input.actualCostUsd === null || input.actualCostUsd === undefined) {
            return { ...stored.reservation };
        }
        const actual = finiteNonNegative(input.actualCostUsd, 'VERTEX_AI_ACTUAL_COST_INVALID');
        const delta = actual - stored.reservation.estimatedCostUsd;
        addTotal(this.runTotals, stored.reservation.runId, delta);
        addTotal(this.orderTotals, stored.reservation.orderId, delta);
        addTotal(this.dayTotals, stored.reservation.dayKey, delta);
        stored.reservation.actualCostUsd = actual;
        return { ...stored.reservation };
    }

    async cancel(reservation: VertexAiBudgetReservation): Promise<void> {
        const stored = this.reservations.get(reservation.reservationKey);
        if (!stored) return;
        if (stored.reservation.reservationId !== reservation.reservationId) {
            throw new Error('VERTEX_AI_BUDGET_RESERVATION_IDENTITY_DRIFT');
        }
        if (stored.reservation.actualCostUsd !== null) return;
        addTotal(this.runTotals, stored.reservation.runId, -stored.reservation.estimatedCostUsd);
        addTotal(this.orderTotals, stored.reservation.orderId, -stored.reservation.estimatedCostUsd);
        addTotal(this.dayTotals, stored.reservation.dayKey, -stored.reservation.estimatedCostUsd);
        this.reservations.delete(reservation.reservationKey);
    }

    async snapshot(): Promise<VertexAiBudgetSnapshot> {
        return {
            run: { ...this.runTotals },
            order: { ...this.orderTotals },
            day: { ...this.dayTotals },
        };
    }
}

export type VertexAiBudgetGuard = VertexAiBudgetStore;

export function assertVertexAiBudgetStoreConfigured(
    env: NodeJS.ProcessEnv = process.env,
): void {
    if (
        env.NODE_ENV === 'production'
        && env.VERTEX_AI_BUDGET_STORE?.trim().toLowerCase() !== 'supabase'
    ) {
        throw new Error('VERTEX_AI_BUDGET_STORE_REQUIRED');
    }
}

export function createVertexAiBudgetGuard(options: {
    limits?: VertexAiBudgetLimits;
    now?: () => Date;
    store?: VertexAiBudgetStore;
} = {}): VertexAiBudgetGuard {
    if (options.store) return options.store;
    assertVertexAiBudgetStoreConfigured();
    if (process.env.NODE_ENV === 'production') {
        // The Supabase adapter must be injected by the production resolver. Never turn a
        // production request into an in-process counter merely because a client was omitted.
        throw new Error('VERTEX_AI_BUDGET_STORE_CLIENT_REQUIRED');
    }
    return new InMemoryVertexAiBudgetStore(
        options.limits ?? vertexAiBudgetLimitsFromEnv(),
        options.now,
    );
}
