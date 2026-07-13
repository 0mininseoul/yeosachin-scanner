import { z } from 'zod';
import { PLAN_IDS } from '@/lib/domain/analysis/plan-catalog';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    buildAnalysisV2DagPlan,
    type AnalysisV2DagBatchResultManifest,
    type AnalysisV2DagFinalScoreManifest,
    type AnalysisV2DagNarrativeManifest,
    type AnalysisV2DagPrimaryJoinResultManifest,
    type AnalysisV2DagRelationshipManifest,
    type AnalysisV2DagScreeningManifest,
    type AnalysisV2DagShortlistResultManifest,
    type AnalysisV2DagState,
    type AnalysisV2DagTargetEvidenceManifest,
} from './v2-dag-planner';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,159}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const ANALYSIS_V2_DAG_STATE_DATABASE_NAMES = Object.freeze({
    scopeTable: 'analysis_v2_dag_scopes',
    stageManifestTable: 'analysis_v2_dag_stage_manifests',
    batchTopologyTable: 'analysis_v2_dag_batch_topology',
    batchResultTable: 'analysis_v2_dag_batch_results',
    initializeScopeRpc: 'initialize_analysis_v2_dag_scope',
    checkpointManifestRpc: 'checkpoint_analysis_v2_dag_manifest',
    loadStateRpc: 'load_analysis_v2_dag_state',
});

export const ANALYSIS_V2_DAG_MANIFEST_KINDS = [
    'relationships',
    'target_evidence',
    'profile_fetch_batch',
    'profile_ai_batch',
    'private_name_batch',
    'primary_join',
    'screening',
    'reverse_likes',
    'partner_safety',
    'final_score',
    'narrative',
] as const;

export type AnalysisV2DagManifestKind = typeof ANALYSIS_V2_DAG_MANIFEST_KINDS[number];

export interface AnalysisV2DagStateJobClaim {
    requestId: string;
    jobKey: string;
    inputHash: string;
    claimToken: string;
}

export interface AnalysisV2DagScopeInitialization extends AnalysisV2DagStateJobClaim {
    jobKey: 'coordinator:bootstrap';
}

export type AnalysisV2DagManifestCheckpoint =
    | Readonly<{ kind: 'relationships'; manifest: AnalysisV2DagRelationshipManifest }>
    | Readonly<{ kind: 'target_evidence'; manifest: AnalysisV2DagTargetEvidenceManifest }>
    | Readonly<{
        kind: 'profile_fetch_batch' | 'profile_ai_batch' | 'private_name_batch';
        manifest: AnalysisV2DagBatchResultManifest;
    }>
    | Readonly<{ kind: 'primary_join'; manifest: AnalysisV2DagPrimaryJoinResultManifest }>
    | Readonly<{ kind: 'screening'; manifest: AnalysisV2DagScreeningManifest }>
    | Readonly<{
        kind: 'reverse_likes' | 'partner_safety';
        manifest: AnalysisV2DagShortlistResultManifest;
    }>
    | Readonly<{
        kind: 'final_score';
        manifest: AnalysisV2DagFinalScoreManifest;
    }>
    | Readonly<{ kind: 'narrative'; manifest: AnalysisV2DagNarrativeManifest }>;

export interface AnalysisV2DagStateStore {
    initializeScope(input: AnalysisV2DagScopeInitialization): Promise<AnalysisV2DagState>;
    checkpointManifest(
        claim: AnalysisV2DagStateJobClaim,
        checkpoint: AnalysisV2DagManifestCheckpoint
    ): Promise<AnalysisV2DagState>;
    load(requestId: string): Promise<AnalysisV2DagState | null>;
}

interface RpcError {
    code?: string;
    message?: string;
}

interface RpcResult {
    data: unknown;
    error: RpcError | null;
}

export interface AnalysisV2DagStateSupabaseClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<RpcResult>;
}

export class AnalysisV2DagStateFenceError extends Error {
    constructor() {
        super('ANALYSIS_V2_DAG_STATE_FENCE_MISMATCH');
        this.name = 'AnalysisV2DagStateFenceError';
    }
}

export class AnalysisV2DagStateConflictError extends Error {
    constructor() {
        super('ANALYSIS_V2_DAG_STATE_CONFLICT');
        this.name = 'AnalysisV2DagStateConflictError';
    }
}

export class AnalysisV2DagScopeMissingError extends Error {
    constructor() {
        super('ANALYSIS_V2_DAG_SCOPE_MISSING');
        this.name = 'AnalysisV2DagScopeMissingError';
    }
}

