import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

import {
    ANALYSIS_V2_AI_ATTEMPT_DATABASE_NAMES,
    AnalysisV2AiAttemptConflictError,
    AnalysisV2AiAttemptFenceError,
    AnalysisV2AiAttemptNotReadyError,
    AnalysisV2AiAttemptNotRetryableError,
    createAnalysisV2AiAttemptStore,
    createAnalysisV2AiOperationKey,
    type AnalysisV2AiAttemptRecord,
    type AnalysisV2AiAttemptReservationInput,
    type AnalysisV2AiAttemptSupabaseClient,
    type AnalysisV2AiAttemptTerminalInput,
} from './v2-ai-attempt-store';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const jobKey = 'track:profiles:batch:0';
const claimToken = '123e4567-e89b-42d3-a456-426614174001';
const reservationToken = '123e4567-e89b-42d3-a456-426614174002';
const operationKey = createAnalysisV2AiOperationKey(
    'genderTriage',
    'candidate:alice|profile-fingerprint:abc123'
);
const createdAt = '2026-07-14T01:00:00.000Z';
const terminalizedAt = '2026-07-14T01:00:01.000Z';

function rpcClient(rpc: ReturnType<typeof vi.fn>): AnalysisV2AiAttemptSupabaseClient {
    return { rpc };
}

function reservationInput(
    overrides: Partial<AnalysisV2AiAttemptReservationInput> = {}
): AnalysisV2AiAttemptReservationInput {
    return {
        requestId,
        jobKey,
        claimToken,
        operationKey,
        attempt: 1,
        retryCount: 0,
        modelName: 'gemini-3.1-flash-lite',
        location: 'asia-northeast3',
        stage: 'genderTriage',
        thinkingLevel: 'MINIMAL',
        mediaCount: 5,
        mediaResolution: 'LOW',
        promptVersion: 'gender-triage-v1',
        schemaVersion: 1,
        maxOutputTokens: 2_048,
        ...overrides,
    };
}

function reservedRecord(
    overrides: Partial<AnalysisV2AiAttemptRecord> = {}
): AnalysisV2AiAttemptRecord {
    return {
        requestId,
        jobKey,
        operationKey,
        attempt: 1,
        retryCount: 0,
        reservationToken,
        status: 'reserved',
        modelName: 'gemini-3.1-flash-lite',
        location: 'asia-northeast3',
        stage: 'genderTriage',
        thinkingLevel: 'MINIMAL',
        mediaCount: 5,
        mediaResolution: 'LOW',
        promptVersion: 'gender-triage-v1',
        schemaVersion: 1,
        maxOutputTokens: 2_048,
        usageMetadataStatus: null,
        usageComplete: null,
        tokenUsage: null,
        latencyMs: null,
        estimatedCostUsd: null,
        finishReason: null,
        createdAt,
        terminalizedAt: null,
        ...overrides,
    };
}

function terminalInput(
    overrides: Partial<AnalysisV2AiAttemptTerminalInput> = {}
): AnalysisV2AiAttemptTerminalInput {
    return {
        ...reservationInput(),
        reservationToken,
        status: 'success',
        usageMetadataStatus: 'complete',
        usageComplete: true,
        tokenUsage: {
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 125,
        },
        latencyMs: 900,
        estimatedCostUsd: 0.000000000125,
        finishReason: 'STOP',
        ...overrides,
    };
}

function successRecord(
    overrides: Partial<AnalysisV2AiAttemptRecord> = {}
): AnalysisV2AiAttemptRecord {
    return reservedRecord({
        status: 'success',
        usageMetadataStatus: 'complete',
        usageComplete: true,
        tokenUsage: {
            promptTokens: 100,
            completionTokens: 20,
            totalTokens: 125,
            thinkingTokens: 5,
        },
        latencyMs: 900,
        estimatedCostUsd: 0.000000000125,
        finishReason: 'STOP',
        terminalizedAt,
        ...overrides,
    });
}

