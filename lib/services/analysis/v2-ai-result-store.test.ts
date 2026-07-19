import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const observabilityMocks = vi.hoisted(() => ({ emit: vi.fn() }));

vi.mock('@/lib/observability/server', () => ({
    operationalLogger: { emit: observabilityMocks.emit },
}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

beforeEach(() => {
    observabilityMocks.emit.mockReset();
});

import {
    ANALYSIS_V2_AI_RESULT_DATABASE_NAMES,
    AnalysisV2AiResultConflictError,
    AnalysisV2AiResultFenceError,
    createAnalysisV2AiAuditAdapter,
    createAnalysisV2AiMediaSnapshotHash,
    createAnalysisV2AiMediaSnapshotHashFromParts,
    createAnalysisV2AiResultContentHash,
    createAnalysisV2AiResultIdentity,
    createAnalysisV2AiResultInputHash,
    createAnalysisV2AiResultStore,
    type AnalysisV2AiResultCheckpoint,
    type AnalysisV2AiResultIdentity,
    type AnalysisV2AiResultStore,
    type AnalysisV2AiResultSupabaseClient,
    type AnalysisV2AiResultTerminalInput,
} from './v2-ai-result-store';
import type {
    AnalysisV2AiAttemptReservation,
    AnalysisV2AiAttemptStore,
} from './v2-ai-attempt-store';
import type {
    GeminiAttemptStartTelemetry,
    GeminiAttemptTelemetry,
} from '@/lib/services/ai/gemini';

const resultSchema = z.object({
    value: z.enum(['female', 'male', 'uncertain']),
    confidence: z.number().min(0).max(1),
}).strict();
type Result = z.infer<typeof resultSchema>;

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const jobKey = 'track:profile-ai:batch:0';
const claimToken = '123e4567-e89b-42d3-a456-426614174001';
const reservationToken = '123e4567-e89b-42d3-a456-426614174002';
const createdAt = '2026-07-14T03:00:00.000Z';
const canonicalResultJson = '{"confidence":0.9,"value":"female"}';
const resultHash = createAnalysisV2AiResultContentHash(canonicalResultJson);

function identity(
    overrides: Partial<Parameters<typeof createAnalysisV2AiResultIdentity>[0]> = {}
): AnalysisV2AiResultIdentity {
    return createAnalysisV2AiResultIdentity({
        stage: 'genderTriage',
        modelName: 'gemini-3.1-flash-lite',
        thinkingLevel: 'MINIMAL',
        mediaResolution: 'LOW',
        promptVersion: 'gender-triage-v2',
        schemaVersion: 2,
        maxOutputTokens: 2_048,
        inputHash: createAnalysisV2AiResultInputHash('candidate-input:private-name'),
        mediaSnapshotHash: createAnalysisV2AiMediaSnapshotHash(
            'profile:sha256-a|feed-1:sha256-b'
        ),
        cacheScope: 'global_ttl',
        ...overrides,
    });
}

function terminalInput(
    overrides: Partial<AnalysisV2AiResultTerminalInput<Result>> = {}
): AnalysisV2AiResultTerminalInput<Result> {
    return {
        requestId,
        jobKey,
        claimToken,
        resultIdentity: identity(),
        attempt: 1,
        retryCount: 0,
        reservationToken,
        location: 'asia-northeast3',
        mediaCount: 5,
        usageMetadataStatus: 'complete',
        usageComplete: true,
        tokenUsage: {
            promptTokens: 100,
            completionTokens: 20,
            thinkingTokens: 5,
            totalTokens: 125,
        },
        latencyMs: 800,
        estimatedCostUsd: 0.000001,
        finishReason: 'STOP',
        result: { value: 'female', confidence: 0.9 },
        ...overrides,
    };
}

function generatedCheckpoint(
    overrides: Partial<AnalysisV2AiResultCheckpoint<Result>> = {}
): AnalysisV2AiResultCheckpoint<Result> {
    return {
        requestId,
        jobKey,
        ...identity(),
        source: 'generated',
        attempt: 1,
        reservationToken,
        result: { value: 'female', confidence: 0.9 },
        resultHash,
        chargeStatus: 'generated_complete',
        usageMetadataStatus: 'complete',
        usageComplete: true,
        tokenUsage: {
            promptTokens: 100,
            completionTokens: 20,
            thinkingTokens: 5,
            totalTokens: 125,
        },
        latencyMs: 800,
        estimatedCostUsd: 0.000001,
        finishReason: 'STOP',
        createdAt,
        ...overrides,
    };
}

function cachedCheckpoint(
    overrides: Partial<AnalysisV2AiResultCheckpoint<Result>> = {}
): AnalysisV2AiResultCheckpoint<Result> {
    return generatedCheckpoint({
        source: 'global_cache',
        attempt: null,
        reservationToken: null,
        chargeStatus: 'cache_hit',
        usageMetadataStatus: null,
        usageComplete: null,
        tokenUsage: null,
        latencyMs: null,
        estimatedCostUsd: null,
        finishReason: null,
        ...overrides,
    });
}

function rpcClient(...responses: Array<{
    data: unknown;
    error: null | { code?: string; message?: string };
}>) {
    const rpc = vi.fn<(
        name: string,
        params: Record<string, unknown>
    ) => Promise<{
        data: unknown;
        error: null | { code?: string; message?: string };
    }>>(async () => responses.shift() ?? { data: null, error: null });
    return {
        rpc,
        client: { rpc } as AnalysisV2AiResultSupabaseClient,
    };
}

function terminalized(checkpoint = generatedCheckpoint()) {
    return { outcome: 'checkpointed', checkpoint };
}

function startTelemetry(
    overrides: Partial<GeminiAttemptStartTelemetry> = {}
): GeminiAttemptStartTelemetry {
    return {
        requestId,
        modelName: 'gemini-3.1-flash-lite',
        location: 'asia-northeast3',
        stage: 'genderTriage',
        thinkingLevel: 'MINIMAL',
        mediaCount: 5,
        mediaResolution: 'LOW',
        promptVersion: 'gender-triage-v2',
        schemaVersion: 2,
        maxOutputTokens: 2_048,
        attempt: 1,
        retryCount: 0,
        ...overrides,
    };
}

function attemptTelemetry(
    overrides: Partial<GeminiAttemptTelemetry> = {}
): GeminiAttemptTelemetry {
    return {
        tokenUsage: {
            promptTokens: 100,
            completionTokens: 20,
            thinkingTokens: 5,
            totalTokens: 125,
        },
        usageComplete: true,
        usageMetadataStatus: 'complete',
        modelName: 'gemini-3.1-flash-lite',
        location: 'asia-northeast3',
        stage: 'genderTriage',
        thinkingLevel: 'MINIMAL',
        mediaCount: 5,
        mediaResolution: 'LOW',
        promptVersion: 'gender-triage-v2',
        schemaVersion: 2,
        maxOutputTokens: 2_048,
        latencyMs: 800,
        estimatedCostUsd: 0.000001,
        attempt: 1,
        retryCount: 0,
        disposition: 'success',
        finishReason: 'STOP',
        ...overrides,
    };
}

describe('analysis V2 AI result identity', () => {
    it('hashes raw input and media into a deterministic PII-free policy identity', () => {
        const first = identity();
        const second = identity();

        expect(first).toEqual(second);
        expect(first.inputHash).toBe(
            '2ace182fd8fadb389c3d142fc10a91c6ae8e9017654aaea5de0d756789513dd7'
        );
        expect(first.mediaSnapshotHash).toBe(
            'af0681a1178c3c680a16c3323bae6584da029379ca2d1f46f29ce7d089a864eb'
        );
        expect(first.cacheKey).toBe(
            '5f8d3f6a1385cd3c4a0feed401488f07afd69e059c7dcdffe4a34dbc12d95628'
        );
        expect(first.cacheKey).toMatch(/^[0-9a-f]{64}$/);
        expect(first.operationKey).toBe(`gender-triage:${first.cacheKey}`);
        expect(first.operationKey).not.toContain('private-name');
        expect(identity({ thinkingLevel: 'HIGH' }).cacheKey).not.toBe(first.cacheKey);
        expect(identity({ mediaResolution: 'MEDIUM' }).cacheKey).not.toBe(first.cacheKey);
        expect(identity({ promptVersion: 'gender-triage-v3' }).cacheKey)
            .not.toBe(first.cacheKey);
        expect(identity({ schemaVersion: 3 }).cacheKey).not.toBe(first.cacheKey);
        expect(identity({ maxOutputTokens: 4_096 }).cacheKey).not.toBe(first.cacheKey);
        expect(identity({ inputHash: 'a'.repeat(64) }).cacheKey).not.toBe(first.cacheKey);
        expect(identity({ mediaSnapshotHash: 'b'.repeat(64) }).cacheKey)
            .not.toBe(first.cacheKey);
    });

    it('permits global reuse only for triage and feature analysis', () => {
        expect(() => identity({
            stage: 'highRiskNarrative',
            cacheScope: 'global_ttl',
        })).toThrow('invalid result identity');
        expect(() => identity({
            stage: 'partnerSafety',
            cacheScope: 'global_ttl',
        })).toThrow('invalid result identity');
        expect(identity({
            stage: 'highRiskNarrative',
            cacheScope: 'request',
        }).operationKey).toMatch(/^high-risk-narrative:[0-9a-f]{64}$/);
    });

    it('binds media identity to ordered manifest fields and actual normalized bytes', () => {
        const parts = [{
            selectionId: 'profile:candidate',
            kind: 'profile' as const,
            normalizedJpegBase64: Buffer.from('profile-a').toString('base64'),
        }, {
            selectionId: 'post:1:thumbnail',
            kind: 'feed' as const,
            postId: 'post-1',
            normalizedJpegBase64: Buffer.from('feed-a').toString('base64'),
        }];
        const baseline = createAnalysisV2AiMediaSnapshotHashFromParts(parts);

        expect(createAnalysisV2AiMediaSnapshotHashFromParts([...parts].reverse()))
            .not.toBe(baseline);
        expect(createAnalysisV2AiMediaSnapshotHashFromParts([
            { ...parts[0], normalizedJpegBase64: Buffer.from('profile-b').toString('base64') },
            parts[1],
        ])).not.toBe(baseline);
        expect(createAnalysisV2AiMediaSnapshotHashFromParts([
            parts[0],
            { ...parts[1], selectionId: 'post:2:thumbnail' },
        ])).not.toBe(baseline);
    });
});

describe('analysis V2 AI result store', () => {
    it('atomically terminalizes strict parsed JSON with complete usage telemetry', async () => {
        const fake = rpcClient({ data: terminalized(), error: null });
        const store = createAnalysisV2AiResultStore(fake.client);

        await expect(store.terminalizeSuccess(
            terminalInput(),
            resultSchema
        )).resolves.toEqual(generatedCheckpoint());

        expect(fake.rpc).toHaveBeenCalledOnce();
        const [rpcName, params] = fake.rpc.mock.calls[0]!;
        expect(rpcName).toBe(ANALYSIS_V2_AI_RESULT_DATABASE_NAMES.terminalizeSuccessRpc);
        expect(params).toEqual({
            p_request_id: requestId,
            p_job_key: jobKey,
            p_claim_token: claimToken,
            p_operation_key: identity().operationKey,
            p_attempt: 1,
            p_reservation_token: reservationToken,
            p_telemetry: {
                model_name: 'gemini-3.1-flash-lite',
                location: 'asia-northeast3',
                stage: 'genderTriage',
                thinking_level: 'MINIMAL',
                media_count: 5,
                media_resolution: 'LOW',
                prompt_version: 'gender-triage-v2',
                schema_version: 2,
                max_output_tokens: 2_048,
                retry_count: 0,
                usage_metadata_status: 'complete',
                usage_complete: true,
                prompt_tokens: 100,
                completion_tokens: 20,
                total_tokens: 125,
                thinking_tokens: 5,
                latency_ms: 800,
                estimated_cost_usd: 0.000001,
                finish_reason: 'STOP',
            },
            p_result_identity: {
                stage: 'genderTriage',
                model_name: 'gemini-3.1-flash-lite',
                thinking_level: 'MINIMAL',
                media_resolution: 'LOW',
                prompt_version: 'gender-triage-v2',
                schema_version: 2,
                max_output_tokens: 2_048,
                input_hash: identity().inputHash,
                media_snapshot_hash: identity().mediaSnapshotHash,
                cache_scope: 'global_ttl',
            },
            p_result: { confidence: 0.9, value: 'female' },
            p_result_canonical: canonicalResultJson,
            p_result_hash: resultHash,
        });
    });

    it('rejects a non-strict result before an RPC can charge or persist', async () => {
        const fake = rpcClient();
        const store = createAnalysisV2AiResultStore(fake.client);

        await expect(store.terminalizeSuccess(
            terminalInput({ result: { value: 'female', confidence: 0.9, extra: true } as Result }),
            resultSchema
        )).rejects.toThrow('result schema rejected');
        expect(fake.rpc).not.toHaveBeenCalled();
    });

    it('represents malformed usage as unknown and never fabricates a zero cost', async () => {
        const response = generatedCheckpoint({
            chargeStatus: 'generated_unknown',
            usageMetadataStatus: 'malformed',
            usageComplete: false,
            tokenUsage: null,
            estimatedCostUsd: null,
        });
        const fake = rpcClient({ data: terminalized(response), error: null });
        const store = createAnalysisV2AiResultStore(fake.client);

        await expect(store.terminalizeSuccess(terminalInput({
            usageMetadataStatus: 'malformed',
            usageComplete: false,
            tokenUsage: null,
            estimatedCostUsd: null,
        }), resultSchema)).resolves.toEqual(response);
        const params = fake.rpc.mock.calls[0]![1];
        expect(params.p_telemetry).toMatchObject({
            usage_metadata_status: 'malformed',
            estimated_cost_usd: null,
            prompt_tokens: null,
        });
    });

    it('rejects a terminalization response whose stored JSON differs from the parsed result', async () => {
        const fake = rpcClient({
            data: terminalized(generatedCheckpoint({
                result: { value: 'male', confidence: 0.9 },
                resultHash: createAnalysisV2AiResultContentHash(
                    '{"confidence":0.9,"value":"male"}'
                ),
            })),
            error: null,
        });
        const store = createAnalysisV2AiResultStore(fake.client);

        await expect(store.terminalizeSuccess(terminalInput(), resultSchema))
            .rejects.toThrow('terminal result mismatch');
    });

    it('preserves a telemetry-committed stale-worker fence outcome', async () => {
        const fake = rpcClient({
            data: {
                outcome: 'fenced',
                requestId,
                operationKey: identity().operationKey,
                attempt: 1,
                reservationToken,
            },
            error: null,
        });
        const store = createAnalysisV2AiResultStore(fake.client);

        const error = await store.terminalizeSuccess(terminalInput(), resultSchema)
            .catch(caught => caught);
        expect(error).toBeInstanceOf(AnalysisV2AiResultFenceError);
        expect((error as AnalysisV2AiResultFenceError).telemetryCommitted).toBe(true);
    });

    it('fails closed on a corrupted result hash and exact token-usage drift', async () => {
        const tokenDrift = generatedCheckpoint({
            tokenUsage: {
                promptTokens: 101,
                completionTokens: 19,
                thinkingTokens: 5,
                totalTokens: 125,
            },
        });
        const fake = rpcClient(
            { data: generatedCheckpoint({ resultHash: 'a'.repeat(64) }), error: null },
            { data: terminalized(tokenDrift), error: null }
        );
        const store = createAnalysisV2AiResultStore(fake.client);

        await expect(store.loadRequest({ requestId, resultIdentity: identity() }, resultSchema))
            .rejects.toThrow('result hash');
        await expect(store.terminalizeSuccess(terminalInput(), resultSchema))
            .rejects.toThrow('terminal result mismatch');
    });

    it('snapshots an exact global hit and returns null on a cache miss', async () => {
        const fake = rpcClient(
            { data: cachedCheckpoint(), error: null },
            { data: null, error: null }
        );
        const store = createAnalysisV2AiResultStore(fake.client);
        const input = { requestId, jobKey, claimToken, resultIdentity: identity() };

        await expect(store.checkpointGlobalHit(input, resultSchema))
            .resolves.toEqual(cachedCheckpoint());
        await expect(store.checkpointGlobalHit(input, resultSchema)).resolves.toBeNull();
        expect(fake.rpc).toHaveBeenNthCalledWith(
            1,
            ANALYSIS_V2_AI_RESULT_DATABASE_NAMES.checkpointGlobalHitRpc,
            expect.objectContaining({
                p_request_id: requestId,
                p_operation_key: identity().operationKey,
                p_result_identity: expect.objectContaining({ cache_scope: 'global_ttl' }),
            })
        );
    });

    it('recovers the strict request result without generating again', async () => {
        const fake = rpcClient({ data: generatedCheckpoint(), error: null });
        const store = createAnalysisV2AiResultStore(fake.client);

        await expect(store.loadRequest({
            requestId,
            resultIdentity: identity(),
        }, resultSchema)).resolves.toEqual(generatedCheckpoint());
        expect(fake.rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_AI_RESULT_DATABASE_NAMES.loadRequestRpc,
            {
                p_request_id: requestId,
                p_operation_key: identity().operationKey,
            }
        );
    });

    it('fails closed on response metadata drift and maps durable RPC fences', async () => {
        const drift = generatedCheckpoint({ modelName: 'gemini-wrong-model' });
        const fake = rpcClient(
            { data: drift, error: null },
            { data: null, error: { code: 'P0001', message: 'ANALYSIS_V2_AI_RESULT_CONFLICT' } },
            { data: null, error: { code: 'P0001', message: 'ANALYSIS_V2_AI_RESULT_FENCE_MISMATCH' } }
        );
        const store = createAnalysisV2AiResultStore(fake.client);

        await expect(store.loadRequest({ requestId, resultIdentity: identity() }, resultSchema))
            .rejects.toThrow('metadata drift');
        await expect(store.loadRequest({ requestId, resultIdentity: identity() }, resultSchema))
            .rejects.toBeInstanceOf(AnalysisV2AiResultConflictError);
        await expect(store.loadRequest({ requestId, resultIdentity: identity() }, resultSchema))
            .rejects.toBeInstanceOf(AnalysisV2AiResultFenceError);
    });

    it('separates request-result purge from bounded global-cache maintenance', async () => {
        const fake = rpcClient(
            { data: 3, error: null },
            {
                data: { acquired: true, deletedExpired: 4, deletedOverflow: 2 },
                error: null,
            }
        );
        const store = createAnalysisV2AiResultStore(fake.client);

        await expect(store.purgeRequestResults(requestId)).resolves.toBe(3);
        await expect(store.maintainGlobalCache(500)).resolves.toEqual({
            acquired: true,
            deletedExpired: 4,
            deletedOverflow: 2,
        });
        expect(fake.rpc).toHaveBeenNthCalledWith(
            1,
            ANALYSIS_V2_AI_RESULT_DATABASE_NAMES.purgeRequestRpc,
            { p_request_id: requestId }
        );
        expect(fake.rpc).toHaveBeenNthCalledWith(
            2,
            ANALYSIS_V2_AI_RESULT_DATABASE_NAMES.maintainGlobalCacheRpc,
            { p_delete_limit: 500 }
        );
    });
});

describe('analysis V2 Gemini audit adapter', () => {
    function reservation(
        overrides: Partial<AnalysisV2AiAttemptReservation> = {}
    ): AnalysisV2AiAttemptReservation {
        return {
            requestId,
            jobKey,
            operationKey: identity().operationKey,
            reservationToken,
            attempt: 1,
            retryCount: 0,
            status: 'reserved',
            modelName: 'gemini-3.1-flash-lite',
            location: 'asia-northeast3',
            stage: 'genderTriage',
            thinkingLevel: 'MINIMAL',
            mediaCount: 5,
            mediaResolution: 'LOW',
            promptVersion: 'gender-triage-v2',
            schemaVersion: 2,
            maxOutputTokens: 2_048,
            usageMetadataStatus: null,
            usageComplete: null,
            tokenUsage: null,
            latencyMs: null,
            estimatedCostUsd: null,
            finishReason: null,
            createdAt,
            terminalizedAt: null,
            created: true,
            ...overrides,
        };
    }

    it('reserves before generation and atomically checkpoints the parsed success result', async () => {
        const reserve = vi.fn().mockResolvedValue(reservation());
        const terminalize = vi.fn();
        const terminalizeSuccess = vi.fn().mockResolvedValue(generatedCheckpoint());
        const attemptStore = {
            reserve,
            terminalize,
            loadOperation: vi.fn().mockResolvedValue([]),
        } as unknown as AnalysisV2AiAttemptStore;
        const resultStore = {
            terminalizeSuccess,
            checkpointGlobalHit: vi.fn().mockResolvedValue(null),
            loadRequest: vi.fn().mockResolvedValue(null),
        } as unknown as AnalysisV2AiResultStore;
        const adapter = createAnalysisV2AiAuditAdapter({
            requestId,
            jobKey,
            claimToken,
            resultIdentity: identity(),
            resultSchema,
            attemptStore,
            resultStore,
        });

        await expect(adapter.prepare()).resolves.toMatchObject({ startingAttempt: 1 });
        await adapter.onBeforeAttempt(startTelemetry());
        await adapter.onAttemptTelemetry(
            attemptTelemetry(),
            { value: 'female', confidence: 0.9 }
        );

        expect(reserve).toHaveBeenCalledOnce();
        expect(terminalizeSuccess).toHaveBeenCalledWith(
            expect.objectContaining({
                reservationToken,
                finishReason: 'STOP',
                result: { value: 'female', confidence: 0.9 },
            }),
            resultSchema
        );
        expect(terminalize).not.toHaveBeenCalled();
        expect(observabilityMocks.emit).toHaveBeenCalledOnce();
        expect(observabilityMocks.emit).toHaveBeenCalledWith({
            event: 'gemini.stage_completed',
            severity: 'info',
            fields: {
                analysis_request_id: requestId,
                job_key: jobKey,
                provider: 'gemini',
                operation: 'genderTriage',
                phase: 'terminalize',
                model: 'gemini-3.1-flash-lite',
                thinking_level: 'minimal',
                attempt: 1,
                duration_ms: 800,
                prompt_tokens: 100,
                completion_tokens: 20,
                thinking_tokens: 5,
                estimated_cost_usd: 0.000001,
                disposition: 'success',
            },
        });
        expect(JSON.stringify(observabilityMocks.emit.mock.calls)).not.toMatch(
            /female|confidence|asia-northeast3|gender-triage-v2|profile:sha|STOP/
        );
    });

    it('terminalizes a 429 and resumes only the next contiguous attempt after restart', async () => {
        const reserve = vi.fn()
            .mockResolvedValueOnce(reservation())
            .mockResolvedValueOnce(reservation({
                attempt: 2,
                retryCount: 1,
                reservationToken: '123e4567-e89b-42d3-a456-426614174003',
            }));
        const terminalize = vi.fn().mockResolvedValue({});
        const loadOperation = vi.fn().mockResolvedValue([]);
        const attemptStore = {
            reserve,
            terminalize,
            loadOperation,
        } as unknown as AnalysisV2AiAttemptStore;
        const resultStore = {
            terminalizeSuccess: vi.fn(),
            checkpointGlobalHit: vi.fn().mockResolvedValue(null),
            loadRequest: vi.fn().mockResolvedValue(null),
        } as unknown as AnalysisV2AiResultStore;
        const first = createAnalysisV2AiAuditAdapter({
            requestId,
            jobKey,
            claimToken,
            resultIdentity: identity(),
            resultSchema,
            attemptStore,
            resultStore,
        });

        await first.prepare();
        await first.onBeforeAttempt(startTelemetry());
        await first.onAttemptTelemetry(attemptTelemetry({
            tokenUsage: null,
            usageComplete: false,
            usageMetadataStatus: 'missing',
            estimatedCostUsd: null,
            disposition: 'rate_limited',
            finishReason: null,
        }));
        expect(terminalize).toHaveBeenCalledWith(expect.objectContaining({
            status: 'rate_limited',
            tokenUsage: null,
            estimatedCostUsd: null,
        }));
        expect(observabilityMocks.emit).toHaveBeenCalledOnce();
        expect(observabilityMocks.emit).toHaveBeenCalledWith({
            event: 'gemini.stage_rate_limited',
            severity: 'warn',
            fields: expect.objectContaining({
                analysis_request_id: requestId,
                job_key: jobKey,
                operation: 'genderTriage',
                attempt: 1,
                duration_ms: 800,
                disposition: 'rate_limited',
                error_code: 'RATE_LIMITED',
            }),
        });
        expect(observabilityMocks.emit.mock.calls[0]?.[0].fields)
            .not.toHaveProperty('prompt_tokens');

        const previous = reservation({
            created: undefined,
            status: 'rate_limited',
            usageMetadataStatus: 'missing',
            usageComplete: false,
            latencyMs: 800,
            estimatedCostUsd: null,
            finishReason: null,
            terminalizedAt: '2026-07-14T03:00:01.000Z',
        }) as AnalysisV2AiAttemptReservation;
        loadOperation.mockResolvedValue([previous]);
        const resumed = createAnalysisV2AiAuditAdapter({
            requestId,
            jobKey,
            claimToken,
            resultIdentity: identity(),
            resultSchema,
            attemptStore,
            resultStore,
        });
        await expect(resumed.prepare()).resolves.toMatchObject({
            result: null,
            startingAttempt: 2,
        });
        await resumed.onBeforeAttempt(startTelemetry({
            attempt: 2,
            retryCount: 1,
        }));
        expect(reserve).toHaveBeenLastCalledWith(expect.objectContaining({
            attempt: 2,
            retryCount: 1,
        }));
    });

    it.each([
        {
            disposition: 'ambiguous' as const,
            usage: {
                tokenUsage: null,
                usageComplete: false,
                usageMetadataStatus: 'missing' as const,
                estimatedCostUsd: null,
                finishReason: null,
            },
            errorCode: 'PROVIDER_ERROR',
        },
        {
            disposition: 'rejected' as const,
            usage: {},
            errorCode: 'VALIDATION_ERROR',
        },
        {
            disposition: 'response_rejected' as const,
            usage: {},
            errorCode: 'VALIDATION_ERROR',
        },
    ])('logs a durably terminalized $disposition attempt as a failed stage', async ({
        disposition,
        usage,
        errorCode,
    }) => {
        const attemptStore = {
            reserve: vi.fn().mockResolvedValue(reservation()),
            terminalize: vi.fn().mockResolvedValue({}),
            loadOperation: vi.fn().mockResolvedValue([]),
        } as unknown as AnalysisV2AiAttemptStore;
        const adapter = createAnalysisV2AiAuditAdapter({
            requestId,
            jobKey,
            claimToken,
            resultIdentity: identity(),
            resultSchema,
            attemptStore,
            resultStore: {
                terminalizeSuccess: vi.fn(),
                checkpointGlobalHit: vi.fn().mockResolvedValue(null),
                loadRequest: vi.fn().mockResolvedValue(null),
            } as unknown as AnalysisV2AiResultStore,
        });
        await adapter.prepare();
        await adapter.onBeforeAttempt(startTelemetry());

        await adapter.onAttemptTelemetry(attemptTelemetry({
            disposition,
            ...usage,
        }));

        expect(attemptStore.terminalize).toHaveBeenCalledOnce();
        expect(observabilityMocks.emit).toHaveBeenCalledOnce();
        expect(observabilityMocks.emit).toHaveBeenCalledWith({
            event: 'gemini.stage_failed',
            severity: 'error',
            fields: expect.objectContaining({
                analysis_request_id: requestId,
                job_key: jobKey,
                operation: 'genderTriage',
                disposition,
                error_code: errorCode,
            }),
        });
    });

    it('checks a request checkpoint first and attempt history before a global cache hit', async () => {
        const loadOperation = vi.fn();
        const attemptStore = {
            reserve: vi.fn(),
            terminalize: vi.fn(),
            loadOperation,
        } as unknown as AnalysisV2AiAttemptStore;
        const requestResultStore = {
            terminalizeSuccess: vi.fn(),
            loadRequest: vi.fn().mockResolvedValue(generatedCheckpoint()),
            checkpointGlobalHit: vi.fn(),
        } as unknown as AnalysisV2AiResultStore;
        const requestAdapter = createAnalysisV2AiAuditAdapter({
            requestId,
            jobKey,
            claimToken,
            resultIdentity: identity(),
            resultSchema,
            attemptStore,
            resultStore: requestResultStore,
        });

        await expect(requestAdapter.prepare()).resolves.toMatchObject({
            result: { value: 'female', confidence: 0.9 },
            source: 'request',
        });
        expect(requestResultStore.checkpointGlobalHit).not.toHaveBeenCalled();
        expect(loadOperation).not.toHaveBeenCalled();

        loadOperation.mockResolvedValue([]);
        const cacheResultStore = {
            terminalizeSuccess: vi.fn(),
            loadRequest: vi.fn().mockResolvedValue(null),
            checkpointGlobalHit: vi.fn().mockResolvedValue(cachedCheckpoint()),
        } as unknown as AnalysisV2AiResultStore;
        const cacheAdapter = createAnalysisV2AiAuditAdapter({
            requestId,
            jobKey,
            claimToken,
            resultIdentity: identity(),
            resultSchema,
            attemptStore,
            resultStore: cacheResultStore,
        });

        await expect(cacheAdapter.prepare()).resolves.toMatchObject({
            result: { value: 'female', confidence: 0.9 },
            source: 'global_cache',
        });
        expect(loadOperation).toHaveBeenCalledOnce();
        expect(loadOperation).toHaveBeenCalledBefore(
            vi.mocked(cacheResultStore.checkpointGlobalHit)
        );
    });

    it.each(['reserved', 'success', 'ambiguous', 'rejected'] as const)(
        'blocks restart after a terminal or uncertain %s attempt',
        async status => {
            const last = reservation({
                status,
                ...(status === 'reserved'
                    ? {}
                    : {
                        usageMetadataStatus: status === 'success' ? 'complete' : 'missing',
                        usageComplete: status === 'success',
                        tokenUsage: status === 'success'
                            ? {
                                promptTokens: 100,
                                completionTokens: 20,
                                thinkingTokens: 5,
                                totalTokens: 125,
                            }
                            : null,
                        latencyMs: 800,
                        estimatedCostUsd: status === 'success' ? 0.000001 : null,
                        finishReason: status === 'success' ? 'STOP' : null,
                        terminalizedAt: '2026-07-14T03:00:01.000Z',
                    }),
            });
            const attemptStore = {
                reserve: vi.fn(),
                terminalize: vi.fn(),
                loadOperation: vi.fn().mockResolvedValue([last]),
            } as unknown as AnalysisV2AiAttemptStore;
            const resultStore = {
                terminalizeSuccess: vi.fn(),
                loadRequest: vi.fn().mockResolvedValue(null),
                checkpointGlobalHit: vi.fn().mockResolvedValue(cachedCheckpoint()),
            } as unknown as AnalysisV2AiResultStore;
            const adapter = createAnalysisV2AiAuditAdapter({
                requestId,
                jobKey,
                claimToken,
                resultIdentity: identity(),
                resultSchema,
                attemptStore,
                resultStore,
            });

            await expect(adapter.prepare()).rejects.toThrow(
                'ANALYSIS_V2_AI_RESULT_REPLAY_BLOCKED'
            );
            expect(resultStore.checkpointGlobalHit).not.toHaveBeenCalled();
        }
    );

    it('reconstructs a durable response rejection without reserving another attempt', async () => {
        const last = reservation({
            status: 'response_rejected',
            usageMetadataStatus: 'complete',
            usageComplete: true,
            tokenUsage: {
                promptTokens: 100,
                completionTokens: 20,
                thinkingTokens: 5,
                totalTokens: 125,
            },
            latencyMs: 800,
            estimatedCostUsd: 0.000001,
            finishReason: 'STOP',
            terminalizedAt: '2026-07-14T03:00:01.000Z',
        });
        const attemptStore = {
            reserve: vi.fn(),
            terminalize: vi.fn(),
            loadOperation: vi.fn().mockResolvedValue([last]),
        } as unknown as AnalysisV2AiAttemptStore;
        const resultStore = {
            terminalizeSuccess: vi.fn(),
            loadRequest: vi.fn().mockResolvedValue(null),
            checkpointGlobalHit: vi.fn().mockResolvedValue(null),
        } as unknown as AnalysisV2AiResultStore;
        const adapter = createAnalysisV2AiAuditAdapter({
            requestId,
            jobKey,
            claimToken,
            resultIdentity: identity(),
            resultSchema,
            attemptStore,
            resultStore,
        });

        await expect(adapter.prepare()).rejects.toThrow(
            'AI_GENERATION_RESPONSE_REJECTED_ERROR'
        );
        expect(resultStore.checkpointGlobalHit).not.toHaveBeenCalled();
        expect(attemptStore.reserve).not.toHaveBeenCalled();
        expect(attemptStore.terminalize).not.toHaveBeenCalled();
    });

    it('reconstructs exhausted rate limiting after four contiguous durable attempts without reserving a fifth', async () => {
        const makeAttempt = (
            attempt: number,
            status: AnalysisV2AiAttemptReservation['status'] = 'rate_limited'
        ) => reservation({
            attempt,
            retryCount: attempt - 1,
            status,
            reservationToken: `123e4567-e89b-42d3-a456-42661417400${attempt}`,
            usageMetadataStatus: 'missing',
            usageComplete: false,
            latencyMs: 800,
            estimatedCostUsd: null,
            finishReason: null,
            terminalizedAt: '2026-07-14T03:00:01.000Z',
        });
        const resultStore = {
            terminalizeSuccess: vi.fn(),
            loadRequest: vi.fn().mockResolvedValue(null),
            checkpointGlobalHit: vi.fn().mockResolvedValue(null),
        } as unknown as AnalysisV2AiResultStore;
        const reserve = vi.fn();
        const adapter = createAnalysisV2AiAuditAdapter({
            requestId,
            jobKey,
            claimToken,
            resultIdentity: identity(),
            resultSchema,
            attemptStore: {
                reserve,
                terminalize: vi.fn(),
                loadOperation: vi.fn().mockResolvedValue(
                    [1, 2, 3, 4].map(attempt => makeAttempt(attempt))
                ),
            },
            resultStore,
        });

        await expect(adapter.prepare()).rejects.toMatchObject({
            name: 'AnalysisV2AiResultRateLimitExhaustedError',
            message: 'ANALYSIS_V2_AI_RESULT_RATE_LIMIT_EXHAUSTED',
        });
        expect(resultStore.checkpointGlobalHit).not.toHaveBeenCalled();
        expect(reserve).not.toHaveBeenCalled();
    });

    it('keeps mixed, noncontiguous, and metadata-drift attempt histories replay-blocked', async () => {
        const makeAttempt = (
            attempt: number,
            status: AnalysisV2AiAttemptReservation['status'] = 'rate_limited',
            overrides: Partial<AnalysisV2AiAttemptReservation> = {}
        ) => reservation({
            attempt,
            retryCount: attempt - 1,
            status,
            reservationToken: `123e4567-e89b-42d3-a456-42661417400${attempt}`,
            usageMetadataStatus: 'missing',
            usageComplete: false,
            latencyMs: 800,
            estimatedCostUsd: null,
            finishReason: null,
            terminalizedAt: '2026-07-14T03:00:01.000Z',
            ...overrides,
        });
        const resultStore = {
            terminalizeSuccess: vi.fn(),
            loadRequest: vi.fn().mockResolvedValue(null),
            checkpointGlobalHit: vi.fn().mockResolvedValue(null),
        } as unknown as AnalysisV2AiResultStore;

        for (const history of [
            [makeAttempt(1), makeAttempt(2, 'success'), makeAttempt(3), makeAttempt(4)],
            [makeAttempt(1), makeAttempt(2, 'ambiguous'), makeAttempt(3), makeAttempt(4)],
            [makeAttempt(1), makeAttempt(2), makeAttempt(3), makeAttempt(4, 'reserved')],
            [makeAttempt(1), makeAttempt(2), makeAttempt(4)],
            [
                makeAttempt(1),
                makeAttempt(2),
                makeAttempt(3),
                makeAttempt(4, 'rate_limited', { maxOutputTokens: 4_096 }),
            ],
            [
                makeAttempt(1),
                makeAttempt(2),
                makeAttempt(3),
                makeAttempt(4, 'rate_limited', { mediaCount: 6 }),
            ],
        ]) {
            const reserve = vi.fn();
            const adapter = createAnalysisV2AiAuditAdapter({
                requestId,
                jobKey,
                claimToken,
                resultIdentity: identity(),
                resultSchema,
                attemptStore: {
                    reserve,
                    terminalize: vi.fn(),
                    loadOperation: vi.fn().mockResolvedValue(history),
                },
                resultStore,
            });
            await expect(adapter.prepare()).rejects.toThrow(
                'ANALYSIS_V2_AI_RESULT_REPLAY_BLOCKED'
            );
            expect(reserve).not.toHaveBeenCalled();
        }
    });

    it('rejects max-output policy drift before reserving a paid attempt', async () => {
        const reserve = vi.fn();
        const attemptStore = {
            reserve,
            terminalize: vi.fn(),
            loadOperation: vi.fn().mockResolvedValue([]),
        } as unknown as AnalysisV2AiAttemptStore;
        const resultStore = {
            terminalizeSuccess: vi.fn(),
            loadRequest: vi.fn().mockResolvedValue(null),
            checkpointGlobalHit: vi.fn().mockResolvedValue(null),
        } as unknown as AnalysisV2AiResultStore;
        const adapter = createAnalysisV2AiAuditAdapter({
            requestId,
            jobKey,
            claimToken,
            resultIdentity: identity(),
            resultSchema,
            attemptStore,
            resultStore,
        });
        await adapter.prepare();

        await expect(adapter.onBeforeAttempt(startTelemetry({ maxOutputTokens: 4_096 })))
            .rejects.toThrow('audit metadata drift');
        expect(reserve).not.toHaveBeenCalled();
    });

    it('marks a telemetry-committed stale success terminal and never checkpoints it again', async () => {
        const attemptStore = {
            reserve: vi.fn().mockResolvedValue(reservation()),
            terminalize: vi.fn(),
            loadOperation: vi.fn().mockResolvedValue([]),
        } as unknown as AnalysisV2AiAttemptStore;
        const terminalizeSuccess = vi.fn().mockRejectedValue(
            new AnalysisV2AiResultFenceError(true)
        );
        const resultStore = {
            terminalizeSuccess,
            loadRequest: vi.fn().mockResolvedValue(null),
            checkpointGlobalHit: vi.fn().mockResolvedValue(null),
        } as unknown as AnalysisV2AiResultStore;
        const adapter = createAnalysisV2AiAuditAdapter({
            requestId,
            jobKey,
            claimToken,
            resultIdentity: identity(),
            resultSchema,
            attemptStore,
            resultStore,
        });
        await adapter.prepare();
        await adapter.onBeforeAttempt(startTelemetry());

        await expect(adapter.onAttemptTelemetry(
            attemptTelemetry(),
            { value: 'female', confidence: 0.9 }
        )).rejects.toMatchObject({ telemetryCommitted: true });
        await expect(adapter.onBeforeAttempt(startTelemetry({ attempt: 2, retryCount: 1 })))
            .rejects.toThrow('unexpected attempt reservation');
        expect(terminalizeSuccess).toHaveBeenCalledOnce();
        expect(attemptStore.terminalize).not.toHaveBeenCalled();
        expect(observabilityMocks.emit).toHaveBeenCalledOnce();
        expect(observabilityMocks.emit).toHaveBeenCalledWith(expect.objectContaining({
            event: 'gemini.stage_completed',
            fields: expect.objectContaining({ disposition: 'success' }),
        }));
    });

    it('does not make a committed success fail when the operational logger throws', async () => {
        observabilityMocks.emit.mockImplementation(() => {
            throw new Error('Axiom unavailable');
        });
        const attemptStore = {
            reserve: vi.fn().mockResolvedValue(reservation()),
            terminalize: vi.fn(),
            loadOperation: vi.fn().mockResolvedValue([]),
        } as unknown as AnalysisV2AiAttemptStore;
        const adapter = createAnalysisV2AiAuditAdapter({
            requestId,
            jobKey,
            claimToken,
            resultIdentity: identity(),
            resultSchema,
            attemptStore,
            resultStore: {
                terminalizeSuccess: vi.fn().mockResolvedValue(generatedCheckpoint()),
                checkpointGlobalHit: vi.fn().mockResolvedValue(null),
                loadRequest: vi.fn().mockResolvedValue(null),
            } as unknown as AnalysisV2AiResultStore,
        });
        await adapter.prepare();
        await adapter.onBeforeAttempt(startTelemetry());

        await expect(adapter.onAttemptTelemetry(
            attemptTelemetry(),
            { value: 'female', confidence: 0.9 }
        )).resolves.toBeUndefined();
    });
});
