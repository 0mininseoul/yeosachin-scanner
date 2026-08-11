import 'server-only';

import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type {
    AnalysisV2CollectionJobClaim,
    AnalysisV2CollectionRequestContext,
    AnalysisV2CollectionRequestContextStore,
} from './v2-request-context';
import { analysisV2CollectionRequestContextStore } from './v2-request-context';

const claimSchema = z.object({
    requestId: z.string().uuid(),
    // Resolver work is deliberately owned by the primary-join checkpoint.
    // It runs after every profile-AI batch is durable and before screening,
    // so neither eager profile work nor the finalizer can create new model
    // spend for a strict revenue cohort.
    jobKey: z.literal('coordinator:join:primary-evidence'),
    claimToken: z.string().uuid(),
    jobInputHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const operationKeySchema = z.string().regex(/^gender-resolution:[a-f0-9]{64}$/);
const passInputSchema = z.object({
    planHash: z.string().regex(/^[a-f0-9]{64}$/),
    screenedCount: z.number().int().min(1).max(900),
    unknownBurdenCount: z.number().int().min(1).max(900),
}).strict().superRefine((value, context) => {
    if (value.unknownBurdenCount > value.screenedCount
        || value.unknownBurdenCount * 10 <= value.screenedCount * 3) {
        context.addIssue({
            code: 'custom',
            message: 'A revenue resolver pass requires an above-threshold unknown burden.',
        });
    }
});
const outcomeSchema = z.object({
    disposition: z.enum(['accepted', 'capacity_skipped']),
    created: z.boolean(),
    replayed: z.boolean(),
}).strict().superRefine((outcome, context) => {
    if (outcome.created === outcome.replayed) {
        context.addIssue({
            code: 'custom',
            message: 'A resolver capacity response must be created or replayed exactly once.',
        });
    }
});
const passOutcomeSchema = z.object({
    disposition: z.enum(['accepted', 'manual_review']),
    created: z.boolean(),
    replayed: z.boolean(),
}).strict().superRefine((outcome, context) => {
    if (outcome.created === outcome.replayed) {
        context.addIssue({
            code: 'custom',
            message: 'A resolver-pass response must be created or replayed exactly once.',
        });
    }
});
const completionInputSchema = z.object({
    publicMutualCount: z.number().int().min(0).max(900),
    screenedCount: z.number().int().min(0).max(900),
    notScreenedCount: z.number().int().min(0).max(900),
    initialUnknownBurdenCount: z.number().int().min(0).max(900),
    finalUnknownBurdenCount: z.number().int().min(0).max(900),
    coverageValid: z.boolean(),
    resolverPassStarted: z.boolean(),
}).strict().superRefine((value, context) => {
    if (
        value.initialUnknownBurdenCount > value.screenedCount
        || value.finalUnknownBurdenCount > value.screenedCount
        || value.screenedCount + value.notScreenedCount !== value.publicMutualCount
        || (value.publicMutualCount > 0 && value.screenedCount === 0)
    ) {
        context.addIssue({
            code: 'custom',
            message: 'Primary revenue coverage counts are inconsistent.',
        });
    }
    if (
        value.resolverPassStarted !== (
            value.initialUnknownBurdenCount * 10 > value.screenedCount * 3
        )
    ) {
        context.addIssue({
            code: 'custom',
            message: 'Resolver-pass state must match the initial exact integer threshold.',
        });
    }
});

export interface AnalysisV2RevenueResolverCapacityRpcClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: { code?: string; message?: string } | null;
    }>;
}

export interface AnalysisV2RevenueResolverCapacityAdmission {
    /** Immutable Basic/Standard plan-scoped resolver budget. */
    readonly capacityLimit: 20 | 40;
    /**
     * Records the one eligible primary-join pass before any resolver boundary.
     * Replays retain the immutable plan hash and resume its already-admitted
     * operation identities without consuming a new request budget.
     */
    begin(input: AnalysisV2RevenueResolverPassInput): Promise<'accepted'>;
    reserve(operationKey: string): Promise<'accepted' | 'capacity_skipped'>;
    /**
     * Persists the post-pass effective coverage before screening consumes the
     * resolver-adjusted membership.  This is idempotent across recovery.
     */
    complete(input: AnalysisV2RevenuePrimaryQualityInput): Promise<'approved' | 'manual_review'>;
}

export type AnalysisV2RevenueResolverPassInput = z.input<typeof passInputSchema>;
export type AnalysisV2RevenuePrimaryQualityInput = z.input<typeof completionInputSchema>;

export interface AnalysisV2RevenueResolverCapacity {
    /**
     * Loads the request snapshot only after the executor has observed the
     * immutable strict relationship-selection marker. Null means this is not
     * the exact Basic/Standard test-entitlement runner lineage.
     */
    bind(
        claim: AnalysisV2CollectionJobClaim,
    ): Promise<AnalysisV2RevenueResolverCapacityAdmission | null>;
}

