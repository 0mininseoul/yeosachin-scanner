import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    from: vi.fn(),
    rpc: vi.fn(),
    reconcileProviderCosts: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock('@/lib/services/analysis/provider-cost-reconciliation', () => ({
    reconcileSettledAnalysisProviderCosts: mocks.reconcileProviderCosts,
}));

import { GET } from '@/app/api/admin/analysis-observability/route';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const timestamp = '2026-07-14T02:00:00.000Z';

function v2Payload() {
    return {
        pipelineVersion: 'v2',
        summary: {
            schemaVersion: 1,
            requestId,
            requestStatus: 'completed',
            planId: 'basic',
            timing: {
                createdAt: timestamp,
                firstStartedAt: timestamp,
                completedAt: timestamp,
                wallTimeMs: 240_000,
                queueDelayMs: 5_000,
                processingTimeMs: 235_000,
                providerRuntimeMsTotal: 80_000,
                geminiLatencyMsTotal: 120_000,
            },
            cost: {
                currency: 'USD',
                providerActualUsd: 0.4,
                providerConservativeUsd: 0.4,
                geminiEstimatedUsd: 0.08,
                actualPlusGeminiEstimatedUsd: 0.48,
                conservativePlusGeminiEstimatedUsd: 0.48,
                gcpInfrastructureIncluded: false,
            },
            completeness: {
                costComplete: true,
                pipelineComplete: true,
                resultCoverageAvailable: true,
                providerRunCount: 2,
                providerActiveCount: 0,
                providerUnreconciledCount: 0,
                providerActualCostCount: 2,
                aiAttemptCount: 3,
                aiReservedCount: 0,
                aiMissingUsageCount: 0,
                aiEstimatedCostCount: 3,
                jobCount: 1,
                jobPendingCount: 0,
                jobProcessingCount: 0,
                jobCompletedCount: 1,
                jobFailedCount: 0,
                jobCancelledCount: 0,
                jobAttemptCountTotal: 1,
            },
            geminiUsage: {
                promptTokens: 100,
                completionTokens: 20,
                thinkingTokens: 5,
            },
            profileOutcomes: [{
                jobKey: 'track:profiles:batch:0',
                source: 'selfhosted',
                status: 'success',
                failureCategory: null,
                httpStatus: null,
                outcomeCount: 30,
                requestCount: 30,
                latencyMsTotal: 3_000,
                latencyMsMax: 150,
            }],
            resultCoverage: {
                planId: 'basic',
                followersDeclared: 300,
                followersCollected: 300,
                followingDeclared: 280,
                followingCollected: 280,
                detectedMutuals: 200,
                publicMutuals: 180,
                privateMutuals: 20,
                screenedMutuals: 180,
                notScreenedMutuals: 0,
                fetchUnavailableCount: 2,
                mediaUnavailableCount: 1,
            },
        },
        jobs: [{
            jobKey: 'track:profiles:batch:0',
            track: 'relationship_ai',
            kind: 'profile_fetch',
            batch: 0,
            status: 'completed',
            dispatchState: 'delivered',
            attemptCount: 1,
            firstStartedAt: timestamp,
            completedAt: timestamp,
            durationMs: 3_000,
            lastErrorCode: null,
        }],
    };
}

function request(query = `requestId=${requestId}`, authorization = 'Bearer admin-secret') {
    return new Request(`https://example.com/api/admin/analysis-observability?${query}`, {
        headers: { authorization },
    });
}

function installQueryMocks() {
    const summary = {
        select: vi.fn(),
        eq: vi.fn(),
        maybeSingle: vi.fn(),
    };
    summary.select.mockReturnValue(summary);
    summary.eq.mockReturnValue(summary);
    summary.maybeSingle.mockResolvedValue({
        data: { request_id: requestId, known_total_cost_usd: '1.25' },
        error: null,
    });

    const events = {
        select: vi.fn(),
        eq: vi.fn(),
        order: vi.fn(),
        limit: vi.fn(),
    };
    events.select.mockReturnValue(events);
    events.eq.mockReturnValue(events);
    events.order.mockReturnValue(events);
    events.limit.mockResolvedValue({
        data: [{ id: 'event-id', step: 'collect', event_type: 'completed' }],
        error: null,
    });

    mocks.from.mockImplementation((table: string) => (
        table === 'analysis_operational_cost_summary' ? summary : events
    ));
}

