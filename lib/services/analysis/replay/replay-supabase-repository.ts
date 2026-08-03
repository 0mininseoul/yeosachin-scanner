import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
    replaySourceLineageSchema,
    type ReplaySourceLineage,
} from './replay-source-lineage';

interface RpcResult { data: unknown; error: null | { code?: string; message?: string }; }
/** Narrow read-only RPC surface; the migration function itself is STABLE and contains SELECT only. */
export interface ReplaySourceRpcClient {
    rpc(name: 'read_analysis_v2_replay_capture_source', params: {
        p_target_username: string;
        p_request_id: string | null;
    }): PromiseLike<RpcResult>;
}

/** UUID-only, service-role RPC for the one historical official E2E source. */
export interface HistoricalOfficialE2EReplaySourceRpcClient {
    rpc(name: 'read_analysis_v2_historical_official_e2e_replay_source', params: {
        p_request_id: string;
    }): PromiseLike<RpcResult>;
}

/** UUID-only, service-role RPC for a scrubbed, paid current-production source. */
export interface CurrentProductionReplaySourceRpcClient {
    rpc(name: 'read_analysis_v2_current_production_replay_source', params: {
        p_request_id: string;
    }): PromiseLike<RpcResult>;
}

/** UUID-only, service-role RPC for one completed betatest free-pool source. */
export interface BetatestFreePoolReplaySourceRpcClient {
    rpc(name: 'read_analysis_v2_betatest_free_pool_replay_source', params: {
        p_request_id: string;
    }): PromiseLike<RpcResult>;
}

/** UUID-only, service-role reader for the sealed test-entitlement maintenance source. */
export interface TestEntitlementLegacySecondaryReplaySourceRpcClient {
    rpc(name: 'read_analysis_v2_test_entitlement_v211_legacy_secondary_source', params: {
        p_request_id: string;
    }): PromiseLike<RpcResult>;
}
export interface TestEntitlementLegacySecondaryTextOnlyReplaySourceRpcClient {
    rpc(name: 'read_analysis_v2_test_entitlement_v211_text_only_source', params: { p_request_id: string }): PromiseLike<RpcResult>;
}

const run = z.object({
    actorId: z.string().min(3).max(200),
    credentialSlot: z.string().regex(/^(?:primary|secondary|tertiary|quaternary|quinary|senary|septenary)$/),
    runId: z.string().regex(/^[A-Za-z0-9]{8,64}$/),
    status: z.literal('succeeded'),
    operationKey: z.string().min(1).max(100),
}).strict();
const originalFemaleRow = z.object({
    candidateId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    sortOrdinal: z.number().int().min(1).max(900),
    instagramId: z.string().regex(/^[a-z0-9._]{1,30}$/),
    fullName: z.string().max(200).nullable(),
    profileImageUrl: z.string().max(8_192).nullable(),
    bio: z.string().max(2_200).nullable(),
    displayScore: z.number().min(1).max(10),
    riskBand: z.enum(['normal', 'caution', 'high_risk']),
    featuredRank: z.number().int().min(1).max(15).nullable(),
    recentMutualRank: z.number().int().min(1).max(10).nullable(),
    analysisDepth: z.enum(['features', 'narrative']),
    oneLineOverview: z.string().min(1).max(180),
    highRiskNarrative: z.tuple([z.string().min(1).max(180), z.string().min(1).max(180)]).nullable(),
}).strict();
const source = z.object({
    requestId: z.string().uuid(),
    preflightId: z.string().uuid(),
    targetUsername: z.string().regex(/^[a-z0-9._]{1,30}$/),
    selectedPlanId: z.enum(['standard', 'plus']),
    policyVersions: z.object({
        pipeline: z.string(),
        risk: z.string(),
        aiStage: z.string(),
    }).passthrough(),
    target: z.object({
        fullName: z.string().max(200).nullable(),
        bio: z.string().max(2_200).nullable(),
        profileImageUrl: z.string().url().nullable(),
        followersCount: z.number().int().nonnegative(),
        followingCount: z.number().int().nonnegative(),
    }).strict(),
    preflightRuns: z.array(run).max(4),
    providerRuns: z.array(run).max(128),
}).strict();