const hashSchema = z.string().regex(SHA256_PATTERN);
const resultManifestSchema = z.object({
    revision: z.number().int().min(1).max(1_000_000),
    resultHash: hashSchema,
}).strict();
const topologyBatchSchema = z.object({
    batch: z.number().int().min(0).max(100_000),
    itemCount: z.number().int().min(1).max(100),
    inputHash: hashSchema,
}).strict();
const batchResultSchema = resultManifestSchema.extend({
    batch: z.number().int().min(0).max(100_000),
    itemCount: z.number().int().min(1).max(100),
    producerInputHash: hashSchema,
}).strict();
const relationshipsSchema = resultManifestSchema.extend({
    detectedMutualCount: z.number().int().min(0).max(1_200),
    publicCount: z.number().int().min(0).max(1_200),
    privateCount: z.number().int().min(0).max(1_200),
    detailedSelectedPublicCount: z.number().int().min(0).max(900),
    notScreenedPublicCount: z.number().int().min(0).max(1_200),
    profileBatches: z.array(topologyBatchSchema).max(30),
    privateNameBatches: z.array(topologyBatchSchema).max(12),
}).strict();
const targetEvidenceSchema = resultManifestSchema.extend({
    interactorCount: z.number().int().min(0).max(690),
}).strict();
const primaryJoinSchema = resultManifestSchema.extend({
    verifiedFemaleCount: z.number().int().min(0).max(900),
}).strict();
const screeningSchema = primaryJoinSchema.extend({
    shortlistCount: z.number().int().min(0).max(10),
    shortlistHash: hashSchema,
}).strict();
const shortlistSchema = resultManifestSchema.extend({
    shortlistCount: z.number().int().min(0).max(10),
}).strict();
const finalScoreSchema = resultManifestSchema.extend({
    featuredHighRiskCount: z.number().int().min(0).max(3),
    narrativeCount: z.number().int().min(0).max(3),
    narrativeBatchHash: hashSchema,
}).strict();
const narrativeSchema = resultManifestSchema.extend({
    narrativeCount: z.number().int().min(0).max(3),
}).strict();

const dagStateSchema = z.object({
    schemaVersion: z.literal(2),
    requestSnapshotHash: hashSchema,
    planId: z.enum(PLAN_IDS),
    planSnapshotHash: hashSchema,
    girlfriendExclusion: z.object({
        decisionHash: hashSchema,
        excludedCount: z.union([z.literal(0), z.literal(1)]),
    }).strict(),
    relationships: relationshipsSchema.optional(),
    targetEvidence: targetEvidenceSchema.optional(),
    profileFetchBatches: z.array(batchResultSchema).max(30).optional(),
    profileAiBatches: z.array(batchResultSchema).max(30).optional(),
    privateNameBatches: z.array(batchResultSchema).max(12).optional(),
    primaryJoin: primaryJoinSchema.optional(),
    screening: screeningSchema.optional(),
    reverseLikes: shortlistSchema.optional(),
    partnerSafety: shortlistSchema.optional(),
    finalScore: finalScoreSchema.optional(),
    narrative: narrativeSchema.optional(),
}).strict();

function validateClaim(input: AnalysisV2DagStateJobClaim): AnalysisV2DagStateJobClaim {
    if (
        !UUID_PATTERN.test(input.requestId)
        || !UUID_PATTERN.test(input.claimToken)
        || !JOB_KEY_PATTERN.test(input.jobKey)
        || !SHA256_PATTERN.test(input.inputHash)
    ) {
        throw new Error('ANALYSIS_V2_DAG_STATE_VALIDATION_ERROR: invalid job claim.');
    }
    return {
        requestId: input.requestId.toLowerCase(),
        jobKey: input.jobKey,
        inputHash: input.inputHash,
        claimToken: input.claimToken.toLowerCase(),
    };
}

function safeRpcCode(error: RpcError): string {
    return typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'unknown';
}

function throwRpcError(error: RpcError, operation: string): never {
    if (error.message === 'ANALYSIS_V2_DAG_STATE_FENCE_MISMATCH') {
        throw new AnalysisV2DagStateFenceError();
    }
    if (error.message === 'ANALYSIS_V2_DAG_STATE_CONFLICT') {
        throw new AnalysisV2DagStateConflictError();
    }
    if (error.message === 'ANALYSIS_V2_DAG_SCOPE_MISSING') {
        throw new AnalysisV2DagScopeMissingError();
    }
    throw new Error(
        `ANALYSIS_V2_DAG_STATE_PERSISTENCE_ERROR: ${operation} failed (${safeRpcCode(error)}).`
    );
}

function rpcPayload(data: unknown, label: string): unknown {
    if (Array.isArray(data)) {
        if (data.length !== 1) {
            throw new Error(`ANALYSIS_V2_DAG_STATE_PERSISTENCE_ERROR: invalid ${label} result.`);
        }
        return data[0];
    }
    return data;
}

