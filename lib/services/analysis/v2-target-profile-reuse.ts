import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    APIFY_PROFILE_ACTOR_ID,
    APIFY_PROFILE_SUMMARY_MAX_CHARGE_USD,
} from '@/lib/services/instagram/providers/apify';
import {
    APIFY_CREDENTIAL_SLOTS,
    type ApifyCredentialSlot,
} from '@/lib/services/instagram/providers/types';
import { preflightTargetInputHash } from './preflight-identity';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9]{8,64}$/;
const TARGET_JOB_KEY = 'track:target-evidence:collect' as const;

const chargeSchema = z.union([
    z.literal(APIFY_PROFILE_SUMMARY_MAX_CHARGE_USD),
    z.literal('0.002600000000'),
    z.literal('0.0026'),
]).transform(
    (): typeof APIFY_PROFILE_SUMMARY_MAX_CHARGE_USD => APIFY_PROFILE_SUMMARY_MAX_CHARGE_USD
);

const reusableRunSchema = z.object({
    runId: z.string().regex(RUN_ID_PATTERN),
    inputHash: z.string().regex(SHA256_PATTERN),
    actorId: z.literal(APIFY_PROFILE_ACTOR_ID),
    credentialSlot: z.enum(APIFY_CREDENTIAL_SLOTS),
    maxChargeUsd: chargeSchema,
}).strict();

export const ANALYSIS_V2_TARGET_PROFILE_REUSE_DATABASE_NAMES = Object.freeze({
    loadRpc: 'load_analysis_v2_reusable_target_profile_run',
});

export interface AnalysisV2ReusableTargetProfileRun {
    runId: string;
    inputHash: string;
    logicalProvider: 'apify';
    actorId: typeof APIFY_PROFILE_ACTOR_ID;
    credentialSlot: ApifyCredentialSlot;
    maxChargeUsd: typeof APIFY_PROFILE_SUMMARY_MAX_CHARGE_USD;
}

export interface AnalysisV2TargetProfileReuseLoadInput {
    requestId: string;
    jobKey: string;
    claimToken: string;
    jobInputHash: string;
    targetUsername: string;
}

export interface AnalysisV2TargetProfileReuseStore {
    load(input: AnalysisV2TargetProfileReuseLoadInput):
        Promise<AnalysisV2ReusableTargetProfileRun | null>;
}

interface RpcResult {
    data: unknown;
    error: null | { code?: string; message?: string };
}

export interface AnalysisV2TargetProfileReuseSupabaseClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<RpcResult>;
}

function safeRpcCode(error: { code?: string }): string {
    return typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'unknown';
}

function validateInput(input: AnalysisV2TargetProfileReuseLoadInput): void {
    if (
        !UUID_PATTERN.test(input.requestId)
        || input.jobKey !== TARGET_JOB_KEY
        || !UUID_PATTERN.test(input.claimToken)
        || !SHA256_PATTERN.test(input.jobInputHash)
        || !/^[a-z0-9._]{1,30}$/.test(input.targetUsername)
    ) {
        throw new Error('ANALYSIS_V2_TARGET_PROFILE_REUSE_VALIDATION_ERROR');
    }
}

export function createAnalysisV2TargetProfileReuseStore(
    client: AnalysisV2TargetProfileReuseSupabaseClient = supabaseAdmin,
    env: Record<string, string | undefined> = process.env
): AnalysisV2TargetProfileReuseStore {
    return {
        async load(input) {
            validateInput(input);
            const expectedInputHash = preflightTargetInputHash(input.targetUsername, env);
            const { data, error } = await client.rpc(
                ANALYSIS_V2_TARGET_PROFILE_REUSE_DATABASE_NAMES.loadRpc,
                {
                    p_request_id: input.requestId.toLowerCase(),
                    p_job_key: input.jobKey,
                    p_claim_token: input.claimToken.toLowerCase(),
                    p_job_input_hash: input.jobInputHash,
                }
            );
            if (error) {
                throw new Error(
                    `ANALYSIS_V2_TARGET_PROFILE_REUSE_PERSISTENCE_ERROR (${safeRpcCode(error)})`
                );
            }
            if (data === null) return null;
            const parsed = reusableRunSchema.safeParse(data);
            if (!parsed.success || parsed.data.inputHash !== expectedInputHash) {
                throw new Error(
                    'ANALYSIS_V2_TARGET_PROFILE_REUSE_PERSISTENCE_ERROR: invalid descriptor.'
                );
            }
            return Object.freeze({
                ...parsed.data,
                logicalProvider: 'apify' as const,
            });
        },
    };
}

export const analysisV2TargetProfileReuseStore =
    createAnalysisV2TargetProfileReuseStore();
