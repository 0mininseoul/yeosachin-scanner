import 'server-only';

export type RevenueCostOperationOwnerKind =
    | 'preflight_provider_run'
    | 'provider_run'
    | 'ai_attempt';
export type RevenueCostOperationKind =
    | 'target_profile'
    | 'relationship_followers'
    | 'relationship_following'
    | 'stage_one_routing'
    | 'stage_one_routing_retry'
    | 'detail_profile'
    | 'detail_media'
    | 'detail_interaction'
    | 'resolver';

export interface RevenueCostOperationRpcClient {
    rpc(functionName: string, params: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: { code?: string; message?: string } | null;
    }>;
}

interface Identity {
    readonly requestId: string;
    readonly ownerKind: RevenueCostOperationOwnerKind;
    readonly ownerKeyHash: string;
    readonly attempt: number;
}

export interface BeginRevenueCostLedger {
    readonly requestId: string;
}

export interface SettleRevenueCostOperation extends Identity {
    readonly economicActualUsd: number;
    readonly billedActualUsd: number;
}

export interface RevenueCostReconciliationClaim {
    readonly requestId: string;
    readonly jobKey: 'coordinator:finalize';
    readonly claimToken: string;
    readonly jobInputHash: string;
}

export interface ReserveRevenueCostOperation extends Identity {
    readonly operationKind: RevenueCostOperationKind;
    readonly units: number;
    readonly estimatedEconomicUsd: number;
    readonly selectedManifestScopeHash: string | null;
}

export type RevenueCostLiveSourceKind = 'provider_run' | 'ai_attempt';

export interface RevenueCostLiveSource {
    readonly requestId: string;
    readonly jobKey: string;
    readonly jobClaimToken: string;
    readonly jobInputHash: string;
    readonly sourceKind: RevenueCostLiveSourceKind;
    readonly sourceOperationKey: string;
    readonly sourceAttempt: number;
}

export type ReserveRevenueCostOperationV2 = RevenueCostLiveSource;

export interface RevenueCostOperationOutcome {
    readonly disposition: 'begun' | 'accepted' | 'denied' | 'started' | 'settled' | 'released' | 'ambiguous' | 'manual_review';
    readonly created: boolean;
    readonly replayed: boolean;
    readonly operationId?: string;
    readonly reason?: string;
}

export interface RevenueCostReconciliation {
    readonly finalizable: boolean;
    readonly reason: string;
    readonly economicDisposition: 'within_margin_target' | 'negative_margin_pilot' | 'hard_cap_exceeded';
    readonly economicActualKrw: number;
    readonly billedActualKrw: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const JOB_KEY = /^[a-z0-9][a-z0-9:._-]{0,159}$/;
const PROVIDER_OPERATION_KEY = /^(target-profile|profile-fallback|profile-repair|relationship-followers|relationship-following|target-likers|target-comments|candidate-likers):[a-f0-9]{64}$/;
const AI_OPERATION_KEY = /^(gender-triage|gender-resolution|feature-analysis|high-risk-narrative|private-account-name|partner-safety):[a-f0-9]{64}$/;
const OWNER_KINDS = new Set<RevenueCostOperationOwnerKind>([
    'preflight_provider_run', 'provider_run', 'ai_attempt',
]);
const OPERATION_KINDS = new Set<RevenueCostOperationKind>([
    'target_profile', 'relationship_followers', 'relationship_following', 'stage_one_routing',
    'stage_one_routing_retry', 'detail_profile', 'detail_media', 'detail_interaction', 'resolver',
]);

function assertIdentity(input: Identity): void {
    if (!UUID.test(input.requestId) || !OWNER_KINDS.has(input.ownerKind)
        || !HASH.test(input.ownerKeyHash) || !Number.isSafeInteger(input.attempt)
        || input.attempt < 1 || input.attempt > 4) {
        throw new Error('REVENUE_COST_OPERATION_INVALID_INPUT');
    }
}

function assertLiveSource(input: RevenueCostLiveSource): void {
    const sourceKeyPattern = input.sourceKind === 'provider_run' ? PROVIDER_OPERATION_KEY : AI_OPERATION_KEY;
    if (!UUID.test(input.requestId) || !JOB_KEY.test(input.jobKey) || !UUID.test(input.jobClaimToken)
        || !HASH.test(input.jobInputHash) || !['provider_run', 'ai_attempt'].includes(input.sourceKind)
        || !sourceKeyPattern.test(input.sourceOperationKey) || !Number.isSafeInteger(input.sourceAttempt)
        || (input.sourceKind === 'provider_run' && input.sourceAttempt !== 0)
        || (input.sourceKind === 'ai_attempt' && (input.sourceAttempt < 1 || input.sourceAttempt > 4))) {
        throw new Error('REVENUE_COST_OPERATION_INVALID_INPUT');
    }
}

function safeCode(error: { code?: string }): string {
    return typeof error.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'UNKNOWN';
}

function safeOutcome(data: unknown): RevenueCostOperationOutcome {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('REVENUE_COST_OPERATION_INVALID_RESPONSE');
    }
    const row = data as Record<string, unknown>;
    const disposition = row.disposition;
    if (!['begun', 'accepted', 'denied', 'started', 'settled', 'released', 'ambiguous', 'manual_review'].includes(String(disposition))) {
        throw new Error('REVENUE_COST_OPERATION_INVALID_RESPONSE');
    }
    if (typeof row.created !== 'boolean' || typeof row.replayed !== 'boolean'
        || (row.created && row.replayed)) {
        throw new Error('REVENUE_COST_OPERATION_INVALID_RESPONSE');
    }
    return {
        disposition: disposition as RevenueCostOperationOutcome['disposition'],
        created: row.created,
        replayed: row.replayed,
        ...(typeof row.operationId === 'string' ? { operationId: row.operationId } : {}),
        ...(typeof row.reason === 'string' && /^[a-z_]{1,48}$/.test(row.reason) ? { reason: row.reason } : {}),
    };
}

