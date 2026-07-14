import { describe, expect, it } from 'vitest';
import {
    ownerAnalysisHistoryV1Schema,
    ownerHistoryTargetLabel,
} from './owner-history';

const completedV2History = {
    schemaVersion: 1,
    items: [{
        id: '123e4567-e89b-42d3-a456-426614174000',
        targetInstagramId: '0_min._.00',
        status: 'completed',
        createdAt: '2026-07-14T05:00:00+00:00',
        planType: 'standard',
        pipelineVersion: 'v2',
    }],
} as const;

describe('owner analysis history contract', () => {
    it('accepts the final V2 summary username and renders it as an account', () => {
        const parsed = ownerAnalysisHistoryV1Schema.parse(completedV2History);

        expect(ownerHistoryTargetLabel(parsed.items[0])).toBe('@0_min._.00');
    });

    it('keeps a failed V2 request redacted without rendering a tombstone as a username', () => {
        const parsed = ownerAnalysisHistoryV1Schema.parse({
            ...completedV2History,
            items: [{
                ...completedV2History.items[0],
                targetInstagramId: null,
                status: 'failed',
            }],
        });

        expect(ownerHistoryTargetLabel(parsed.items[0])).toBe('보호 처리된 계정');
    });

    it('preserves a legacy V1 username while rejecting a leaked V2 retained tombstone', () => {
        expect(ownerAnalysisHistoryV1Schema.safeParse({
            ...completedV2History,
            items: [{
                ...completedV2History.items[0],
                targetInstagramId: 'Legacy.User',
                pipelineVersion: 'v1',
            }],
        }).success).toBe(true);

        expect(ownerAnalysisHistoryV1Schema.safeParse({
            ...completedV2History,
            items: [{
                ...completedV2History.items[0],
                targetInstagramId: 'retained.123e4567e89b42d3a456',
            }],
        }).success).toBe(false);
    });

    it('rejects unversioned, extra-field, and malformed history payloads', () => {
        expect(ownerAnalysisHistoryV1Schema.safeParse(completedV2History.items).success)
            .toBe(false);
        expect(ownerAnalysisHistoryV1Schema.safeParse({
            ...completedV2History,
            extra: true,
        }).success).toBe(false);
        expect(ownerAnalysisHistoryV1Schema.safeParse({
            ...completedV2History,
            items: [{
                ...completedV2History.items[0],
                targetInstagramId: '<script>',
            }],
        }).success).toBe(false);
    });
});
