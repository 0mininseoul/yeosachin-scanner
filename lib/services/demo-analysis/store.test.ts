import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), loadPublished: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { rpc: mocks.rpc, from: mocks.from } }));
vi.mock('./fixture-store', () => ({ loadPublishedDemoFixture: mocks.loadPublished }));

import { demoAnalysisStore, isCurrentDemoFixtureRun } from './store';
import { DEMO_FIXTURE_VERSION, REDACTED_DEMO_FIXTURE_VERSION } from './demo-analysis';

const ownerId = '123e4567-e89b-42d3-a456-426614174000';
const otherOwnerId = '223e4567-e89b-42d3-a456-426614174000';
const runId = '323e4567-e89b-42d3-a456-426614174000';
const anotherRunId = '423e4567-e89b-42d3-a456-426614174000';

function row(id = runId, userId = ownerId, startedAt: string | null = null, fixtureVersion = DEMO_FIXTURE_VERSION) {
    return {
        id, user_id: userId, target_instagram_id: 'junho_dem', fixture_version: fixtureVersion,
        idempotency_key: 'demo-idempotency-key-000000', duration_seconds: 38,
        created_at: '2026-07-01T00:00:00.000Z', started_at: startedAt,
    };
}

describe('demo analysis store idempotency and ownership boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.loadPublished.mockResolvedValue({ version: 'operator-editable-fixture-v1', payload: { target: {}, summary: {}, public: [], private: [] } });
    });

    it('preserves a replayed run and start timestamp while a fresh key receives a new run', async () => {
        mocks.rpc
            .mockResolvedValueOnce({ data: [{ ...row(), created: true }], error: null })
            .mockResolvedValueOnce({ data: [{ ...row(), created: false }], error: null })
            .mockResolvedValueOnce({ data: [row(runId, ownerId, '2026-07-01T00:01:00.000Z')], error: null })
            .mockResolvedValueOnce({ data: [row(anotherRunId)], error: null });

        const first = await demoAnalysisStore.createOrReplay({ userId: ownerId, idempotencyKey: 'demo-idempotency-key-000000' });
        const replay = await demoAnalysisStore.createOrReplay({ userId: ownerId, idempotencyKey: 'demo-idempotency-key-000000' });
        const started = await demoAnalysisStore.startForOwner(runId, ownerId);
        const fresh = await demoAnalysisStore.createOrReplay({ userId: ownerId, idempotencyKey: 'another-idempotency-key-000' });

        expect(first).toMatchObject({ created: true, run: { id: runId } });
        expect(replay).toMatchObject({ created: false, run: { id: runId } });
        expect(started?.started_at).toBe('2026-07-01T00:01:00.000Z');
        expect(fresh?.run.id).toBe(anotherRunId);
        expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'create_demo_analysis_preflight', expect.objectContaining({
            p_user_id: ownerId,
            p_duration_seconds: 38,
            p_idempotency_key: expect.not.stringMatching(/^demo-idempotency-key-000000$/),
        }));
    });

    it('recognizes a legacy v1 run without reinterpreting it as the current fixture', async () => {
        mocks.rpc.mockResolvedValue({
            data: [{ ...row(), fixture_version: 'synthetic-fixture-v1', duration_seconds: 75, created: false }],
            error: null,
        });

        const result = await demoAnalysisStore.createOrReplay({ userId: ownerId, idempotencyKey: 'demo-idempotency-key-000000' });

        expect(result?.run.fixture_version).toBe('synthetic-fixture-v1');
        expect(result?.run.duration_seconds).toBe(75);
        expect(result && isCurrentDemoFixtureRun(result.run)).toBe(false);
    });

    it('reads a persisted v3 run without reinterpreting it as the current fixture', async () => {
        mocks.rpc.mockResolvedValue({
            data: [{ ...row(), fixture_version: REDACTED_DEMO_FIXTURE_VERSION, created: false }],
            error: null,
        });

        const result = await demoAnalysisStore.startForOwner(runId, ownerId);

        expect(result?.fixture_version).toBe(REDACTED_DEMO_FIXTURE_VERSION);
        expect(result && isCurrentDemoFixtureRun(result)).toBe(false);
    });

    it('fails closed when the database returns a row for another owner', async () => {
        mocks.rpc.mockResolvedValue({ data: [{ ...row(runId, otherOwnerId), created: true }], error: null });
        await expect(demoAnalysisStore.createOrReplay({ userId: ownerId, idempotencyKey: 'demo-idempotency-key-000000' })).resolves.toBeNull();
        await expect(demoAnalysisStore.startForOwner(runId, ownerId)).resolves.toBeNull();
    });

    it('creates no run when no validated published database fixture exists', async () => {
        mocks.loadPublished.mockResolvedValue(null);
        await expect(demoAnalysisStore.createOrReplay({ userId: ownerId, idempotencyKey: 'demo-idempotency-key-000000' })).resolves.toBeNull();
        expect(mocks.rpc).not.toHaveBeenCalled();
    });
});