export class AnalysisV2RevenueResolverCapacityError extends Error {
    constructor(message = 'ANALYSIS_V2_REVENUE_RESOLVER_CAPACITY_PERSISTENCE_ERROR') {
        super(message);
        this.name = 'AnalysisV2RevenueResolverCapacityError';
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
    if (!parsed.success) throw new AnalysisV2RevenueResolverCapacityError();
    return parsed.data;
}

function parsePassOutcome(data: unknown): z.infer<typeof passOutcomeSchema> {
    const parsed = passOutcomeSchema.safeParse(
        Array.isArray(data) && data.length === 1 ? data[0] : data,
    );
    if (!parsed.success) throw new AnalysisV2RevenueResolverCapacityError();
    return parsed.data;
}

export function createAnalysisV2RevenueResolverCapacity(options: {
    contextStore?: AnalysisV2CollectionRequestContextStore;
    client?: AnalysisV2RevenueResolverCapacityRpcClient;
} = {}): AnalysisV2RevenueResolverCapacity {
    const contextStore = options.contextStore ?? analysisV2CollectionRequestContextStore;
    const client = options.client ?? supabaseAdmin;

    return {
        async bind(claim) {
            const parsedClaim = claimSchema.safeParse(claim);
            if (!parsedClaim.success) {
                throw new AnalysisV2RevenueResolverCapacityError(
                    'ANALYSIS_V2_REVENUE_RESOLVER_CAPACITY_INVALID_INPUT',
                );
            }
            const context = await contextStore.load(parsedClaim.data);
            if (!isStrictRevenueLineage(context)) return null;

            const capacityLimit = context.planId === 'basic' ? 20 : 40;
            return {
                capacityLimit,
                async begin(input) {
                    if (parsedClaim.data.jobKey !== 'coordinator:join:primary-evidence') {
                        throw new AnalysisV2RevenueResolverCapacityError(
                            'ANALYSIS_V2_REVENUE_RESOLVER_CAPACITY_INVALID_INPUT',
                        );
                    }
                    const parsedPass = passInputSchema.safeParse(input);
                    if (!parsedPass.success) {
                        throw new AnalysisV2RevenueResolverCapacityError(
                            'ANALYSIS_V2_REVENUE_RESOLVER_CAPACITY_INVALID_INPUT',
                        );
                    }
                    const { data, error } = await client.rpc(
                        'begin_analysis_revenue_resolver_pass_v1',
                        {
                            p_request_id: parsedClaim.data.requestId.toLowerCase(),
                            p_job_key: parsedClaim.data.jobKey,
                            p_job_claim_token: parsedClaim.data.claimToken.toLowerCase(),
                            p_job_input_hash: parsedClaim.data.jobInputHash,
                            p_plan_hash: parsedPass.data.planHash,
                            p_screened_count: parsedPass.data.screenedCount,
                            p_unknown_burden_count: parsedPass.data.unknownBurdenCount,
                        },
                    );
                    if (error) throw new AnalysisV2RevenueResolverCapacityError();
                    const outcome = parsePassOutcome(data);
                    if (outcome.disposition !== 'accepted') {
                        throw new AnalysisV2RevenueResolverCapacityError(
                            'ANALYSIS_V2_REVENUE_RESOLVER_CAPACITY_MANUAL_REVIEW',
                        );
                    }
                    return 'accepted' as const;
                },
                async reserve(operationKey) {
                    if (parsedClaim.data.jobKey !== 'coordinator:join:primary-evidence') {
                        throw new AnalysisV2RevenueResolverCapacityError(
                            'ANALYSIS_V2_REVENUE_RESOLVER_CAPACITY_INVALID_INPUT',
                        );
                    }
                    if (!operationKeySchema.safeParse(operationKey).success) {
                        throw new AnalysisV2RevenueResolverCapacityError(
                            'ANALYSIS_V2_REVENUE_RESOLVER_CAPACITY_INVALID_INPUT',
                        );
                    }
                    const { data, error } = await client.rpc(
                        'reserve_analysis_revenue_resolver_capacity_v1',
                        {
                            p_request_id: parsedClaim.data.requestId.toLowerCase(),
                            p_job_key: parsedClaim.data.jobKey,
                            p_job_claim_token: parsedClaim.data.claimToken.toLowerCase(),
                            p_job_input_hash: parsedClaim.data.jobInputHash,
                            p_operation_key: operationKey,
                        },
                    );
                    if (error) throw new AnalysisV2RevenueResolverCapacityError();
                    return parseOutcome(data).disposition;
                },
                async complete(input) {
                    if (parsedClaim.data.jobKey !== 'coordinator:join:primary-evidence') {
                        throw new AnalysisV2RevenueResolverCapacityError(
                            'ANALYSIS_V2_REVENUE_RESOLVER_CAPACITY_INVALID_INPUT',
                        );
                    }
                    const parsedCompletion = completionInputSchema.safeParse(input);
                    if (!parsedCompletion.success) {
                        throw new AnalysisV2RevenueResolverCapacityError(
                            'ANALYSIS_V2_REVENUE_RESOLVER_CAPACITY_INVALID_INPUT',
                        );
                    }
                    const { data, error } = await client.rpc(
                        'checkpoint_analysis_revenue_primary_quality_v1',
                        {
                            p_request_id: parsedClaim.data.requestId.toLowerCase(),
                            p_job_key: parsedClaim.data.jobKey,
                            p_job_claim_token: parsedClaim.data.claimToken.toLowerCase(),
                            p_job_input_hash: parsedClaim.data.jobInputHash,
                            p_public_mutual_count: parsedCompletion.data.publicMutualCount,
                            p_screened_count: parsedCompletion.data.screenedCount,
                            p_not_screened_count: parsedCompletion.data.notScreenedCount,
                            p_initial_unknown_burden_count:
                                parsedCompletion.data.initialUnknownBurdenCount,
                            p_final_unknown_burden_count:
                                parsedCompletion.data.finalUnknownBurdenCount,
                            p_coverage_valid: parsedCompletion.data.coverageValid,
                            p_resolver_pass_started: parsedCompletion.data.resolverPassStarted,
                        },
                    );
                    if (error) throw new AnalysisV2RevenueResolverCapacityError();
                    const outcome = parsePassOutcome(data);
                    return outcome.disposition === 'accepted'
                        ? 'approved' as const
                        : 'manual_review' as const;
                },
            };
        },
    };
}