function canonicalState(requestId: string, value: unknown): AnalysisV2DagState {
    const parsed = dagStateSchema.safeParse(rpcPayload(value, 'state'));
    if (!parsed.success) {
        throw new Error('ANALYSIS_V2_DAG_STATE_PERSISTENCE_ERROR: invalid state result.');
    }
    const state = parsed.data as AnalysisV2DagState;
    try {
        buildAnalysisV2DagPlan(requestId, state);
    } catch {
        throw new Error('ANALYSIS_V2_DAG_STATE_PERSISTENCE_ERROR: inconsistent state result.');
    }
    return deepFreeze(state);
}

function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.values(value as Record<string, unknown>).forEach(deepFreeze);
        Object.freeze(value);
    }
    return value;
}

function checkpointPayload(checkpoint: AnalysisV2DagManifestCheckpoint): unknown {
    if (
        checkpoint.kind === 'profile_fetch_batch'
        || checkpoint.kind === 'profile_ai_batch'
        || checkpoint.kind === 'private_name_batch'
    ) {
        return batchResultSchema.parse(checkpoint.manifest);
    }
    switch (checkpoint.kind) {
        case 'relationships': return relationshipsSchema.parse(checkpoint.manifest);
        case 'target_evidence': return targetEvidenceSchema.parse(checkpoint.manifest);
        case 'primary_join': return primaryJoinSchema.parse(checkpoint.manifest);
        case 'screening': return screeningSchema.parse(checkpoint.manifest);
        case 'reverse_likes':
        case 'partner_safety': return shortlistSchema.parse(checkpoint.manifest);
        case 'final_score': return finalScoreSchema.parse(checkpoint.manifest);
        case 'narrative': return narrativeSchema.parse(checkpoint.manifest);
    }
}

export function createSupabaseAnalysisV2DagStateStore(
    client: AnalysisV2DagStateSupabaseClient = supabaseAdmin
): AnalysisV2DagStateStore {
    return {
        async initializeScope(input) {
            const claim = validateClaim(input);
            if (claim.jobKey !== 'coordinator:bootstrap') {
                throw new Error(
                    'ANALYSIS_V2_DAG_STATE_VALIDATION_ERROR: scope requires bootstrap job.'
                );
            }
            const { data, error } = await client.rpc(
                ANALYSIS_V2_DAG_STATE_DATABASE_NAMES.initializeScopeRpc,
                {
                    p_request_id: claim.requestId,
                    p_job_key: claim.jobKey,
                    p_input_hash: claim.inputHash,
                    p_claim_token: claim.claimToken,
                }
            );
            if (error) throwRpcError(error, 'scope initialization');
            return canonicalState(claim.requestId, data);
        },

        async checkpointManifest(input, checkpoint) {
            const claim = validateClaim(input);
            const manifest = checkpointPayload(checkpoint);
            if (
                (
                    checkpoint.kind === 'profile_fetch_batch'
                    || checkpoint.kind === 'profile_ai_batch'
                    || checkpoint.kind === 'private_name_batch'
                )
                && (manifest as AnalysisV2DagBatchResultManifest).producerInputHash
                    !== claim.inputHash
            ) {
                throw new Error(
                    'ANALYSIS_V2_DAG_STATE_VALIDATION_ERROR: producer input hash mismatch.'
                );
            }
            const { data, error } = await client.rpc(
                ANALYSIS_V2_DAG_STATE_DATABASE_NAMES.checkpointManifestRpc,
                {
                    p_request_id: claim.requestId,
                    p_job_key: claim.jobKey,
                    p_input_hash: claim.inputHash,
                    p_claim_token: claim.claimToken,
                    p_manifest_kind: checkpoint.kind,
                    p_manifest: manifest,
                }
            );
            if (error) throwRpcError(error, 'manifest checkpoint');
            return canonicalState(claim.requestId, data);
        },

        async load(requestId) {
            if (!UUID_PATTERN.test(requestId)) {
                throw new Error('ANALYSIS_V2_DAG_STATE_VALIDATION_ERROR: invalid request id.');
            }
            const normalizedRequestId = requestId.toLowerCase();
            const { data, error } = await client.rpc(
                ANALYSIS_V2_DAG_STATE_DATABASE_NAMES.loadStateRpc,
                { p_request_id: normalizedRequestId }
            );
            if (error) throwRpcError(error, 'state load');
            const payload = rpcPayload(data, 'state load');
            return payload === null ? null : canonicalState(normalizedRequestId, payload);
        },
    };
}
