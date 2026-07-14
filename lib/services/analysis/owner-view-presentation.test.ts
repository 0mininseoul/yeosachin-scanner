import { describe, expect, it } from 'vitest';
import {
    analysisV2ProgressCopy,
    paginatedCountLabel,
    v2ResultFailureAction,
} from './owner-view-presentation';

describe('owner view presentation behavior', () => {
    const historicalEvent = [{ copyCode: 'RELATIONSHIPS_COLLECTED' }];

    it('prioritizes the active masked profile over the active stage and historical event', () => {
        expect(analysisV2ProgressCopy({
            status: 'processing',
            tracks: {
                relationshipAi: { state: 'running', stageCode: 'PROFILE_SCREENING' },
            },
            events: historicalEvent,
            activeProfile: { maskedUsername: 'w****n' },
        })).toBe('@w****n · 맞팔 계정을 판독하고 있습니다.');
    });

    it('uses the current running stage before a historical milestone', () => {
        expect(analysisV2ProgressCopy({
            status: 'processing',
            tracks: {
                relationshipAi: { state: 'running', stageCode: 'PROFILE_SCREENING' },
            },
            events: historicalEvent,
            activeProfile: null,
        })).toBe('맞팔 계정을 판독하고 있습니다.');
    });

    it('uses a historical milestone only when no work is currently running', () => {
        expect(analysisV2ProgressCopy({
            status: 'queued',
            tracks: {
                relationshipAi: { state: 'pending', stageCode: 'RELATIONSHIP_AI_QUEUED' },
            },
            events: historicalEvent,
            activeProfile: null,
        })).toBe('맞팔 관계를 정리했습니다.');
    });

    it('marks incomplete paginated counts and becomes exact on the final page', () => {
        expect(paginatedCountLabel(50, true)).toBe('50+');
        expect(paginatedCountLabel(73, false)).toBe('73');
    });

    it('redirects only a 404 with a durable progress view and never redirects server failures', () => {
        expect(v2ResultFailureAction({ resultStatus: 404, progressStatus: 'processing' }))
            .toBe('show_progress');
        expect(v2ResultFailureAction({ resultStatus: 404, progressStatus: 'failed' }))
            .toBe('show_progress');
        expect(v2ResultFailureAction({ resultStatus: 404, progressStatus: 'completed' }))
            .toBe('show_error');
        expect(v2ResultFailureAction({ resultStatus: 500, progressStatus: 'processing' }))
            .toBe('show_error');
    });
});