describe('analysis observability admin route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.reconcileProviderCosts.mockResolvedValue({
            eligible: 0,
            finalized: 0,
            failed: 0,
            hasMore: false,
        });
        mocks.rpc.mockResolvedValue({ data: null, error: null });
        process.env.ADMIN_API_KEY = 'admin-secret';
    });

    afterEach(() => {
        delete process.env.ADMIN_API_KEY;
    });

    it('requires the admin bearer token', async () => {
        const response = await GET(request(undefined, 'Bearer wrong'));
        expect(response.status).toBe(401);
        expect(mocks.rpc).not.toHaveBeenCalled();
        expect(mocks.from).not.toHaveBeenCalled();
    });

    it('rejects malformed request IDs before querying', async () => {
        const response = await GET(request('requestId=../../secret'));
        expect(response.status).toBe(400);
        expect(mocks.rpc).not.toHaveBeenCalled();
        expect(mocks.from).not.toHaveBeenCalled();
    });

    it('returns the strict PII-free V2 rollup before any V1 query or reconciliation', async () => {
        mocks.rpc.mockResolvedValue({ data: v2Payload(), error: null });

        const response = await GET(request());

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toMatchObject({
            success: true,
            pipelineVersion: 'v2',
            summary: {
                cost: {
                    providerActualUsd: 0.4,
                    providerConservativeUsd: 0.4,
                    geminiEstimatedUsd: 0.08,
                    gcpInfrastructureIncluded: false,
                },
                completeness: {
                    costComplete: true,
                    providerActiveCount: 0,
                    aiMissingUsageCount: 0,
                },
                profileOutcomes: [{ source: 'selfhosted', outcomeCount: 30 }],
            },
            jobs: [{ jobKey: 'track:profiles:batch:0', attemptCount: 1 }],
            costPolicy: {
                providerCostBasis: 'actual_and_conservative',
                geminiCostBasis: 'estimated',
                gcpInfrastructureIncluded: false,
            },
        });
        expect(mocks.rpc).toHaveBeenCalledWith(
            'load_analysis_v2_operational_observability',
            { p_request_id: requestId }
        );
        expect(mocks.reconcileProviderCosts).not.toHaveBeenCalled();
        expect(mocks.from).not.toHaveBeenCalled();
        expect(JSON.stringify(body)).not.toMatch(
            /"(?:username|profile_snapshot|prompt|evidence|runId)"\s*:/i
        );
    });

    it('returns the cost rollup and PII-free step history', async () => {
        installQueryMocks();
        const response = await GET(request());
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            success: true,
            summary: { request_id: requestId, known_total_cost_usd: '1.25' },
            events: [{ step: 'collect', event_type: 'completed' }],
            costPolicy: {
                scraperEstimateIsDiagnosticOnly: true,
                gcpInfrastructureIncluded: false,
            },
        });
        expect(mocks.reconcileProviderCosts).toHaveBeenCalledWith(
            expect.anything(),
            requestId
        );
    });

    it('fails closed when the V2 RPC returns an unexpected field', async () => {
        mocks.rpc.mockResolvedValue({
            data: {
                ...v2Payload(),
                rawProviderInput: { usernames: ['private.account'] },
            },
            error: null,
        });

        const response = await GET(request());

        expect(response.status).toBe(500);
        expect(mocks.reconcileProviderCosts).not.toHaveBeenCalled();
        expect(mocks.from).not.toHaveBeenCalled();
    });

    it('fails closed when a V2 job key is outside the PII-free DAG vocabulary', async () => {
        const payload = v2Payload();
        payload.jobs[0].jobKey = 'track:private.account:collect';
        payload.summary.profileOutcomes[0].jobKey = 'track:private.account:collect';
        mocks.rpc.mockResolvedValue({ data: payload, error: null });

        const response = await GET(request());

        expect(response.status).toBe(500);
        expect(mocks.reconcileProviderCosts).not.toHaveBeenCalled();
        expect(mocks.from).not.toHaveBeenCalled();
    });

    it('fails closed when V2 cost totals drift from their ledger components', async () => {
        const payload = v2Payload();
        payload.summary.cost.conservativePlusGeminiEstimatedUsd = 9.99;
        mocks.rpc.mockResolvedValue({ data: payload, error: null });

        const response = await GET(request());

        expect(response.status).toBe(500);
        expect(mocks.reconcileProviderCosts).not.toHaveBeenCalled();
        expect(mocks.from).not.toHaveBeenCalled();
    });

    it('fails closed when a profile outcome violates sanitized failure semantics', async () => {
        const payload = v2Payload();
        Object.assign(payload.summary.profileOutcomes[0], {
            failureCategory: 'timeout',
            httpStatus: 504,
        });
        mocks.rpc.mockResolvedValue({ data: payload, error: null });

        const response = await GET(request());

        expect(response.status).toBe(500);
        expect(mocks.reconcileProviderCosts).not.toHaveBeenCalled();
        expect(mocks.from).not.toHaveBeenCalled();
    });
});
