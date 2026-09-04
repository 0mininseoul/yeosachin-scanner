import { describe, expect, it, vi } from 'vitest';
import {
    adoptedProviderCheckpoint,
    bindAdoptedProviderRunOrFallback,
    createAnalysisV2ProviderRunAdoptionStore,
} from './v2-provider-run-adoption-store';

const identity = {
    requestId: '11111111-1111-4111-8111-111111111111',
    jobKey: 'track:relationships:collect',
    claimToken: '22222222-2222-4222-8222-222222222222',
    operationKey: `relationship-followers:${'a'.repeat(64)}`,
    inputHash: 'b'.repeat(64),
    logicalProvider: 'apify' as const,
    actorId: 'apify/relationship-scraper',
    credentialSlot: 'secondary' as const,
    maxChargeUsd: 1.25,
};

it('resolves an exact recovery-lineage run without constructing callbacks', async () => {
    const rpc = vi.fn().mockResolvedValue({
        data: {
            sourceRequestId: '33333333-3333-4333-8333-333333333333',
            sourceJobKey: identity.jobKey,
            operationKey: identity.operationKey,
            inputHash: identity.inputHash,
            logicalProvider: 'apify',
            actorId: identity.actorId,
            credentialSlot: 'secondary',
            maxChargeUsd: 1.25,
            runId: 'ExistingRun1234',
            actualUsageUsd: 0.42,
            usageReconciledAt: '2026-07-30T00:00:00Z',
        },
        error: null,
    });
    const run = await createAnalysisV2ProviderRunAdoptionStore({ rpc }).resolve(identity);
    expect(rpc).toHaveBeenCalledWith('resolve_analysis_v2_recovery_provider_run', {
        p_request_id: identity.requestId,
        p_job_key: identity.jobKey,
        p_claim_token: identity.claimToken,
        p_operation_key: identity.operationKey,
        p_input_hash: identity.inputHash,
        p_logical_provider: 'apify',
        p_actor_id: identity.actorId,
        p_credential_slot: 'secondary',
        p_max_charge_usd: 1.25,
    });
    expect(adoptedProviderCheckpoint(run!)).toEqual({
        resumeRunId: 'ExistingRun1234',
        logicalProvider: 'apify',
        actorId: identity.actorId,
        credentialSlot: 'secondary',
        maxChargeUsd: 1.25,
    });
    expect(adoptedProviderCheckpoint(run!)).not.toHaveProperty('onRunStarted');
    expect(adoptedProviderCheckpoint(run!)).not.toHaveProperty('onCostRunFinished');
    expect(adoptedProviderCheckpoint(run!)).not.toHaveProperty(
        'allowAdoptedRelationshipTruncation'
    );
});

it('accepts every canonical alias when replaying a historical provider receipt', async () => {
    const credentialSlots = [
        'primary', 'secondary', 'tertiary', 'quaternary', 'quinary',
        'senary', 'septenary', 'octonary', 'nonary', 'tenth',
    ] as const;
    for (const credentialSlot of credentialSlots) {
        const rpc = vi.fn().mockResolvedValue({
            data: {
                sourceRequestId: '33333333-3333-4333-8333-333333333333',
                sourceJobKey: identity.jobKey,
                operationKey: identity.operationKey,
                inputHash: identity.inputHash,
                logicalProvider: 'apify',
                actorId: identity.actorId,
                credentialSlot,
                maxChargeUsd: 1.25,
                runId: 'ExistingRun1234',
                actualUsageUsd: 0.42,
                usageReconciledAt: '2026-07-30T00:00:00Z',
            },
            error: null,
        });
        const result = await createAnalysisV2ProviderRunAdoptionStore({ rpc }).resolve({
            ...identity,
            credentialSlot,
        });
        expect(result?.credentialSlot).toBe(credentialSlot);
    }
});

it('carries the source count only for a cross-count adopted relationship run', async () => {
    const rpc = vi.fn().mockResolvedValue({
        data: {
            sourceRequestId: '33333333-3333-4333-8333-333333333333',
            sourceJobKey: identity.jobKey,
            operationKey: identity.operationKey,
            inputHash: identity.inputHash,
            logicalProvider: 'apify',
            actorId: identity.actorId,
            credentialSlot: 'secondary',
            maxChargeUsd: 1.25,
            runId: 'ExistingRun1234',
            actualUsageUsd: 0.42,
            usageReconciledAt: '2026-07-30T00:00:00Z',
            relationshipSourceDeclaredCount: 233,
        },
        error: null,
    });
    const run = await createAnalysisV2ProviderRunAdoptionStore({ rpc }).resolve(identity);

    expect(adoptedProviderCheckpoint(run!)).toMatchObject({
        resumeRunId: 'ExistingRun1234',
        allowAdoptedRelationshipTruncation: true,
        adoptedRelationshipSourceDeclaredCount: 233,
    });
    expect(adoptedProviderCheckpoint(run!)).not.toHaveProperty('onRunStarted');
});

describe('fail closed', () => {
    it('returns null instead of opening a global cache lookup', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
        await expect(
            createAnalysisV2ProviderRunAdoptionStore({ rpc }).resolve(identity)
        ).resolves.toBeNull();
        expect(rpc).toHaveBeenCalledOnce();
    });

    it('maps a recovery-lineage source miss without opening the fallback', async () => {
        const rpc = vi.fn().mockResolvedValue({
            data: null,
            error: {
                message: 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_SOURCE_UNAVAILABLE',
            },
        });
        const fallback = vi.fn();
        await expect(bindAdoptedProviderRunOrFallback({
            adoptionStore: createAnalysisV2ProviderRunAdoptionStore({ rpc }),
            identity,
            fallback,
        })).rejects.toThrow('ADOPTION_DATASET_UNAVAILABLE');
        expect(fallback).not.toHaveBeenCalled();
    });
});

it('prefers adoption and never reserves, while a miss uses the normal durable path', async () => {
    const adopted = {
        sourceRequestId: '33333333-3333-4333-8333-333333333333',
        sourceJobKey: identity.jobKey,
        operationKey: identity.operationKey,
        inputHash: identity.inputHash,
        logicalProvider: 'apify' as const,
        actorId: identity.actorId,
        credentialSlot: 'secondary' as const,
        maxChargeUsd: 1.25,
        runId: 'ExistingRun1234',
        actualUsageUsd: 0.42,
        usageReconciledAt: '2026-07-30T00:00:00Z',
    };
    const reserve = vi.fn().mockResolvedValue({ normal: true });
    const adoptionStore = { resolve: vi.fn().mockResolvedValue(adopted) };
    const first = await bindAdoptedProviderRunOrFallback({
        adoptionStore,
        identity,
        fallback: reserve,
    });
    expect(first).toMatchObject({
        adopted,
        checkpoint: { resumeRunId: 'ExistingRun1234' },
    });
    expect(reserve).not.toHaveBeenCalled();

    adoptionStore.resolve.mockResolvedValue(null);
    await expect(bindAdoptedProviderRunOrFallback({
        adoptionStore,
        identity,
        fallback: reserve,
    })).resolves.toEqual({ adopted: null, fallback: { normal: true } });
    expect(reserve).toHaveBeenCalledOnce();
});