function safeReconciliation(data: unknown): RevenueCostReconciliation {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('REVENUE_COST_OPERATION_INVALID_RESPONSE');
    const row = data as Record<string, unknown>;
    if (typeof row.finalizable !== 'boolean'
        || typeof row.reason !== 'string' || !/^[a-z_]{1,48}$/.test(row.reason)
        || !['within_margin_target', 'negative_margin_pilot', 'hard_cap_exceeded'].includes(String(row.economicDisposition))
        || !Number.isSafeInteger(row.economicActualKrw) || (row.economicActualKrw as number) < 0
        || !Number.isSafeInteger(row.billedActualKrw) || (row.billedActualKrw as number) < 0) {
        throw new Error('REVENUE_COST_OPERATION_INVALID_RESPONSE');
    }
    return row as unknown as RevenueCostReconciliation;
}

export class RevenueCostOperationStore {
    constructor(private readonly client: RevenueCostOperationRpcClient) {}

    async begin(input: BeginRevenueCostLedger): Promise<RevenueCostOperationOutcome> {
        if (!UUID.test(input.requestId)) throw new Error('REVENUE_COST_OPERATION_INVALID_INPUT');
        return this.call('begin_analysis_revenue_cost_ledger_v1', { p_request_id: input.requestId });
    }

    async reserve(input: ReserveRevenueCostOperation): Promise<RevenueCostOperationOutcome> {
        assertIdentity(input);
        if (!OPERATION_KINDS.has(input.operationKind) || !Number.isSafeInteger(input.units)
            || input.units < 1 || !Number.isFinite(input.estimatedEconomicUsd)
            || input.estimatedEconomicUsd < 0 || input.estimatedEconomicUsd > 100_000
            || input.selectedManifestScopeHash !== null && !HASH.test(input.selectedManifestScopeHash)) {
            throw new Error('REVENUE_COST_OPERATION_INVALID_INPUT');
        }
        return this.call('reserve_analysis_revenue_cost_operation_v1', {
            p_request_id: input.requestId,
            p_owner_kind: input.ownerKind,
            p_owner_key_hash: input.ownerKeyHash,
            p_attempt: input.attempt,
            p_operation_kind: input.operationKind,
            p_units: input.units,
            p_estimated_economic_usd: input.estimatedEconomicUsd,
            p_selected_manifest_scope_hash: input.selectedManifestScopeHash,
        });
    }

