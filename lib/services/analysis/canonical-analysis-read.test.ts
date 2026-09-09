import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    CANONICAL_READ_MAX_ROWS,
    analysisCanonicalReadEnabled,
    buildAnalysisParity,
    compareAnalysisCanonicalProjection,
    createAnalysisCanonicalReadStore,
    nextAnalysisCanonicalAuditVersion,
} from './canonical-analysis-read';

const requestId = '123e4567-e89b-42d3-a456-426614174000';

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('analysis canonical shadow reads', () => {
    it('does not allow a partial projection to report a parity match', () => {
        expect(compareAnalysisCanonicalProjection(
            { requestStatus: 'completed' },
            { requestStatus: 'completed' },
        )).toEqual({
            status: 'blocked',
            mismatchPaths: ['comparison.required'],
        });
    });

    it('compares candidate, interaction, order, cost, retention, unknown-source, and every family row', () => {
        const projection = {
            requestStatus: 'completed',
            ownership: 'owned',
            state: 'completed',
            counts: { candidates: 1, interactions: 1 },
            candidate: [{ key: 'candidate:1', rank: 1, score: 8.2 }],
            interaction: [{ key: 'interaction:1', count: 2 }],
            order: [{ key: 'candidate:1', ordinal: 1 }],
            orderHash: 'b'.repeat(64),
            contentHash: 'c'.repeat(64),
            progress: null,
            result: { rank: 1, score: 8.2 },
            providerOperation: 'provider:1',
            cost: {
                amountKnown: 0.12,
                amountConservative: 0.12,
                usageUnknown: false,
                sourceHash: 'a'.repeat(64),
            },
            retention: 'permanent',
            auditRetention: 'permanent',
            unknownSource: false,
            familyRows: {
                jobs: [{ key: 'job:1' }],
                events: [{ key: 'event:1' }],
                artifacts: [{ key: 'artifact:1' }],
                costs: [{ key: 'cost:1' }],
                caches: [],
                audits: [{ key: 'audit:1' }],
            },
        };
        expect(compareAnalysisCanonicalProjection(projection, projection)).toEqual({
            status: 'match',
            mismatchPaths: [],
        });
        expect(compareAnalysisCanonicalProjection(
            { ...projection, unknownSource: true },
            { ...projection, unknownSource: true },
        )).toEqual({
            status: 'blocked',
            mismatchPaths: ['unknownSource'],
        });
        expect(compareAnalysisCanonicalProjection(
            projection,
            {
                ...projection,
                candidate: [{ key: 'candidate:2', rank: 1, score: 8.2 }],
                interaction: [{ key: 'interaction:2', count: 2 }],
                order: [{ key: 'candidate:2', ordinal: 2 }],
                cost: { ...projection.cost, amountKnown: 0.13 },
                retention: 'fenced',
                unknownSource: true,
                familyRows: {
                    ...projection.familyRows,
                    audits: [{ key: 'audit:2' }],
                },
            },
        )).toEqual({
            status: 'mismatch',
            mismatchPaths: [
                'candidate',
                'interaction',
                'order',
                'cost',
                'retention',
                'unknownSource',
                'familyRows',
            ],
        });
    });

    it('reports checksum drift even when aggregate counts match', () => {
        expect(buildAnalysisParity({
            source: { count: 2, checksum: 'a'.repeat(64), complete: true },
            canonical: { count: 2, checksum: 'b'.repeat(64), complete: true },
        })).toEqual({ status: 'mismatch', mismatchPaths: ['checksum'] });
    });

    it('compares ownership, state, counts, ordering, hashes, cost, retention, and unknown-source dimensions', () => {
        const source = {
            count: 2,
            checksum: 'a'.repeat(64),
            complete: true,
            ownership: 'owned',
            state: 'succeeded',
            counts: { completed: 2, blocked: 0 },
            orderHash: 'b'.repeat(64),
            contentHash: 'c'.repeat(64),
            cost: { amountKnown: 0.12, amountConservative: 0.12, usageUnknown: false },
            retention: 'permanent',
            unknownSource: false,
        };
        const canonical = { ...source };
        expect(buildAnalysisParity({ source, canonical })).toEqual({
            status: 'match',
            mismatchPaths: [],
        });

        expect(buildAnalysisParity({
            source,
            canonical: {
                ...canonical,
                ownership: 'unowned',
                state: 'blocked',
                counts: { completed: 1, blocked: 1 },
                orderHash: 'd'.repeat(64),
                contentHash: 'e'.repeat(64),
                cost: { amountKnown: null, amountConservative: 0.12, usageUnknown: true },
                retention: 'fenced',
                unknownSource: true,
            },
        })).toEqual({
            status: 'mismatch',
            mismatchPaths: [
                'ownership',
                'state',
                'counts',
                'orderHash',
                'contentHash',
                'cost',
                'retention',
                'unknownSource',
            ],
        });
    });

    it('blocks a missing legacy source rather than treating an empty canonical set as equal', () => {
        expect(buildAnalysisParity({
            source: null,
            canonical: { count: 0, checksum: null, complete: false },
        })).toEqual({ status: 'blocked', mismatchPaths: ['source.missing'] });
    });

    it('keeps canonical read flags family-specific and disabled by default', () => {
        expect(analysisCanonicalReadEnabled('jobs', {})).toBe(false);
        expect(analysisCanonicalReadEnabled('jobs', {
            ANALYSIS_CANONICAL_JOBS_READ: 'true',
        })).toBe(true);
        expect(analysisCanonicalReadEnabled('cost', {
            ANALYSIS_CANONICAL_JOBS_READ: 'true',
        })).toBe(false);
    });

    it('allocates a new immutable audit version for a late cost observation', () => {
        expect(nextAnalysisCanonicalAuditVersion([1], true)).toBe(2);
        expect(nextAnalysisCanonicalAuditVersion([1, 2, 4], true)).toBe(5);
    });

    it('exposes the cache family as a bounded typed collection', async () => {
        vi.stubEnv('ANALYSIS_CANONICAL_CACHE_READ', 'true');
        const client = {
            rpc: vi.fn(async () => ({
                data: {
                    jobs: [],
                    events: [],
                    artifacts: [],
                    costs: [],
                    caches: [{
                        id: '123e4567-e89b-42d3-a456-426614174003',
                        scope: 'ai',
                        cache_key_hash: 'a'.repeat(64),
                        state: 'ready',
                        expires_at: '2026-09-10T00:00:00.000Z',
                        single_flight_token_hash: null,
                        payload: {},
                        created_at: '2026-09-09T20:00:00.000Z',
                        updated_at: '2026-09-09T20:00:00.000Z',
                    }],
                    audits: [],
                },
                error: null,
            })),
        };
        const store = createAnalysisCanonicalReadStore(client);

        await expect(store.loadRequest(requestId, 'cache')).resolves.toMatchObject({
            caches: [{ scope: 'ai', state: 'ready' }],
        });
        expect(client.rpc).toHaveBeenCalledWith('load_analysis_canonical_family', {
            p_request_id: requestId,
            p_family: 'cache',
        });
    });

    it('rejects unknown or oversized family arrays before they reach callers', async () => {
        vi.stubEnv('ANALYSIS_CANONICAL_JOBS_READ', 'true');
        const oversized = {
            jobs: Array.from({ length: CANONICAL_READ_MAX_ROWS + 1 }, () => ({ state: 'succeeded' })),
            events: [],
            artifacts: [],
            costs: [],
            caches: [],
            audits: [],
        };
        const oversizedStore = createAnalysisCanonicalReadStore({
            rpc: vi.fn(async () => ({ data: oversized, error: null })),
        });
        await expect(oversizedStore.loadRequest(requestId, 'jobs'))
            .rejects.toThrow('oversized canonical jobs collection');

        const unknownStore = createAnalysisCanonicalReadStore({
            rpc: vi.fn(async () => ({
                data: {
                    jobs: [],
                    events: [],
                    artifacts: [],
                    costs: [],
                    caches: 'not-an-array',
                    audits: [],
                },
                error: null,
            })),
        });
        await expect(unknownStore.loadRequest(requestId, 'jobs'))
            .rejects.toThrow('invalid canonical caches collection');
    });

    it('rejects a canonical row that omits required schema fields', async () => {
        vi.stubEnv('ANALYSIS_CANONICAL_JOBS_READ', 'true');
        const store = createAnalysisCanonicalReadStore({
            rpc: vi.fn(async () => ({
                data: {
                    jobs: [{ state: 'succeeded' }],
                    events: [],
                    artifacts: [],
                    costs: [],
                    caches: [],
                    audits: [],
                },
                error: null,
            })),
        });
        await expect(store.loadRequest(requestId, 'jobs'))
            .rejects.toThrow('missing required canonical jobs field');
    });

    it('rejects null request ids in required canonical family rows', async () => {
        vi.stubEnv('ANALYSIS_CANONICAL_EVIDENCE_READ', 'true');
        const store = createAnalysisCanonicalReadStore({
            rpc: vi.fn(async () => ({
                data: {
                    jobs: [],
                    events: [{
                        id: 1,
                        request_id: null,
                        job_id: null,
                        kind: 'progress',
                        state: 'completed',
                        payload: {},
                        content_hash: 'a'.repeat(64),
                        retention_class: 'standard',
                        created_at: '2026-09-09T20:00:00.000Z',
                    }],
                    artifacts: [],
                    costs: [],
                    caches: [],
                    audits: [],
                },
                error: null,
            })),
        });
        await expect(store.loadRequest(requestId, 'evidence'))
            .rejects.toThrow('invalid or missing required canonical events field');
    });

    it('falls back to the legacy projection on a normalized shadow mismatch', async () => {
        vi.stubEnv('ANALYSIS_CANONICAL_JOBS_READ', 'true');
        const client = {
            rpc: vi.fn(async () => ({ data: {}, error: null })),
        };
        const onMismatch = vi.fn();
        const store = createAnalysisCanonicalReadStore(client, { onMismatch });
        const legacy = {
            requestStatus: 'completed',
            ownership: 'owned',
            state: 'completed',
            counts: { candidates: 1, interactions: 1 },
            candidate: [{ key: 'candidate:1', rank: 1, score: 8.2 }],
            interaction: [{ key: 'interaction:1', count: 2 }],
            order: [{ key: 'candidate:1', ordinal: 1 }],
            orderHash: 'b'.repeat(64),
            contentHash: 'c'.repeat(64),
            progress: null,
            result: { rank: 1, score: 8.2 },
            providerOperation: 'provider:1',
            cost: {
                amountKnown: 0.12,
                amountConservative: 0.12,
                usageUnknown: false,
                sourceHash: 'a'.repeat(64),
            },
            retention: 'permanent',
            auditRetention: 'permanent',
            unknownSource: false,
            familyRows: { jobs: [], events: [], artifacts: [], costs: [], caches: [], audits: [] },
        };
        const canonical = { ...legacy, result: { rank: 1, score: 8.1 } };

        await expect(store.shadowRead({
            family: 'jobs',
            legacy: async () => legacy,
            canonical: async () => canonical,
            compare: (left, right) => compareAnalysisCanonicalProjection(left, right),
        })).resolves.toEqual(legacy);
        expect(onMismatch).toHaveBeenCalledWith({
            family: 'jobs',
            summary: { status: 'mismatch', mismatchPaths: ['result'] },
        });
        expect(JSON.stringify(onMismatch.mock.calls)).not.toContain(requestId);
    });

    it('fails open to legacy when canonical is enabled without a comparator', async () => {
        vi.stubEnv('ANALYSIS_CANONICAL_JOBS_READ', 'true');
        const onMismatch = vi.fn();
        const store = createAnalysisCanonicalReadStore({
            rpc: vi.fn(async () => ({ data: {}, error: null })),
        }, { onMismatch });
        const legacy = { requestStatus: 'completed' };

        await expect(store.shadowRead({
            family: 'jobs',
            legacy: async () => legacy,
            canonical: async () => ({ requestStatus: 'wrong' }),
        } as never)).resolves.toEqual(legacy);
        expect(onMismatch).toHaveBeenCalledWith({
            family: 'jobs',
            summary: { status: 'blocked', mismatchPaths: ['comparison.missing'] },
        });
    });

    it('fails open to legacy when the canonical comparator throws', async () => {
        vi.stubEnv('ANALYSIS_CANONICAL_JOBS_READ', 'true');
        const onMismatch = vi.fn();
        const store = createAnalysisCanonicalReadStore({
            rpc: vi.fn(async () => ({ data: {}, error: null })),
        }, { onMismatch });
        const legacy = { requestStatus: 'completed' };

        await expect(store.shadowRead({
            family: 'jobs',
            legacy: async () => legacy,
            canonical: async () => ({ requestStatus: 'completed' }),
            compare: () => { throw new Error('bad comparator'); },
        })).resolves.toEqual(legacy);
        expect(onMismatch).toHaveBeenCalledWith({
            family: 'jobs',
            summary: { status: 'blocked', mismatchPaths: ['comparison.error'] },
        });
    });

    it('sanitizes comparator paths before reporting a mismatch', async () => {
        vi.stubEnv('ANALYSIS_CANONICAL_JOBS_READ', 'true');
        const onMismatch = vi.fn();
        const store = createAnalysisCanonicalReadStore({
            rpc: vi.fn(async () => ({ data: {}, error: null })),
        }, { onMismatch });

        await expect(store.shadowRead({
            family: 'jobs',
            legacy: async () => ({ requestStatus: 'completed' }),
            canonical: async () => ({ requestStatus: 'completed' }),
            compare: () => ({
                status: 'mismatch',
                mismatchPaths: [requestId],
            }),
        })).resolves.toEqual({ requestStatus: 'completed' });
        expect(onMismatch).toHaveBeenCalledWith({
            family: 'jobs',
            summary: { status: 'blocked', mismatchPaths: ['comparison.error'] },
        });
        expect(JSON.stringify(onMismatch.mock.calls)).not.toContain(requestId);
    });
});