const historicalOfficialE2ESource = source.extend({
    targetUsername: z.string().regex(/^replay_[a-f0-9]{23}$/),
    selectedPlanId: z.literal('standard'),
    policyVersions: z.object({
        pipeline: z.literal('v2'),
        risk: z.literal('risk-policy-v2.3'),
        aiStage: z.literal('ai-stage-policy-v2.7'),
    }).strict(),
}).strict();

const currentProductionSource = z.object({
    requestId: z.string().uuid(),
    preflightId: z.string().uuid(),
    targetUsername: z.string().regex(/^replay_[a-f0-9]{23}$/),
    selectedPlanId: z.literal('standard'),
    policyVersions: z.object({
        pipeline: z.literal('v2'),
        risk: z.literal('risk-policy-v2.5'),
        aiStage: z.literal('ai-stage-policy-v2.10'),
        scheduler: z.literal('ai-scheduler-v1'),
    }).strict(),
    preflightRuns: z.array(run).min(1).max(4),
    providerRuns: z.array(run).min(1).max(128),
}).strict();

const betatestFreePoolSource = currentProductionSource.extend({
    preflightRuns: z.array(run.extend({
        credentialSlot: z.string().regex(/^(?:primary|tertiary|quaternary|quinary|senary|septenary)$/),
    })).min(1).max(4),
    providerRuns: z.array(run.extend({
        credentialSlot: z.string().regex(/^(?:primary|tertiary|quaternary|quinary|senary|septenary)$/),
    })).min(1).max(128),
}).strict();

const testEntitlementLegacySecondarySource = currentProductionSource.extend({
    preflightRuns: z.array(run.extend({
        credentialSlot: z.literal('secondary'),
    })).min(1).max(4),
    providerRuns: z.array(run.extend({
        credentialSlot: z.literal('secondary'),
    })).min(1).max(128),
    sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    currentRevision: z.number().int().min(0).max(999),
    originalFemaleRows: z.array(originalFemaleRow).max(900),
}).strict();
const testEntitlementLegacySecondaryTextOnlySource = testEntitlementLegacySecondarySource.extend({
    canonicalCounts: z.object({ male: z.number().int().nonnegative(), female: z.number().int().nonnegative(), unknown: z.number().int().nonnegative() }).strict(),
}).strict();

export type ReplayCaptureDescriptor = Omit<
    z.infer<typeof source>,
    'selectedPlanId' | 'policyVersions'
> & {
    sourceLineage: ReplaySourceLineage;
    requestFingerprint: string;
};

/** Historical descriptors deliberately carry no stored target identifier. */
export type HistoricalOfficialE2EReplayCaptureDescriptor = ReplayCaptureDescriptor & {
    targetResolution: 'provider_ledger';
};

/** Current production descriptors contain no retained target profile or identifier. */
export type CurrentProductionReplayCaptureDescriptor = Omit<
    ReplayCaptureDescriptor,
    'target'
> & {
    targetResolution: 'provider_ledger';
    sourceKind: 'current_paid_production';
};

/** The opaque target is resolved only from completed, bounded beta-free ledgers. */
export type BetatestFreePoolReplayCaptureDescriptor = Omit<
    ReplayCaptureDescriptor,
    'target'
> & {
    targetResolution: 'provider_ledger';
    sourceKind: 'betatest_free_pool';
};

/** Immutable v2.10 source, explicitly evaluated under the v2.11 maintenance policy. */
export type TestEntitlementLegacySecondaryReplayCaptureDescriptor = Omit<
    ReplayCaptureDescriptor,
    'target'