    async reserveV2(input: ReserveRevenueCostOperationV2): Promise<RevenueCostOperationOutcome> {
        assertLiveSource(input);
        if (input.sourceKind === 'ai_attempt') throw new Error('REVENUE_COST_OPERATION_AI_NOT_READY');
        return this.call('reserve_analysis_revenue_cost_operation_v2', {
            p_request_id: input.requestId, p_job_key: input.jobKey, p_job_claim_token: input.jobClaimToken,
            p_job_input_hash: input.jobInputHash, p_source_kind: input.sourceKind,
            p_source_operation_key: input.sourceOperationKey, p_source_attempt: input.sourceAttempt,
        });
    }

    markStarted(input: Identity): Promise<RevenueCostOperationOutcome> {
        assertIdentity(input);
        return this.call('mark_analysis_revenue_cost_operation_started_v1', {
            p_request_id: input.requestId, p_owner_kind: input.ownerKind,
            p_owner_key_hash: input.ownerKeyHash, p_attempt: input.attempt,
        });
    }

    markStartedV2(input: RevenueCostLiveSource): Promise<RevenueCostOperationOutcome> {
        assertLiveSource(input);
        if (input.sourceKind === 'ai_attempt') throw new Error('REVENUE_COST_OPERATION_AI_NOT_READY');
        return this.call('mark_analysis_revenue_cost_operation_started_v2', {
            p_request_id: input.requestId, p_job_key: input.jobKey, p_job_claim_token: input.jobClaimToken,
            p_job_input_hash: input.jobInputHash, p_source_kind: input.sourceKind,
            p_source_operation_key: input.sourceOperationKey, p_source_attempt: input.sourceAttempt,
        });
    }

    async settle(input: SettleRevenueCostOperation): Promise<RevenueCostOperationOutcome> {
        assertIdentity(input);
        if (!Number.isFinite(input.economicActualUsd) || input.economicActualUsd < 0 || input.economicActualUsd > 100_000
            || !Number.isFinite(input.billedActualUsd) || input.billedActualUsd < 0 || input.billedActualUsd > 100_000) {
            throw new Error('REVENUE_COST_OPERATION_INVALID_INPUT');
        }
        return this.call('settle_analysis_revenue_cost_operation_v1', {
            p_request_id: input.requestId, p_owner_kind: input.ownerKind,
            p_owner_key_hash: input.ownerKeyHash, p_attempt: input.attempt,
            p_economic_actual_usd: input.economicActualUsd, p_billed_actual_usd: input.billedActualUsd,
        });
    }

    release(input: Identity): Promise<RevenueCostOperationOutcome> {
        assertIdentity(input);
        return this.call('release_analysis_revenue_cost_operation_v1', {
            p_request_id: input.requestId, p_owner_kind: input.ownerKind,
            p_owner_key_hash: input.ownerKeyHash, p_attempt: input.attempt,
        });
    }

    manualReview(input: { requestId: string; reasonCode: 'routing_failure' | 'ambiguous_external_call' | 'cost_overrun' }): Promise<RevenueCostOperationOutcome> {
        if (!UUID.test(input.requestId)) throw new Error('REVENUE_COST_OPERATION_INVALID_INPUT');
        return this.call('mark_analysis_revenue_manual_review_v1', {
            p_request_id: input.requestId, p_reason_code: input.reasonCode,
        });
    }

    async reconcile(input: RevenueCostReconciliationClaim): Promise<RevenueCostReconciliation> {
        if (!UUID.test(input.requestId) || input.jobKey !== 'coordinator:finalize'
            || !UUID.test(input.claimToken) || !HASH.test(input.jobInputHash)) {
            throw new Error('REVENUE_COST_OPERATION_INVALID_INPUT');
        }
        const { data, error } = await this.client.rpc('read_analysis_revenue_cost_reconciliation_v1', {
            p_request_id: input.requestId, p_job_key: input.jobKey,
            p_claim_token: input.claimToken, p_job_input_hash: input.jobInputHash,
        });
        if (error) throw new Error(`REVENUE_COST_OPERATION_RPC_FAILED_${safeCode(error)}`);
        return safeReconciliation(data);
    }

    private async call(functionName: string, params: Record<string, unknown>): Promise<RevenueCostOperationOutcome> {
        const { data, error } = await this.client.rpc(functionName, params);
        if (error) throw new Error(`REVENUE_COST_OPERATION_RPC_FAILED_${safeCode(error)}`);
        return safeOutcome(data);
    }
}
