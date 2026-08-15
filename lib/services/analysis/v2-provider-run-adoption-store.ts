import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { ApifyCredentialSlot, ProviderRunCheckpoint } from '@/lib/services/instagram/providers/types';
import type {
    AnalysisV2LogicalPaidProvider,
    AnalysisV2ProviderRunReservationInput,
} from './v2-provider-run-store';

const adoptedRunSchema = z.object({
    sourceRequestId: z.string().uuid(),
    sourceJobKey: z.string().min(1).max(160),
    operationKey: z.string().min(1).max(87),
    inputHash: z.string().regex(/^[0-9a-f]{64}$/),
    logicalProvider: z.enum(['apify', 'coderx']),
    actorId: z.string().min(3).max(200),
    credentialSlot: z.enum([
        'primary', 'secondary', 'tertiary', 'quaternary', 'quinary', 'senary',
    ]),
    maxChargeUsd: z.coerce.number().min(0).max(100_000),
    runId: z.string().regex(/^[A-Za-z0-9]{8,64}$/),
    actualUsageUsd: z.coerce.number().min(0).max(100_000),
    usageReconciledAt: z.string().datetime({ offset: true }),
    // Only the cross-count relationship resolver returns this. Exact adoption
    // deliberately leaves it absent so the adapter remains fail-closed.
    relationshipSourceDeclaredCount: z.number().int().min(1).max(1_200).optional(),
    // Only an incident-specific, audited resolver can set this. It permits the
    // relationship executor to open its one existing replacement identity after
    // an adopted terminal Dataset proves incomplete.
    allowRelationshipIncompleteReplacement: z.literal(true).optional(),
}).strict();

export interface AdoptedAnalysisV2ProviderRun {
    sourceRequestId: string;
    sourceJobKey: string;
    operationKey: string;
    inputHash: string;
    logicalProvider: AnalysisV2LogicalPaidProvider;
    actorId: string;
    credentialSlot: ApifyCredentialSlot;
    maxChargeUsd: number;
    runId: string;
    actualUsageUsd: number;
    usageReconciledAt: string;
    relationshipSourceDeclaredCount?: number;
    allowRelationshipIncompleteReplacement?: true;
}

export interface AnalysisV2ProviderRunAdoptionStore {
    resolve(
        input: AnalysisV2ProviderRunReservationInput
    ): Promise<AdoptedAnalysisV2ProviderRun | null>;
}

interface RpcClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: { code?: string; message?: string } | null;
    }>;
}

export const ANALYSIS_V2_PROVIDER_RUN_ADOPTION_RPC =
    'resolve_analysis_v2_recovery_provider_run';

function safeCode(code: unknown): string {
    return typeof code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(code)
        ? code
        : 'unknown';
}

export function createAnalysisV2ProviderRunAdoptionStore(
    client: RpcClient = supabaseAdmin
): AnalysisV2ProviderRunAdoptionStore {
    return {
        async resolve(input) {
            const { data, error } = await client.rpc(
                ANALYSIS_V2_PROVIDER_RUN_ADOPTION_RPC,
                {
                    p_request_id: input.requestId,
                    p_job_key: input.jobKey,
                    p_claim_token: input.claimToken,
                    p_operation_key: input.operationKey,
                    p_input_hash: input.inputHash,
                    p_logical_provider: input.logicalProvider,
                    p_actor_id: input.actorId,
                    p_credential_slot: input.credentialSlot,
                    p_max_charge_usd: input.maxChargeUsd,
                }
            );
            if (error) {
                if (error.message === 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_FENCE_MISMATCH') {
                    throw new Error(error.message);
                }
                if (
                    error.message
                    === 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_SOURCE_UNAVAILABLE'
                ) {
                    throw new Error('ADOPTION_DATASET_UNAVAILABLE');
                }
                throw new Error(
                    `ANALYSIS_V2_PROVIDER_RUN_ADOPTION_PERSISTENCE_ERROR: resolve failed (${safeCode(error.code)}).`
                );
            }
            return data === null ? null : adoptedRunSchema.parse(data);
        },
    };
}

export function adoptedProviderCheckpoint(
    run: AdoptedAnalysisV2ProviderRun
): ProviderRunCheckpoint {
    // Deliberately callback-free: adopted runs may only read their existing Dataset.
    return Object.freeze({
        resumeRunId: run.runId,
        logicalProvider: run.logicalProvider,
        actorId: run.actorId,
        credentialSlot: run.credentialSlot,
        maxChargeUsd: run.maxChargeUsd,
        ...(run.relationshipSourceDeclaredCount === undefined ? {} : {
            allowAdoptedRelationshipTruncation: true as const,
            adoptedRelationshipSourceDeclaredCount: run.relationshipSourceDeclaredCount,
        }),
    });
}

export async function bindAdoptedProviderRunOrFallback<T>(input: {
    adoptionStore: AnalysisV2ProviderRunAdoptionStore | null;
    identity: AnalysisV2ProviderRunReservationInput;
    fallback(): Promise<T>;
}): Promise<
    | { adopted: AdoptedAnalysisV2ProviderRun; checkpoint: ProviderRunCheckpoint }
    | { adopted: null; fallback: T }
> {
    const adopted = await input.adoptionStore?.resolve(input.identity) ?? null;
    if (adopted) {
        return { adopted, checkpoint: adoptedProviderCheckpoint(adopted) };
    }
    return { adopted: null, fallback: await input.fallback() };
}

export const analysisV2ProviderRunAdoptionStore =
    createAnalysisV2ProviderRunAdoptionStore();
