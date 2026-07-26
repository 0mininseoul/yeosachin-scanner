import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
    ANALYSIS_V2_SCHEDULER_OPERATION_DATABASE_NAMES,
    createAnalysisV2SchedulerOperationStore,
} from './v2-ai-scheduler-operation-store';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const jobClaimToken = '223e4567-e89b-42d3-a456-426614174000';
const operationClaimToken = '323e4567-e89b-42d3-a456-426614174000';
const operationKey = `gender-triage:${'a'.repeat(64)}`;
const resultSchema = z.object({ value: z.literal('female') }).strict();

function storeWith(rpc: ReturnType<typeof vi.fn>) {
    return createAnalysisV2SchedulerOperationStore({
        requestId,
        jobKey: 'track:profile-ai:batch:0',
        jobClaimToken,
        schemas: new Map([[operationKey, resultSchema]]),
        client: { rpc },
        randomUuid: () => operationClaimToken,
    });
}

describe('analysis V2 scheduler operation store', () => {
    it('claims and commits one schema-validated durable operation', async () => {
        const rpc = vi.fn()
            .mockResolvedValueOnce({
                data: [{
                    decision: 'execute',
                    operation_claim_token: operationClaimToken,
                    recovery_only: false,
                    result_json: null,
                    not_before_at: null,
                }],
                error: null,
            })
            .mockResolvedValueOnce({ data: true, error: null });
        const store = storeWith(rpc);

        await expect(store.claim({
            key: operationKey,
            stage: 'genderTriage',
        })).resolves.toEqual({
            decision: 'execute',
            claimToken: operationClaimToken,
        });
        await expect(store.commitReady({
            key: operationKey,
            stage: 'genderTriage',
            claimToken: operationClaimToken,
            value: { value: 'female' },
        })).resolves.toBeUndefined();

        expect(rpc.mock.calls.map(call => call[0])).toEqual([
            ANALYSIS_V2_SCHEDULER_OPERATION_DATABASE_NAMES.claimRpc,
            ANALYSIS_V2_SCHEDULER_OPERATION_DATABASE_NAMES.commitRpc,
        ]);
    });

    it('returns validated ready values and checkpoint-only recovery decisions', async () => {
        const readyRpc = vi.fn().mockResolvedValue({
            data: {
                decision: 'ready',
                operation_claim_token: null,
                recovery_only: false,
                result_json: { value: 'female' },
                not_before_at: null,
            },
            error: null,
        });
        await expect(storeWith(readyRpc).claim({
            key: operationKey,
            stage: 'genderTriage',
        })).resolves.toEqual({
            decision: 'ready',
            value: { value: 'female' },
        });

        const recoveryRpc = vi.fn().mockResolvedValue({
            data: {
                decision: 'execute',
                operation_claim_token: operationClaimToken,
                recovery_only: true,
                result_json: null,
                not_before_at: null,
            },
            error: null,
        });
        await expect(storeWith(recoveryRpc).claim({
            key: operationKey,
            stage: 'genderTriage',
        })).resolves.toEqual({
            decision: 'execute',
            claimToken: operationClaimToken,
            recoveryOnly: true,
        });

        const terminalRpc = vi.fn().mockResolvedValue({
            data: {
                decision: 'terminal_unavailable',
                operation_claim_token: operationClaimToken,
                recovery_only: true,
                result_json: null,
                not_before_at: null,
            },
            error: null,
        });
        await expect(storeWith(terminalRpc).claim({
            key: operationKey,
            stage: 'genderTriage',
        })).resolves.toEqual({
            decision: 'execute',
            claimToken: operationClaimToken,
            recoveryOnly: true,
            terminalUnavailable: true,
        });
    });

    it('durably defers a pre-provider admission failure with bounded delay', async () => {
        const notBefore = new Date(Date.now() + 5_000).toISOString();
        const rpc = vi.fn()
            .mockResolvedValueOnce({
                data: [{
                    decision: 'execute',
                    operation_claim_token: operationClaimToken,
                    recovery_only: false,
                    result_json: null,
                    not_before_at: null,
                }],
                error: null,
            })
            .mockResolvedValueOnce({ data: notBefore, error: null });
        const store = storeWith(rpc);
        const claimed = await store.claim({
            key: operationKey,
            stage: 'genderTriage',
        });
        expect(claimed.decision).toBe('execute');
        const monotonicBefore = performance.now();
        await expect(store.defer!({
            key: operationKey,
            stage: 'genderTriage',
            claimToken: operationClaimToken,
            reason: 'ANALYSIS_V2_AI_CAPACITY_PENDING',
        })).resolves.toBeGreaterThan(monotonicBefore + 4_000);
        expect(rpc.mock.calls.at(-1)).toEqual([
            ANALYSIS_V2_SCHEDULER_OPERATION_DATABASE_NAMES.deferRpc,
            expect.objectContaining({
                p_operation_claim_token: operationClaimToken,
                p_reason: 'ANALYSIS_V2_AI_CAPACITY_PENDING',
            }),
        ]);
    });

    it('fails closed for malformed ready results, ambiguous ownership, and commit fences', async () => {
        const malformed = storeWith(vi.fn().mockResolvedValue({
            data: {
                decision: 'ready',
                operation_claim_token: null,
                recovery_only: false,
                result_json: { value: 'male' },
                not_before_at: null,
            },
            error: null,
        }));
        await expect(malformed.claim({
            key: operationKey,
            stage: 'genderTriage',
        })).rejects.toThrow('invalid ready result');

        const notBefore = new Date(Date.now() + 30_000).toISOString();
        const monotonicBefore = performance.now();
        const deferred = storeWith(vi.fn().mockResolvedValue({
            data: {
                decision: 'deferred',
                operation_claim_token: null,
                recovery_only: false,
                result_json: null,
                not_before_at: notBefore,
            },
            error: null,
        }));
        const decision = await deferred.claim({
            key: operationKey,
            stage: 'genderTriage',
        });
        expect(decision.decision).toBe('deferred');
        if (decision.decision === 'deferred') {
            expect(decision.notBeforeAtMs - monotonicBefore).toBeGreaterThan(29_000);
            expect(decision.notBeforeAtMs - monotonicBefore).toBeLessThanOrEqual(30_100);
        }
        await expect(deferred.commitReady({
            key: operationKey,
            stage: 'genderTriage',
            claimToken: operationClaimToken,
            value: { value: 'female' },
        })).rejects.toThrow('FENCE_MISMATCH');
    });
});
