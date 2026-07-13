import { z } from 'zod';
import {
    getAnalysisPlan,
    PLAN_IDS,
    type PlanId,
} from '@/lib/domain/analysis/plan-catalog';
import { supabaseAdmin } from '@/lib/supabase/admin';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,159}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const contextSchema = z.object({
    requestId: z.string().regex(UUID_PATTERN),
    targetUsername: z.string().regex(/^[a-z0-9._]{1,30}$/),
    excludedUsername: z.string().regex(/^[a-z0-9._]{1,30}$/).nullable(),
    planId: z.enum(PLAN_IDS),
    followersDeclaredCount: z.number().int().min(0).max(1_200),
    followingDeclaredCount: z.number().int().min(0).max(1_200),
    detailedMutualLimit: z.union([z.literal(300), z.literal(600), z.literal(900)]),
}).strict();

export interface AnalysisV2CollectionJobClaim {
    requestId: string;
    jobKey: string;
    claimToken: string;
    jobInputHash: string;
}

export interface AnalysisV2CollectionRequestContext {
    requestId: string;
    targetUsername: string;
    excludedUsername: string | null;
    planId: PlanId;
    followersDeclaredCount: number;
    followingDeclaredCount: number;
    detailedMutualLimit: 300 | 600 | 900;
}

export interface AnalysisV2CollectionRequestContextStore {
    load(claim: AnalysisV2CollectionJobClaim): Promise<AnalysisV2CollectionRequestContext>;
}

interface RpcResult {
    data: unknown;
    error: null | { code?: string; message?: string };
}

export interface AnalysisV2CollectionRequestContextSupabaseClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<RpcResult>;
}

export const ANALYSIS_V2_COLLECTION_CONTEXT_DATABASE_NAMES = Object.freeze({
    loadRpc: 'load_analysis_v2_collection_request_context',
});

export class AnalysisV2CollectionContextFenceError extends Error {
    constructor() {
        super('ANALYSIS_V2_COLLECTION_CONTEXT_FENCE_MISMATCH');
        this.name = 'AnalysisV2CollectionContextFenceError';
    }
}

function validateClaim(claim: AnalysisV2CollectionJobClaim): void {
    if (
        !UUID_PATTERN.test(claim.requestId)
        || !JOB_KEY_PATTERN.test(claim.jobKey)
        || !UUID_PATTERN.test(claim.claimToken)
        || !SHA256_PATTERN.test(claim.jobInputHash)
    ) {
        throw new Error('ANALYSIS_V2_COLLECTION_CONTEXT_VALIDATION_ERROR');
    }
}

function safeRpcCode(error: { code?: string }): string {
    return typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'unknown';
}

export function createAnalysisV2CollectionRequestContextStore(
    client: AnalysisV2CollectionRequestContextSupabaseClient = supabaseAdmin
): AnalysisV2CollectionRequestContextStore {
    return {
        async load(claim) {
            validateClaim(claim);
            const { data, error } = await client.rpc(
                ANALYSIS_V2_COLLECTION_CONTEXT_DATABASE_NAMES.loadRpc,
                {
                    p_request_id: claim.requestId.toLowerCase(),
                    p_job_key: claim.jobKey,
                    p_claim_token: claim.claimToken.toLowerCase(),
                    p_job_input_hash: claim.jobInputHash,
                }
            );
            if (error?.message === 'ANALYSIS_V2_COLLECTION_CONTEXT_FENCE_MISMATCH') {
                throw new AnalysisV2CollectionContextFenceError();
            }
            if (error) {
                throw new Error(
                    `ANALYSIS_V2_COLLECTION_CONTEXT_PERSISTENCE_ERROR (${safeRpcCode(error)})`
                );
            }
            const parsed = contextSchema.safeParse(
                Array.isArray(data) && data.length === 1 ? data[0] : data
            );
            if (!parsed.success || parsed.data.requestId !== claim.requestId.toLowerCase()) {
                throw new Error('ANALYSIS_V2_COLLECTION_CONTEXT_PERSISTENCE_ERROR: invalid result.');
            }
            const plan = getAnalysisPlan(parsed.data.planId);
            if (
                parsed.data.detailedMutualLimit !== plan.detailedMutualLimit
                || parsed.data.followersDeclaredCount > plan.relationshipCapacity.followers
                || parsed.data.followingDeclaredCount > plan.relationshipCapacity.following
                || parsed.data.excludedUsername === parsed.data.targetUsername
            ) {
                throw new Error('ANALYSIS_V2_COLLECTION_CONTEXT_PERSISTENCE_ERROR: snapshot drift.');
            }
            return Object.freeze(parsed.data);
        },
    };
}

export const analysisV2CollectionRequestContextStore =
    createAnalysisV2CollectionRequestContextStore();
