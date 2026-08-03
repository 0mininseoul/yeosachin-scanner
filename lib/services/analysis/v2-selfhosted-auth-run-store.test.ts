import { describe, expect, it, vi } from 'vitest';
import {
    ANALYSIS_V2_SELFHOSTED_AUTH_RUN_LOAD_RPC,
    ANALYSIS_V2_SELFHOSTED_AUTH_RUN_RPC,
    analysisV2SelfHostedAuthRunStore,
    createAnalysisV2SelfHostedAuthWorkerIdentity,
    createAnalysisV2SelfHostedAuthRunStore,
    type AnalysisV2SelfHostedAuthRunSupabaseClient,
} from './v2-selfhosted-auth-run-store';

const input = {
    requestId: '7df77338-2672-4ef2-93fe-13a0683ec9b4',
    jobKey: 'track:relationships:collect',
    claimToken: '51b42f42-204d-4dfb-86f8-9658d21c78f1',
    jobInputHash: 'a'.repeat(64),
    operationKey: `relationship-followers:${'b'.repeat(64)}`,
    inputHash: 'c'.repeat(64),
    runId: '0123456789abcdef0123456789abcdef',
    accountSlot: 'primary' as const,
    items: [{ username: 'first_user' }],
};

describe('analysis V2 selfhosted auth run receipt store', () => {
    it('scopes worker idempotency to one request while remaining stable for its retries', () => {
        const first = createAnalysisV2SelfHostedAuthWorkerIdentity(input);
        const retry = createAnalysisV2SelfHostedAuthWorkerIdentity(input);
        const independent = createAnalysisV2SelfHostedAuthWorkerIdentity({
            ...input,
            requestId: '6d16de3e-5160-48bc-8b39-a09568550d53',
        });

        expect(first).toEqual(retry);
        expect(first.inputHash).toBe(input.inputHash);
        expect(first.operationKey).toMatch(/^relationship-followers:[a-f0-9]{64}$/);
        expect(independent.operationKey).not.toBe(first.operationKey);
    });

    it('exports the default receipt store as a checkpoint-capable instance', () => {
        expect(analysisV2SelfHostedAuthRunStore).toMatchObject({
            checkpoint: expect.any(Function),
        });
    });

    it('checkpoints only a strict zero-cost worker receipt behind the live job claim', async () => {
        const rpc = vi.fn(async () => ({
            data: {
                schemaVersion: 1,
                provider: 'selfhosted_auth',
                operationKey: input.operationKey,
                inputHash: input.inputHash,
                runId: input.runId,
                accountSlot: 'primary',
                items: input.items,
            },
            error: null,
        }));
        const store = createAnalysisV2SelfHostedAuthRunStore(
            { rpc } as AnalysisV2SelfHostedAuthRunSupabaseClient
        );

        await expect(store.checkpoint(input)).resolves.toMatchObject({
            provider: 'selfhosted_auth',
            runId: input.runId,
            accountSlot: 'primary',
        });
        expect(rpc).toHaveBeenCalledWith(ANALYSIS_V2_SELFHOSTED_AUTH_RUN_RPC, {
            p_request_id: input.requestId,
            p_job_key: input.jobKey,
            p_claim_token: input.claimToken,
            p_job_input_hash: input.jobInputHash,
            p_operation_key: input.operationKey,
            p_input_hash: input.inputHash,
            p_run_id: input.runId,
            p_account_slot: 'primary',
            p_items: input.items,
        });
    });

    it('loads and re-fences an exact cached payload under the current live claim', async () => {
        const rpc = vi.fn(async () => ({
            data: {
                schemaVersion: 1,
                provider: 'selfhosted_auth',
                operationKey: input.operationKey,
                inputHash: input.inputHash,
                runId: input.runId,
                accountSlot: 'primary',
                items: input.items,
            },
            error: null,
        }));
        const store = createAnalysisV2SelfHostedAuthRunStore(
            { rpc } as AnalysisV2SelfHostedAuthRunSupabaseClient
        );

        await expect(store.load({
            requestId: input.requestId,
            jobKey: input.jobKey,
            claimToken: input.claimToken,
            jobInputHash: input.jobInputHash,
            operationKey: input.operationKey,
            inputHash: input.inputHash,
        })).resolves.toMatchObject({
            runId: input.runId,
            items: input.items,
        });
        expect(rpc).toHaveBeenCalledWith(ANALYSIS_V2_SELFHOSTED_AUTH_RUN_LOAD_RPC, {
            p_request_id: input.requestId,
            p_job_key: input.jobKey,
            p_claim_token: input.claimToken,
            p_job_input_hash: input.jobInputHash,
            p_operation_key: input.operationKey,
            p_input_hash: input.inputHash,
        });
    });

    it('fails closed before RPC for malformed or oversized cached payloads', async () => {
        const rpc = vi.fn();
        const store = createAnalysisV2SelfHostedAuthRunStore(
            { rpc } as AnalysisV2SelfHostedAuthRunSupabaseClient
        );

        await expect(store.checkpoint({
            ...input,
            items: [null as unknown as Record<string, unknown>],
        }))
            .rejects.toThrow('VALIDATION');
        await expect(store.checkpoint({
            ...input,
            items: Array.from({ length: 1_201 }, () => ({ username: 'valid_user' })),
        })).rejects.toThrow('VALIDATION');
        expect(rpc).not.toHaveBeenCalled();
    });

    it('accepts the reverse-like job and only its candidate-likers operation identity', async () => {
        const reverseInput = {
            ...input,
            jobKey: 'track:reverse-likes:collect',
            operationKey: `candidate-likers:${'d'.repeat(64)}`,
        };
        const rpc = vi.fn(async () => ({
            data: {
                schemaVersion: 1,
                provider: 'selfhosted_auth',
                operationKey: reverseInput.operationKey,
                inputHash: reverseInput.inputHash,
                runId: reverseInput.runId,
                accountSlot: 'primary',
                items: reverseInput.items,
            },
            error: null,
        }));
        const store = createAnalysisV2SelfHostedAuthRunStore(
            { rpc } as AnalysisV2SelfHostedAuthRunSupabaseClient
        );

        await expect(store.checkpoint(reverseInput)).resolves.toMatchObject({
            operationKey: reverseInput.operationKey,
        });
        expect(rpc).toHaveBeenCalledOnce();
        await expect(store.checkpoint({
            ...reverseInput,
            operationKey: `target-likers:${'e'.repeat(64)}`,
        })).rejects.toThrow('VALIDATION');
        expect(rpc).toHaveBeenCalledOnce();
    });

    it('fails closed on malformed identities, database errors, and drifted responses', async () => {
        const never = vi.fn();
        const store = createAnalysisV2SelfHostedAuthRunStore(
            { rpc: never } as AnalysisV2SelfHostedAuthRunSupabaseClient
        );
        await expect(store.checkpoint({ ...input, runId: 'short' }))
            .rejects.toThrow('VALIDATION');
        expect(never).not.toHaveBeenCalled();

        const failed = createAnalysisV2SelfHostedAuthRunStore({
            rpc: vi.fn(async () => ({ data: null, error: { code: 'XX001' } })),
        } as AnalysisV2SelfHostedAuthRunSupabaseClient);
        await expect(failed.checkpoint(input)).rejects.toThrow('PERSISTENCE');

        const drifted = createAnalysisV2SelfHostedAuthRunStore({
            rpc: vi.fn(async () => ({
                data: {
                    schemaVersion: 1,
                    provider: 'selfhosted_auth',
                    operationKey: input.operationKey,
                    inputHash: input.inputHash,
                    runId: 'fedcba9876543210fedcba9876543210',
                    accountSlot: 'primary',
                    items: input.items,
                },
                error: null,
            })),
        } as AnalysisV2SelfHostedAuthRunSupabaseClient);
        await expect(drifted.checkpoint(input)).rejects.toThrow('drift');
    });
});
