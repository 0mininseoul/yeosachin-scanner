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

const run = z.object({
    actorId: z.string().min(3).max(200),
    credentialSlot: z.string().regex(/^(?:primary|secondary|tertiary|quaternary|quinary|senary)$/),
    runId: z.string().regex(/^[A-Za-z0-9]{8,64}$/),
    status: z.literal('succeeded'),
    operationKey: z.string().min(1).max(100),
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