> & {
    targetResolution: 'provider_ledger';
    sourceKind: 'test_entitlement_v211_legacy_secondary';
    sourceFingerprint: string;
    currentRevision: number;
    originalFemaleRows: readonly z.infer<typeof originalFemaleRow>[];
};
export type TestEntitlementLegacySecondaryTextOnlyReplayCaptureDescriptor = Omit<TestEntitlementLegacySecondaryReplayCaptureDescriptor, 'sourceKind'> & {
    sourceKind: 'test_entitlement_v211_legacy_secondary_text_only';
    canonicalCounts: { male: number; female: number; unknown: number };
};

function normalizedTarget(value: string): string {
    const target = value.trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(target)) {
        throw new Error('ANALYSIS_V2_REPLAY_SOURCE_INVALID');
    }
    return target;
}

export async function loadReplayCaptureDescriptor(
    client: ReplaySourceRpcClient,
    selector: { targetUsername: string; requestId?: string },
): Promise<ReplayCaptureDescriptor> {
    const target = normalizedTarget(selector.targetUsername);
    const requestId = selector.requestId === undefined
        ? null
        : z.string().uuid().parse(selector.requestId);
    const result = await client.rpc('read_analysis_v2_replay_capture_source', {
        p_target_username: target,
        p_request_id: requestId,
    });
    if (result.error) throw new Error('ANALYSIS_V2_REPLAY_EXACT_SOURCE_UNAVAILABLE');
    const sourceResult = source.safeParse(result.data);
    if (!sourceResult.success) {
        throw new Error('ANALYSIS_V2_REPLAY_READ_ONLY_SOURCE_INVALID');
    }
    const parsed = sourceResult.data;
    if (parsed.targetUsername !== target) {
        throw new Error('ANALYSIS_V2_REPLAY_READ_ONLY_SOURCE_INVALID');
    }
    const lineageResult = replaySourceLineageSchema.safeParse({
        selectedPlanId: parsed.selectedPlanId,
        policyVersions: parsed.policyVersions,
    });
    if (!lineageResult.success) {
        throw new Error('ANALYSIS_V2_REPLAY_READ_ONLY_SOURCE_INVALID');
    }
    return {
        requestId: parsed.requestId,
        preflightId: parsed.preflightId,
        targetUsername: parsed.targetUsername,
        target: parsed.target,
        preflightRuns: parsed.preflightRuns,
        providerRuns: parsed.providerRuns,
        sourceLineage: lineageResult.data,
        requestFingerprint: createHash('sha256')
            .update(`analysis-v2-replay-request-v1\n${parsed.requestId}`)
            .digest('hex'),
    };
}

/**
 * Loads the single historical, entitlement-backed source by its required UUID.
 * The returned target is an opaque replay handle, never a request/preflight value.
 */
export async function loadHistoricalOfficialE2EReplayCaptureDescriptor(
    client: HistoricalOfficialE2EReplaySourceRpcClient,
    requestId: string,
): Promise<HistoricalOfficialE2EReplayCaptureDescriptor> {
    const exactRequestId = z.string().uuid().parse(requestId);
    const result = await client.rpc(
        'read_analysis_v2_historical_official_e2e_replay_source',
        { p_request_id: exactRequestId },
    );
    if (result.error) throw new Error('ANALYSIS_V2_REPLAY_EXACT_SOURCE_UNAVAILABLE');
    const parsedResult = historicalOfficialE2ESource.safeParse(result.data);
    if (!parsedResult.success || parsedResult.data.requestId !== exactRequestId) {
        throw new Error('ANALYSIS_V2_REPLAY_READ_ONLY_SOURCE_INVALID');
    }
    const parsed = parsedResult.data;
    const lineageResult = replaySourceLineageSchema.safeParse({
        selectedPlanId: parsed.selectedPlanId,
        policyVersions: parsed.policyVersions,
    });
    if (!lineageResult.success) {
        throw new Error('ANALYSIS_V2_REPLAY_READ_ONLY_SOURCE_INVALID');
    }
    return {
        requestId: parsed.requestId,
        preflightId: parsed.preflightId,
        targetUsername: parsed.targetUsername,
        target: parsed.target,
        preflightRuns: parsed.preflightRuns,
        providerRuns: parsed.providerRuns,
        sourceLineage: lineageResult.data,
        requestFingerprint: createHash('sha256')
            .update(`analysis-v2-replay-request-v1\n${parsed.requestId}`)
            .digest('hex'),
        targetResolution: 'provider_ledger',
    };
}

