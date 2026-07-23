import { describe, expect, it } from 'vitest';
import {
    analysisPlanBadgePresentation,
    analysisV2EventCopy,
    analysisV2ProgressCopy,
    boundedOwnerResultPage,
    DEFAULT_THREAT_METER_SEGMENTS,
    genderBreakdownFromStats,
    paginatedCountLabel,
    paginatedRangeLabel,
    roundedOwnerScore,
    threatMeterFillCount,
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

    it('presents provisional high-risk events without turning them into confirmed facts', () => {
        expect(analysisV2EventCopy('POTENTIAL_HIGH_RISK_FOUND'))
            .toContain('고위험 여성 후보 발견');
        expect(analysisV2EventCopy('POTENTIAL_HIGH_RISK_FOUND'))
            .toContain('단서를 더 맞춰보고');
        expect(analysisV2EventCopy('UNKNOWN_CODE'))
            .toBe('새로운 판독 단서를 확인하고 있습니다.');
    });

    it('marks incomplete paginated counts and becomes exact on the final page', () => {
        expect(paginatedCountLabel(50, true)).toBe('50+');
        expect(paginatedCountLabel(73, false)).toBe('73');
    });

    it('labels the current bounded result page without accumulating prior rows', () => {
        expect(boundedOwnerResultPage(Array.from({ length: 900 }, (_, index) => index)))
            .toHaveLength(50);
        expect(paginatedRangeLabel(0, 50, true)).toBe('1-50+');
        expect(paginatedRangeLabel(1, 50, true)).toBe('51-100+');
        expect(paginatedRangeLabel(2, 23, false)).toBe('101-123');
    });

    it('defaults the threat meter to a 10-segment gauge', () => {
        expect(DEFAULT_THREAT_METER_SEGMENTS).toBe(10);
    });

    it('fills one segment per rounded score point on the default 10-segment gauge', () => {
        const s = DEFAULT_THREAT_METER_SEGMENTS;
        expect(threatMeterFillCount({ grade: 'normal', displayScore: 1, segments: s })).toBe(1);
        expect(threatMeterFillCount({ grade: 'caution', displayScore: 4.2, segments: s })).toBe(4);
        expect(threatMeterFillCount({ grade: 'high_risk', displayScore: 6.8, segments: s })).toBe(7);
        expect(threatMeterFillCount({ grade: 'high_risk', displayScore: 10, segments: s })).toBe(10);
    });

    it('keeps the score-less grade fallback on the default 10-segment gauge', () => {
        const s = DEFAULT_THREAT_METER_SEGMENTS;
        expect(threatMeterFillCount({ grade: 'high_risk', segments: s })).toBe(9);
        expect(threatMeterFillCount({ grade: 'caution', segments: s })).toBe(6);
        expect(threatMeterFillCount({ grade: 'normal', segments: s })).toBe(3);
    });

    it('matches the filled segment count to the displayed rounded score', () => {
        const s = DEFAULT_THREAT_METER_SEGMENTS;
        for (const [grade, score] of [
            ['normal', 1.2],
            ['caution', 4.2],
            ['caution', 5.5],
            ['high_risk', 6.8],
            ['high_risk', 9.9],
        ] as const) {
            expect(threatMeterFillCount({ grade, displayScore: score, segments: s }))
                .toBe(roundedOwnerScore(score));
        }
    });

    it('rounds the owner display score to a whole number', () => {
        expect(roundedOwnerScore(6.8)).toBe(7);
        expect(roundedOwnerScore(6.4)).toBe(6);
        expect(roundedOwnerScore(9)).toBe(9);
        expect(roundedOwnerScore(5.5)).toBe(6);
    });

    it('converts gender stat counts into 0-safe percentages', () => {
        expect(genderBreakdownFromStats({ male: 6, female: 3, unknown: 1 })).toEqual({
            male: { count: 6, percentage: 60 },
            female: { count: 3, percentage: 30 },
            unknown: { count: 1, percentage: 10 },
        });
    });

    it('treats an all-zero gender split as zero percent everywhere', () => {
        expect(genderBreakdownFromStats({ male: 0, female: 0, unknown: 0 })).toEqual({
            male: { count: 0, percentage: 0 },
            female: { count: 0, percentage: 0 },
            unknown: { count: 0, percentage: 0 },
        });
    });

    it('rounds each gender percentage independently', () => {
        expect(genderBreakdownFromStats({ male: 1, female: 1, unknown: 1 })).toEqual({
            male: { count: 1, percentage: 33 },
            female: { count: 1, percentage: 33 },
            unknown: { count: 1, percentage: 33 },
        });
    });

    it('presents every supported plan explicitly and keeps legacy null rows basic', () => {
        expect(analysisPlanBadgePresentation('basic')).toMatchObject({
            planId: 'basic', label: 'BASIC',
        });
        expect(analysisPlanBadgePresentation('standard')).toMatchObject({
            planId: 'standard', label: 'STANDARD',
        });
        expect(analysisPlanBadgePresentation('plus')).toMatchObject({
            planId: 'plus', label: 'PLUS',
        });
        expect(analysisPlanBadgePresentation(null).planId).toBe('basic');
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