describe('analysis V2 AI attempt store', () => {
    it('builds a deterministic, stage-bound key without persisting raw identity', () => {
        const identity = 'candidate:0_min._.00|caption:private text';
        const first = createAnalysisV2AiOperationKey('partnerSafety', identity);
        const second = createAnalysisV2AiOperationKey('partnerSafety', identity);

        expect(first).toBe(second);
        expect(first).toMatch(/^partner-safety:[0-9a-f]{64}$/);
        expect(first).not.toContain('0_min');
        expect(first).not.toContain('private text');
        expect(createAnalysisV2AiOperationKey('featureAnalysis', identity))
            .not.toBe(first);
    });

    it('reserves through the active job claim fence and verifies the database token echo', async () => {
        const rpc = vi.fn().mockImplementation((_, params: Record<string, unknown>) => {
            return Promise.resolve({
                data: {
                    ...reservedRecord({
                        reservationToken: String(params.p_reservation_token),
                    }),
                    created: true,
                },
                error: null,
            });
        });
        const store = createAnalysisV2AiAttemptStore(rpcClient(rpc));

        const result = await store.reserve(reservationInput());
        expect(result).toEqual({
            ...reservedRecord({ reservationToken: result.reservationToken }),
            created: true,
        });
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_AI_ATTEMPT_DATABASE_NAMES.reserveRpc,
            {
                p_request_id: requestId,
                p_job_key: jobKey,
                p_claim_token: claimToken,
                p_operation_key: operationKey,
                p_attempt: 1,
                p_reservation_token: expect.stringMatching(UUID_PATTERN_FOR_EXPECT),
                p_metadata: {
                    model_name: 'gemini-3.1-flash-lite',
                    location: 'asia-northeast3',
                    stage: 'genderTriage',
                    thinking_level: 'MINIMAL',
                    media_count: 5,
                    media_resolution: 'LOW',
                    prompt_version: 'gender-triage-v1',
                    schema_version: 1,
                    max_output_tokens: 2_048,
                    retry_count: 0,
                },
            }
        );
    });

    it('passes a newly reacquired live claim when reserving a rate-limit retry', async () => {
        const reacquiredClaimToken = '123e4567-e89b-42d3-a456-426614174003';
        const rpc = vi.fn().mockImplementation((_, params: Record<string, unknown>) => {
            return Promise.resolve({
                data: {
                    ...reservedRecord({
                        attempt: 2,
                        retryCount: 1,
                        reservationToken: String(params.p_reservation_token),
                    }),
                    created: true,
                },
                error: null,
            });
        });
        const store = createAnalysisV2AiAttemptStore(rpcClient(rpc));

        await expect(store.reserve(reservationInput({
            claimToken: reacquiredClaimToken,
            attempt: 2,
            retryCount: 1,
        }))).resolves.toMatchObject({
            attempt: 2,
            retryCount: 1,
            status: 'reserved',
            created: true,
        });
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_AI_ATTEMPT_DATABASE_NAMES.reserveRpc,
            expect.objectContaining({
                p_claim_token: reacquiredClaimToken,
                p_attempt: 2,
            })
        );
    });

    it('rejects created=true when the database does not echo its reservation token', async () => {
        const rpc = vi.fn().mockImplementation(() => Promise.resolve({
            data: { ...reservedRecord(), created: true },
            error: null,
        }));
        const store = createAnalysisV2AiAttemptStore(rpcClient(rpc));

        await expect(store.reserve(reservationInput())).rejects.toThrow(
            'invalid reservation response'
        );
        expect(rpc.mock.calls[0]![1].p_reservation_token).not.toBe(reservationToken);
    });

    it('rejects created=true when an exact token echo is already terminal', async () => {
        const rpc = vi.fn().mockImplementation((_, params: Record<string, unknown>) => {
            return Promise.resolve({
                data: {
                    ...successRecord({
                        reservationToken: String(params.p_reservation_token),
                    }),
                    created: true,
                },
                error: null,
            });
        });
        const store = createAnalysisV2AiAttemptStore(rpcClient(rpc));

        await expect(store.reserve(reservationInput())).rejects.toThrow(
            'invalid reservation response'
        );
    });

    it('accepts an exact replay response without replacing its reservation fence', async () => {
        const rpc = vi.fn().mockResolvedValue({
            data: { ...reservedRecord(), created: false },
            error: null,
        });
        const store = createAnalysisV2AiAttemptStore(rpcClient(rpc));

        const result = await store.reserve(reservationInput());
        expect(result.created).toBe(false);
        expect(result.reservationToken).toBe(reservationToken);
    });

    it('rejects stage/key and attempt/retry drift before persistence', async () => {
        const rpc = vi.fn();
        const store = createAnalysisV2AiAttemptStore(rpcClient(rpc));

        await expect(store.reserve(reservationInput({
            stage: 'featureAnalysis',
        }))).rejects.toThrow('invalid reservation');
        await expect(store.reserve(reservationInput({
            attempt: 2,
            retryCount: 0,
        }))).rejects.toThrow('invalid reservation');
        expect(rpc).not.toHaveBeenCalled();
    });

    it('terminalizes the exact reservation and infers bounded thinking tokens', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: successRecord(), error: null });
        const store = createAnalysisV2AiAttemptStore(rpcClient(rpc));

        await expect(store.terminalize(terminalInput())).resolves.toEqual(successRecord());
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_AI_ATTEMPT_DATABASE_NAMES.terminalizeRpc,
            expect.objectContaining({
                p_request_id: requestId,
                p_job_key: jobKey,
                p_claim_token: claimToken,
                p_operation_key: operationKey,
                p_attempt: 1,
                p_reservation_token: reservationToken,
                p_status: 'success',
                p_telemetry: expect.objectContaining({
                    usage_metadata_status: 'complete',
                    usage_complete: true,
                    prompt_tokens: 100,
                    completion_tokens: 20,
                    total_tokens: 125,
                    thinking_tokens: 5,
                    estimated_cost_usd: 0.000000000125,
                    finish_reason: 'STOP',
                }),
            })
        );
    });

    it('persists unknown usage only as null telemetry', async () => {
        const ambiguous = successRecord({
            status: 'ambiguous',
            usageMetadataStatus: 'missing',
            usageComplete: false,
            tokenUsage: null,
            estimatedCostUsd: null,
            finishReason: null,
        });
        const rpc = vi.fn().mockResolvedValue({ data: ambiguous, error: null });
        const store = createAnalysisV2AiAttemptStore(rpcClient(rpc));

        await store.terminalize(terminalInput({
            status: 'ambiguous',
            usageMetadataStatus: 'missing',
            usageComplete: false,
            tokenUsage: null,
            estimatedCostUsd: null,
            finishReason: null,
        }));

        expect(rpc.mock.calls[0]![1].p_telemetry).toMatchObject({
            prompt_tokens: null,
            completion_tokens: null,
            total_tokens: null,
            thinking_tokens: null,
            estimated_cost_usd: null,
        });
    });

    it('fails closed on inconsistent or fabricated usage before the RPC', async () => {
        const rpc = vi.fn();
        const store = createAnalysisV2AiAttemptStore(rpcClient(rpc));

        await expect(store.terminalize(terminalInput({
            tokenUsage: {
                promptTokens: 100,
                completionTokens: 20,
                totalTokens: 110,
            },
        }))).rejects.toThrow('invalid token usage');
        await expect(store.terminalize(terminalInput({
            usageMetadataStatus: 'missing',
            usageComplete: false,
            tokenUsage: null,
            estimatedCostUsd: 0,
        }))).rejects.toThrow('unknown usage must remain null');
        await expect(store.terminalize(terminalInput({
            status: 'rate_limited',
            usageMetadataStatus: 'malformed',
            usageComplete: false,
            tokenUsage: null,
            estimatedCostUsd: null,
            finishReason: 'STOP',
        }))).rejects.toThrow('generation failure telemetry is inconsistent');
        expect(rpc).not.toHaveBeenCalled();
    });

    it('loads a complete contiguous operation history in attempt order', async () => {
        const secondReservation = randomUUID();
        const rateLimited = successRecord({
            status: 'rate_limited',
            usageMetadataStatus: 'missing',
            usageComplete: false,
            tokenUsage: null,
            estimatedCostUsd: null,
            finishReason: null,
        });
        const second = successRecord({
            attempt: 2,
            retryCount: 1,
            reservationToken: secondReservation,
        });
        const rpc = vi.fn().mockResolvedValue({
            data: [rateLimited, second],
            error: null,
        });
        const store = createAnalysisV2AiAttemptStore(rpcClient(rpc));

        await expect(store.loadOperation({ requestId, operationKey }))
            .resolves.toEqual([rateLimited, second]);
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_AI_ATTEMPT_DATABASE_NAMES.loadOperationRpc,
            { p_request_id: requestId, p_operation_key: operationKey }
        );
    });

    it('rejects a gapped or malformed persisted operation history', async () => {
        const rpc = vi.fn().mockResolvedValue({
            data: [successRecord({ attempt: 2, retryCount: 1 })],
            error: null,
        });
        const store = createAnalysisV2AiAttemptStore(rpcClient(rpc));

        await expect(store.loadOperation({ requestId, operationKey }))
            .rejects.toThrow('invalid operation attempt order');
    });

    it.each([
        ['ANALYSIS_V2_AI_ATTEMPT_CONFLICT', AnalysisV2AiAttemptConflictError],
        ['ANALYSIS_V2_AI_ATTEMPT_FENCE_MISMATCH', AnalysisV2AiAttemptFenceError],
        ['ANALYSIS_V2_AI_ATTEMPT_JOB_FENCE_MISMATCH', AnalysisV2AiAttemptFenceError],
        ['ANALYSIS_V2_AI_ATTEMPT_NOT_RETRYABLE', AnalysisV2AiAttemptNotRetryableError],
        ['ANALYSIS_V2_AI_ATTEMPT_NOT_READY', AnalysisV2AiAttemptNotReadyError],
    ])('maps %s to a fail-closed domain error', async (message, ErrorType) => {
        const rpc = vi.fn().mockResolvedValue({
            data: null,
            error: { code: 'P0001', message },
        });
        const store = createAnalysisV2AiAttemptStore(rpcClient(rpc));

        await expect(store.reserve(reservationInput())).rejects.toBeInstanceOf(ErrorType);
    });

    it('does not expose an attempt-ledger purge surface', () => {
        const store = createAnalysisV2AiAttemptStore(rpcClient(vi.fn()));

        expect('purgeTerminal' in store).toBe(false);
        expect('purgeRpc' in ANALYSIS_V2_AI_ATTEMPT_DATABASE_NAMES).toBe(false);
    });
});

const UUID_PATTERN_FOR_EXPECT = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