/**
 * Loads an exact paid production source without accepting or returning its stored target.
 * The opaque target handle is resolved only from the authenticated provider ledger datasets.
 */
export async function loadCurrentProductionReplayCaptureDescriptor(
    client: CurrentProductionReplaySourceRpcClient,
    requestId: string,
): Promise<CurrentProductionReplayCaptureDescriptor> {
    const exactRequestId = z.string().uuid().parse(requestId);
    const result = await client.rpc(
        'read_analysis_v2_current_production_replay_source',
        { p_request_id: exactRequestId },
    );
    if (result.error) throw new Error('ANALYSIS_V2_REPLAY_EXACT_SOURCE_UNAVAILABLE');
    const parsedResult = currentProductionSource.safeParse(result.data);
    if (!parsedResult.success || parsedResult.data.requestId !== exactRequestId) {
        throw new Error('ANALYSIS_V2_REPLAY_READ_ONLY_SOURCE_INVALID');
    }
    const parsed = parsedResult.data;
    const lineageResult = replaySourceLineageSchema.safeParse({
        selectedPlanId: parsed.selectedPlanId,
        policyVersions: parsed.policyVersions,
    });
    if (!lineageResult.success) {
        throw new Error('ANALYSIS_V2_REPLAY_READ_ONLY_SOURCE_INVALID');
    }
    return {
        requestId: parsed.requestId,
        preflightId: parsed.preflightId,
        targetUsername: parsed.targetUsername,
        preflightRuns: parsed.preflightRuns,
        providerRuns: parsed.providerRuns,
        sourceLineage: lineageResult.data,
        requestFingerprint: createHash('sha256')
            .update(`analysis-v2-replay-request-v1\n${parsed.requestId}`)
            .digest('hex'),
        targetResolution: 'provider_ledger',
        sourceKind: 'current_paid_production',
    };
}

export async function loadBetatestFreePoolReplayCaptureDescriptor(
    client: BetatestFreePoolReplaySourceRpcClient,
    requestId: string,
): Promise<BetatestFreePoolReplayCaptureDescriptor> {
    const exactRequestId = z.string().uuid().parse(requestId);
    const result = await client.rpc(
        'read_analysis_v2_betatest_free_pool_replay_source',
        { p_request_id: exactRequestId },
    );
    if (result.error) throw new Error('ANALYSIS_V2_REPLAY_EXACT_SOURCE_UNAVAILABLE');
    const parsedResult = betatestFreePoolSource.safeParse(result.data);
    if (!parsedResult.success || parsedResult.data.requestId !== exactRequestId) {
        throw new Error('ANALYSIS_V2_REPLAY_READ_ONLY_SOURCE_INVALID');
    }
    const parsed = parsedResult.data;
    const lineageResult = replaySourceLineageSchema.safeParse({
        selectedPlanId: parsed.selectedPlanId,
        policyVersions: parsed.policyVersions,
    });
    if (!lineageResult.success) {
        throw new Error('ANALYSIS_V2_REPLAY_READ_ONLY_SOURCE_INVALID');
    }
    return {
        requestId: parsed.requestId,
        preflightId: parsed.preflightId,
        targetUsername: parsed.targetUsername,
        preflightRuns: parsed.preflightRuns,
        providerRuns: parsed.providerRuns,
        sourceLineage: lineageResult.data,
        requestFingerprint: createHash('sha256')
            .update(`analysis-v2-replay-request-v1\n${parsed.requestId}`)
            .digest('hex'),
        targetResolution: 'provider_ledger',
        sourceKind: 'betatest_free_pool',
    };
}

