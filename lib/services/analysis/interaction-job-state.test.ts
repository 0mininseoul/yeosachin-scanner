import { describe, expect, it } from 'vitest';
import {
    requireCompletedInteractionJob,
    requireNoIncompleteInteractionJobs,
} from './interaction-job-state';

describe('interaction job state guards', () => {
    const completed = {
        kind: 'target_likers',
        batch_index: 0,
        status: 'completed' as const,
    };

    it('accepts only the requested completed job', () => {
        expect(() => requireCompletedInteractionJob(
            [completed],
            'target_likers',
            0
        )).not.toThrow();
        expect(() => requireCompletedInteractionJob(
            [{ ...completed, status: 'failed' }],
            'target_likers',
            0
        )).toThrow('INTERACTION_PROVIDER_ERROR');
        expect(() => requireCompletedInteractionJob(
            [{ ...completed, status: 'running' }],
            'target_likers',
            0
        )).toThrow('INTERACTION_PROVIDER_ERROR');
        expect(() => requireCompletedInteractionJob(
            [completed],
            'target_comments',
            0
        )).toThrow('INTERACTION_PROVIDER_ERROR');
    });

    it('refuses scoring while any persisted job is failed or running', () => {
        expect(() => requireNoIncompleteInteractionJobs([completed])).not.toThrow();
        expect(() => requireNoIncompleteInteractionJobs([
            completed,
            { ...completed, status: 'failed' },
        ])).toThrow('INTERACTION_PROVIDER_ERROR');
        expect(() => requireNoIncompleteInteractionJobs([
            { ...completed, status: 'running' },
        ])).toThrow('INTERACTION_PROVIDER_ERROR');
    });
});
