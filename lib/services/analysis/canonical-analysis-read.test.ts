import { describe, expect, it, vi } from 'vitest';
import {
    ANALYSIS_CANONICAL_READ_FLAGS,
    analysisCanonicalReadEnabled,
    buildAnalysisParity,
    createAnalysisCanonicalReadStore,
} from './canonical-analysis-read';

const REQUEST_ID = '423e4567-e89b-42d3-a456-426614174001';

describe('retained analysis jobs/events canonical reader', () => {
    it('uses separate retained jobs/events read flags', () => {
        expect(ANALYSIS_CANONICAL_READ_FLAGS).toEqual({
            jobs: 'ANALYSIS_CANONICAL_JOBS_READ',
            events: 'ANALYSIS_CANONICAL_EVENTS_READ',
        });
        expect(analysisCanonicalReadEnabled('events', {
            ANALYSIS_CANONICAL_EVENTS_READ: '1',
        })).toBe(true);
        expect(analysisCanonicalReadEnabled('events', {
            UNRELATED_FLAG: '1',
        })).toBe(false);
    });

    it('loads a two-array execution bundle through the new RPC', async () => {
        const rpc = vi.fn(async () => ({ data: { jobs: [], events: [] }, error: null }));
        const store = createAnalysisCanonicalReadStore({ rpc }, {
            env: { ANALYSIS_CANONICAL_JOBS_READ: 'true' },
        });
        await expect(store.loadRequest(REQUEST_ID, 'jobs')).resolves.toEqual({ jobs: [], events: [] });
        expect(rpc).toHaveBeenCalledWith('load_analysis_execution_family_v1', {
            p_request_id: REQUEST_ID,
            p_family: 'jobs',
        });
    });

    it('fails open for disabled families and rejects retired response collections', async () => {
        const rpc = vi.fn(async () => ({
            data: { jobs: [], events: [], audits: [] }, error: null,
        }));
        const store = createAnalysisCanonicalReadStore({ rpc }, {
            env: { ANALYSIS_CANONICAL_EVENTS_READ: 'true' },
        });
        await expect(store.loadRequest(REQUEST_ID, 'jobs')).resolves.toBeNull();
        await expect(store.loadRequest(REQUEST_ID, 'events')).rejects.toThrow('unknown canonical collection');
    });

    it('compares retained aggregate dimensions only', () => {
        expect(buildAnalysisParity({
            source: { count: 1, checksum: 'a'.repeat(64), complete: true, state: 'done' },
            canonical: { count: 1, checksum: 'a'.repeat(64), complete: true, state: 'done' },
        })).toEqual({ status: 'match', mismatchPaths: [] });
        expect(buildAnalysisParity({
            source: { count: 1, checksum: 'a'.repeat(64), complete: true },
            canonical: null,
        })).toEqual({ status: 'blocked', mismatchPaths: ['canonical.missing'] });
    });
});