export async function loadTestEntitlementLegacySecondaryReplayCaptureDescriptor(
    client: TestEntitlementLegacySecondaryReplaySourceRpcClient,
    requestId: string,
): Promise<TestEntitlementLegacySecondaryReplayCaptureDescriptor> {
    const exactRequestId = z.string().uuid().parse(requestId);
    const result = await client.rpc(
        'read_analysis_v2_test_entitlement_v211_legacy_secondary_source',
        { p_request_id: exactRequestId },
    );
    if (result.error) throw new Error('ANALYSIS_V2_REPLAY_EXACT_SOURCE_UNAVAILABLE');
    const parsedResult = testEntitlementLegacySecondarySource.safeParse(result.data);
    if (!parsedResult.success || parsedResult.data.requestId !== exactRequestId) {
        throw new Error('ANALYSIS_V2_REPLAY_READ_ONLY_SOURCE_INVALID');
    }
    const parsed = parsedResult.data;
    const lineageResult = replaySourceLineageSchema.safeParse({
        selectedPlanId: parsed.selectedPlanId,
        policyVersions: parsed.policyVersions,
    });
    if (!lineageResult.success) {
        throw new Error('ANALYSIS_V2_REPLAY_READ_ONLY_SOURCE_INVALID');
    }
    return {
        requestId: parsed.requestId,
        preflightId: parsed.preflightId,
        targetUsername: parsed.targetUsername,
        preflightRuns: parsed.preflightRuns,
        providerRuns: parsed.providerRuns,
        sourceLineage: lineageResult.data,
        requestFingerprint: createHash('sha256')
            .update(`analysis-v2-replay-request-v1\n${parsed.requestId}`)
            .digest('hex'),
        targetResolution: 'provider_ledger',
        sourceKind: 'test_entitlement_v211_legacy_secondary',
        sourceFingerprint: parsed.sourceFingerprint,
        currentRevision: parsed.currentRevision,
        originalFemaleRows: parsed.originalFemaleRows,
    };
}

export async function loadTestEntitlementLegacySecondaryTextOnlyReplayCaptureDescriptor(
    client: TestEntitlementLegacySecondaryTextOnlyReplaySourceRpcClient, requestId: string,
): Promise<TestEntitlementLegacySecondaryTextOnlyReplayCaptureDescriptor> {
    const exactRequestId = z.string().uuid().parse(requestId);
    const result = await client.rpc('read_analysis_v2_test_entitlement_v211_text_only_source', { p_request_id: exactRequestId });
    if (result.error) throw new Error('ANALYSIS_V2_REPLAY_EXACT_SOURCE_UNAVAILABLE');
    const parsedResult = testEntitlementLegacySecondaryTextOnlySource.safeParse(result.data);
    if (!parsedResult.success || parsedResult.data.requestId !== exactRequestId) throw new Error('ANALYSIS_V2_REPLAY_READ_ONLY_SOURCE_INVALID');
    const parsed = parsedResult.data;
    // The STABLE source RPC already proves male+female+unknown against the published
    // screened total. This loader independently binds the immutable female-row array.
    if (parsed.canonicalCounts.female !== parsed.originalFemaleRows.length) {
        throw new Error('ANALYSIS_V2_REPLAY_READ_ONLY_SOURCE_INVALID');
    }
    const { canonicalCounts, ...legacySource } = parsed;
    return {
        ...(await loadTestEntitlementLegacySecondaryReplayCaptureDescriptor(
            { rpc: async () => ({ data: legacySource, error: null }) },
            exactRequestId,
        )),
        sourceKind: 'test_entitlement_v211_legacy_secondary_text_only',
        canonicalCounts,
    };
}
