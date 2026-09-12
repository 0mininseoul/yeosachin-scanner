import { describe, expect, it, vi } from 'vitest';
import {
    ANALYSIS_CANONICAL_WRITE_FLAGS,
    createAnalysisCanonicalStore,
    hashAnalysisCanonicalValue,
    analysisCanonicalWriteEnabled,
} from './canonical-analysis-store';

const REQUEST_ID = '423e4567-e89b-42d3-a456-426614174001';
const JOB_ID = '523e4567-e89b-42d3-a456-426614174001';
const NOW = '2026-09-13T00:00:00.000Z';

function client() {
    return { rpc: vi.fn(async () => ({ data: null, error: null })) };
}

describe('retained analysis jobs/events canonical adapter', () => {
    it('exposes only independently switchable retained family flags', () => {
        expect(ANALYSIS_CANONICAL_WRITE_FLAGS).toEqual({
            jobs: 'ANALYSIS_CANONICAL_JOBS_WRITE',
            events: 'ANALYSIS_CANONICAL_EVENTS_WRITE',
        });
        expect(analysisCanonicalWriteEnabled('jobs', {
            ANALYSIS_CANONICAL_JOBS_WRITE: 'true',
        })).toBe(true);
        expect(analysisCanonicalWriteEnabled('events', {
            UNRELATED_FLAG: 'true',
        })).toBe(false);
    });

    it('writes retained jobs and events through their original RPCs', async () => {
        const dependency = client();
        const store = createAnalysisCanonicalStore(dependency, {
            env: {
                ANALYSIS_CANONICAL_JOBS_WRITE: 'true',
                ANALYSIS_CANONICAL_EVENTS_WRITE: 'true',
            },
        });
        await expect(store.recordJob({
            requestId: REQUEST_ID,
            jobKey: 'coordinator:finalize',
            kind: 'finalize',
            state: 'succeeded',
            payload: { successorCount: 0 },
        })).resolves.toEqual({ status: 'appended' });
        await expect(store.appendEvent({
            requestId: REQUEST_ID,
            jobId: JOB_ID,
            kind: 'progress',
            state: 'succeeded',
            payload: { eventCode: 'DONE', tracks: { finalization: { done: true } } },
        })).resolves.toEqual({ status: 'appended' });
        expect(dependency.rpc).toHaveBeenNthCalledWith(
            1,
            'record_analysis_canonical_job',
            expect.objectContaining({ p_request_id: REQUEST_ID }),
        );
        expect(dependency.rpc).toHaveBeenNthCalledWith(
            2,
            'append_analysis_canonical_event',
            expect.objectContaining({ p_request_id: REQUEST_ID, p_job_id: JOB_ID }),
        );
    });

    it('queues only jobs/events retry markers and rejects retired payload vocabulary', async () => {
        const dependency = client();
        dependency.rpc.mockImplementationOnce((async () => ({
            data: {
                id: 1,
                request_id: REQUEST_ID,
                kind: 'operational',
                state: 'canonical_retry',
                payload: { family: 'events', retryKey: `${REQUEST_ID}:events` },
                content_hash: '2f61f8f87e44d6b729349bddd3ddef6eab717c02f710028ffadda7fd7ffb7da6',
                retention_class: 'standard',
                created_at: NOW,
            },
            error: null,
        })) as never);
        const store = createAnalysisCanonicalStore(dependency, { env: {} });
        await expect(store.enqueueRetry(REQUEST_ID, 'events')).resolves.toMatchObject({
            status: 'retry_queued', family: 'events',
        });
        expect(dependency.rpc).toHaveBeenCalledWith('enqueue_analysis_execution_retry_v1', {
            p_request_id: REQUEST_ID, p_family: 'events',
        });
        expect(hashAnalysisCanonicalValue({ ok: true })).toMatch(/^[a-f0-9]{64}$/);
        await expect(store.appendEvent({
            requestId: REQUEST_ID,
            kind: 'progress',
            state: 'failed',
            payload: { artifactKey: 'retired' },
        })).rejects.toThrow('unknown payload key');
    });
});
