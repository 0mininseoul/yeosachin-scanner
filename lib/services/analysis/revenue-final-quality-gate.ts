import 'server-only';

import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type {
    AnalysisV2CollectionJobClaim,
    AnalysisV2CollectionRequestContext,
    AnalysisV2CollectionRequestContextStore,
} from './v2-request-context';
import { analysisV2CollectionRequestContextStore } from './v2-request-context';

const coverageInputSchema = z.object({
    requestId: z.string().uuid(),
    jobKey: z.literal('coordinator:finalize'),
    claimToken: z.string().uuid(),
    jobInputHash: z.string().regex(/^[a-f0-9]{64}$/),
    publicMutualCount: z.number().int().min(0).max(900),
    screenedCount: z.number().int().min(0).max(900),
    notScreenedCount: z.number().int().min(0).max(900),
    unknownBurdenCount: z.number().int().min(0).max(900),
    /** False means the runtime observed an impossible persisted cohort shape. */
    coverageValid: z.boolean().optional().default(true),
}).strict();

const finalizerClaimSchema = z.object({
    requestId: z.string().uuid(),
    jobKey: z.literal('coordinator:finalize'),
    claimToken: z.string().uuid(),
    jobInputHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const outcomeSchema = z.object({
    disposition: z.enum(['accepted', 'manual_review']),
    created: z.boolean(),
    replayed: z.boolean(),
}).strict();

export interface AnalysisV2RevenueFinalQualityGateRpcClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: { code?: string; message?: string } | null;
    }>;
}

export interface AnalysisV2RevenueFinalQualityGate {
    /**
     * This inexpensive lineage probe must run before an executor reads final
     * profile outcomes.  It deliberately performs no revenue mutation.
     */
    isApplicable(input: AnalysisV2RevenueFinalQualityGateClaim): Promise<boolean>;
    /**
     * Finalizer-only verification of the primary-join durable quality record.
     * It deliberately accepts no outcome rows, coverage arithmetic, or model
     * inputs: those were frozen before screening.
     */
    verify(input: AnalysisV2RevenueFinalQualityGateClaim): Promise<'approved' | 'manual_review'>;
    /**
     * Backward-compatible direct coverage recorder retained for focused
     * lifecycle/fence tests. The production executor uses `verify` instead.
     */
    evaluate(input: AnalysisV2RevenueFinalQualityGateInput): Promise<
        'approved' | 'not_applicable' | 'manual_review'
    >;
}

export type AnalysisV2RevenueFinalQualityGateInput = z.input<typeof coverageInputSchema>;
export type AnalysisV2RevenueFinalQualityGateClaim = z.input<typeof finalizerClaimSchema>;

export class AnalysisV2RevenueFinalQualityGateError extends Error {
    constructor(message = 'ANALYSIS_V2_REVENUE_FINAL_QUALITY_GATE_FAILED') {
        super(message);
        this.name = 'AnalysisV2RevenueFinalQualityGateError';
    }
}

function isStrictRevenueLineage(context: AnalysisV2CollectionRequestContext): boolean {
    return context.accessMode === 'test_entitlement'
        && (context.planId === 'basic' || context.planId === 'standard')
        && context.providerExecutionPolicy?.mode === 'test_operation_split'
        && context.providerExecutionPolicy.policyVersion === 'authorized-free-e2e-v1';
}

function parseOutcome(data: unknown): z.infer<typeof outcomeSchema> {
    const parsed = outcomeSchema.safeParse(
        Array.isArray(data) && data.length === 1 ? data[0] : data,
    );
    if (!parsed.success) {
        throw new AnalysisV2RevenueFinalQualityGateError(
            'ANALYSIS_V2_REVENUE_FINAL_QUALITY_GATE_PERSISTENCE_ERROR',
        );
    }
    return parsed.data;
}

export function createAnalysisV2RevenueFinalQualityGate(options: {
    contextStore?: AnalysisV2CollectionRequestContextStore;
    client?: AnalysisV2RevenueFinalQualityGateRpcClient;
} = {}): AnalysisV2RevenueFinalQualityGate {
    const contextStore = options.contextStore ?? analysisV2CollectionRequestContextStore;
    const client = options.client ?? supabaseAdmin;

    return {
        async isApplicable(input) {
            const parsed = finalizerClaimSchema.safeParse(input);
            if (!parsed.success) {
                throw new AnalysisV2RevenueFinalQualityGateError(
                    'ANALYSIS_V2_REVENUE_FINAL_QUALITY_GATE_INVALID_INPUT',
                );
            }
            const context = await contextStore.load(parsed.data);
            return isStrictRevenueLineage(context);
        },
        async verify(input) {
            const parsed = finalizerClaimSchema.safeParse(input);
            if (!parsed.success) {
                throw new AnalysisV2RevenueFinalQualityGateError(
                    'ANALYSIS_V2_REVENUE_FINAL_QUALITY_GATE_INVALID_INPUT',
                );
            }
            const context = await contextStore.load(parsed.data);
            if (!isStrictRevenueLineage(context)) return 'manual_review';
            const { data, error } = await client.rpc(
                'verify_analysis_revenue_final_coverage_gate_v1',
                {
                    p_request_id: parsed.data.requestId.toLowerCase(),
                    p_job_key: parsed.data.jobKey,
                    p_job_claim_token: parsed.data.claimToken.toLowerCase(),
                    p_job_input_hash: parsed.data.jobInputHash,
                },
            );
            if (error) {
                throw new AnalysisV2RevenueFinalQualityGateError(
                    'ANALYSIS_V2_REVENUE_FINAL_QUALITY_GATE_PERSISTENCE_ERROR',
                );
            }
            const outcome = parseOutcome(data);
            return outcome.disposition === 'accepted'
                ? 'approved' as const
                : 'manual_review' as const;
        },
        async evaluate(input) {
            const parsed = coverageInputSchema.safeParse(input);
            if (!parsed.success) {
                throw new AnalysisV2RevenueFinalQualityGateError(
                    'ANALYSIS_V2_REVENUE_FINAL_QUALITY_GATE_INVALID_INPUT',
                );
            }
            const claim: AnalysisV2CollectionJobClaim = finalizerClaimSchema.parse({
                requestId: parsed.data.requestId,
                jobKey: parsed.data.jobKey,
                claimToken: parsed.data.claimToken,
                jobInputHash: parsed.data.jobInputHash,
            });
            const context = await contextStore.load(claim);
            if (!isStrictRevenueLineage(context)) return 'not_applicable';

            const { data, error } = await client.rpc(
                'record_analysis_revenue_coverage_gate_v1',
                {
                    p_request_id: parsed.data.requestId.toLowerCase(),
                    p_job_key: parsed.data.jobKey,
                    p_job_claim_token: parsed.data.claimToken.toLowerCase(),
                    p_job_input_hash: parsed.data.jobInputHash,
                    p_public_mutual_count: parsed.data.publicMutualCount,
                    p_screened_count: parsed.data.screenedCount,
                    p_not_screened_count: parsed.data.notScreenedCount,
                    p_unknown_burden_count: parsed.data.unknownBurdenCount,
                    p_coverage_valid: parsed.data.coverageValid,
                },
            );
            if (error) {
                throw new AnalysisV2RevenueFinalQualityGateError(
                    'ANALYSIS_V2_REVENUE_FINAL_QUALITY_GATE_PERSISTENCE_ERROR',
                );
            }
            const outcome = parseOutcome(data);
            if (outcome.disposition === 'manual_review') {
                throw new AnalysisV2RevenueFinalQualityGateError();
            }
            return 'approved';
        },
    };
}
