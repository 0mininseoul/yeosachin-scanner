import { afterEach, describe, expect, it, vi } from 'vitest';
import {
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
    it('reports checksum drift even when aggregate counts match', () => {
        expect(buildAnalysisParity({
            source: { count: 2, checksum: 'a'.repeat(64), complete: true },
            canonical: { count: 2, checksum: 'b'.repeat(64), complete: true },
        })).toEqual({ status: 'mismatch', mismatchPaths: ['checksum'] });
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

    it('falls back to the legacy projection on a normalized shadow mismatch', async () => {
        vi.stubEnv('ANALYSIS_CANONICAL_JOBS_READ', 'true');
        const client = {
            rpc: vi.fn(async () => ({ data: {}, error: null })),
        };
        const onMismatch = vi.fn();
        const store = createAnalysisCanonicalReadStore(client, { onMismatch });
        const legacy = {
            requestStatus: 'completed',
            result: { rank: 1, score: 8.2 },
        };
        const canonical = {
            requestStatus: 'completed',
            result: { rank: 1, score: 8.1 },
        };

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
});
