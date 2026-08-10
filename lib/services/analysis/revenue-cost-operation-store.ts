import 'server-only';

export type RevenueCostOperationOwnerKind =
    | 'target_profile'
    | 'relationship'
    | 'routing'
    | 'profile'
    | 'media'
    | 'interaction'
    | 'resolver';
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

export interface ReserveRevenueCostOperation extends Identity {
    readonly operationKind: RevenueCostOperationKind;
    readonly units: number;
    readonly estimatedEconomicUsd: number;
    readonly selectedManifestScopeHash: string | null;
}

export interface RevenueCostOperationOutcome {
    readonly disposition: 'accepted' | 'denied' | 'started' | 'settled' | 'released' | 'ambiguous' | 'manual_review';
    readonly operationId?: string;
    readonly reason?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const OWNER_KINDS = new Set<RevenueCostOperationOwnerKind>([
    'target_profile', 'relationship', 'routing', 'profile', 'media', 'interaction', 'resolver',
]);
const OPERATION_KINDS = new Set<RevenueCostOperationKind>([
    'target_profile', 'relationship_followers', 'relationship_following', 'stage_one_routing',
    'stage_one_routing_retry', 'detail_profile', 'detail_media', 'detail_interaction', 'resolver',
]);

function assertIdentity(input: Identity): void {
    if (!UUID.test(input.requestId) || !OWNER_KINDS.has(input.ownerKind)
        || !HASH.test(input.ownerKeyHash) || !Number.isSafeInteger(input.attempt)
        || input.attempt < 1 || input.attempt > 2) {
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
    if (!['accepted', 'denied', 'started', 'settled', 'released', 'ambiguous', 'manual_review'].includes(String(disposition))) {
        throw new Error('REVENUE_COST_OPERATION_INVALID_RESPONSE');
    }
    return {
        disposition: disposition as RevenueCostOperationOutcome['disposition'],
        ...(typeof row.operationId === 'string' ? { operationId: row.operationId } : {}),
        ...(typeof row.reason === 'string' && /^[a-z_]{1,48}$/.test(row.reason) ? { reason: row.reason } : {}),
    };
}

export class RevenueCostOperationStore {
    constructor(private readonly client: RevenueCostOperationRpcClient) {}

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

    markStarted(input: Identity): Promise<RevenueCostOperationOutcome> {
        assertIdentity(input);
        return this.call('mark_analysis_revenue_cost_operation_started_v1', {
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

    private async call(functionName: string, params: Record<string, unknown>): Promise<RevenueCostOperationOutcome> {
        const { data, error } = await this.client.rpc(functionName, params);
        if (error) throw new Error(`REVENUE_COST_OPERATION_RPC_FAILED_${safeCode(error)}`);
        return safeOutcome(data);
    }
}
