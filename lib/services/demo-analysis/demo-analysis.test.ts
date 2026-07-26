import { describe, expect, it } from 'vitest';
import {
    DEMO_TARGET_USERNAME,
    createDemoFixture,
    demoDurationSeconds,
    demoPreflightLifecycle,
    isDemoEligible,
    projectDemoProgress,
    demoResultPage,
    validateDemoAssetManifest,
} from './demo-analysis';
import { analysisV2ProgressCopy } from '@/lib/services/analysis/owner-view-presentation';

const ownerId = '123e4567-e89b-42d3-a456-426614174000';
const requestId = '223e4567-e89b-42d3-a456-426614174000';

describe('synthetic demo analysis policy', () => {
    it('requires strict flag, allowlisted owner, and the exact raw target', () => {
        const env = { DEMO_ANALYSIS_ENABLED: 'true', DEMO_ANALYSIS_OPERATOR_USER_IDS: ownerId };
        expect(DEMO_TARGET_USERNAME).toBe('junho_dem');
        expect(isDemoEligible(ownerId, 'junho_dem', env)).toBe(true);
        expect(isDemoEligible(ownerId, 'Junho_dem', env)).toBe(false);
        expect(isDemoEligible(ownerId, ' junho_dem', env)).toBe(false);
        expect(isDemoEligible(ownerId, '@junho_dem', env)).toBe(false);
        expect(isDemoEligible(ownerId, 'junho_dem_', env)).toBe(false);
        expect(isDemoEligible('323e4567-e89b-42d3-a456-426614174000', 'junho_dem', env)).toBe(false);
        expect(isDemoEligible(ownerId, 'junho_dem', { ...env, DEMO_ANALYSIS_ENABLED: 'TRUE' })).toBe(false);
    });

    it('bounds duration without accepting a browser supplied value', () => {
        expect(demoDurationSeconds({ DEMO_ANALYSIS_DURATION_SECONDS: '1' })).toBe(60);
        expect(demoDurationSeconds({ DEMO_ANALYSIS_DURATION_SECONDS: '999' })).toBe(90);
        expect(demoDurationSeconds({})).toBe(75);
    });

    it('expires an unstarted preflight exactly at its boundary but preserves a started replay', () => {
        const createdAt = new Date('2026-07-01T00:00:00.000Z');
        const run = { id: requestId, created_at: createdAt.toISOString(), started_at: null };
        expect(demoPreflightLifecycle(run, new Date(+createdAt + 30 * 60_000 - 1))).toBe('ready');
        expect(demoPreflightLifecycle(run, new Date(+createdAt + 30 * 60_000))).toBe('expired');
        expect(demoPreflightLifecycle({ ...run, started_at: new Date(+createdAt + 1).toISOString() }, new Date(+createdAt + 31 * 60_000)))
            .toBe('consumed');
    });
});

describe('synthetic demo fixture', () => {
    it('uses only existing local permanently defocused raster assets', async () => {
        await expect(validateDemoAssetManifest()).resolves.toEqual([
            '/demo-avatars/synthetic-blurred-avatar-1-v1.png',
            '/demo-avatars/synthetic-blurred-avatar-2-v1.png',
            '/demo-avatars/synthetic-blurred-avatar-3-v1.png',
            '/demo-avatars/synthetic-blurred-avatar-4-v1.png',
        ]);
    });

    it('is deterministic and has exact synthetic relationship totals', () => {
        const first = createDemoFixture(requestId);
        expect(first).toEqual(createDemoFixture(requestId));
        expect(first.publicAccounts).toHaveLength(242);
        expect(first.privateAccounts).toHaveLength(142);
        expect(new Set(first.publicAccounts.map(row => row.instagramId)).size).toBe(242);
        expect(first.publicAccounts.filter(row => row.riskBand === 'high_risk')).toHaveLength(1);
        expect(first.publicAccounts.filter(row => row.riskBand === 'caution').length).toBeGreaterThanOrEqual(2);
        expect(first.publicAccounts.every(row => Number.isInteger(row.displayScore))).toBe(true);
        expect(first.publicAccounts.every(row => row.displayScore >= 1 && row.displayScore <= 10)).toBe(true);
        expect(first.publicAccounts.filter(row => row.riskBand === 'caution')).toHaveLength(2);
        expect(first.publicAccounts.every(row => !row.instagramId.startsWith('synth.'))).toBe(true);
        expect(first.publicAccounts.every(row => !/가상 프로필|비공개 프로필/u.test(row.fullName ?? ''))).toBe(true);
        expect(first.summary.genderStats.male + first.summary.genderStats.female + first.summary.genderStats.unknown)
            .toBe(first.summary.screenedMutuals);
    });

    it('derives monotonic server progress from persisted start time and never fails', () => {
        const startedAt = new Date('2026-07-01T00:00:00.000Z');
        const early = projectDemoProgress({ requestId, startedAt, durationSeconds: 75, now: new Date(+startedAt + 10_000) });
        const later = projectDemoProgress({ requestId, startedAt, durationSeconds: 75, now: new Date(+startedAt + 50_000) });
        const done = projectDemoProgress({ requestId, startedAt, durationSeconds: 75, now: new Date(+startedAt + 75_000) });
        expect(early.snapshot.progressBp).toBeLessThan(later.snapshot.progressBp);
        expect(later.snapshot.status).toBe('processing');
        expect(done.snapshot.status).toBe('completed');
        expect(done.snapshot.progressBp).toBe(10_000);
        expect(done.snapshot.backgroundProcessing).toBe(false);
        expect([...early.events, ...later.events, ...done.events].every(event => event.eventCode !== 'FINDING_CORRECTED')).toBe(true);
    });

    it('emits the product progress schedule in order at each phase boundary', () => {
        const startedAt = new Date('2026-07-01T00:00:00.000Z');
        const expected = [
            'TARGET_PROFILE_READY', 'RELATIONSHIPS_COLLECTING', 'TARGET_INTERACTIONS_COLLECTING',
            'PUBLIC_PROFILES_COLLECTING', 'PROFILE_SCREENING', 'PRIVATE_NAMES_SCREENING', 'EVIDENCE_JOINING',
            'CANDIDATES_RANKING', 'SHORTLIST_INTERACTIONS_COLLECTING', 'PARTNER_CONTEXT_CHECKING',
            'FINAL_SCORE_CALCULATING', 'HIGH_RISK_NARRATIVES_WRITING', 'RESULT_FINALIZING', 'ANALYSIS_COMPLETED',
        ];
        expected.forEach((copyCode, index) => {
            const result = projectDemoProgress({
                requestId,
                startedAt,
                durationSeconds: 100,
                now: new Date(+startedAt + [0, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 94, 100][index]! * 1_000),
            });
            expect(result.events.at(-1)?.copyCode).toBe(copyCode);
            if (copyCode === 'PROFILE_SCREENING') {
                expect(result.events.at(-1)?.eventCode).toBe('PROFILE_SCREENED');
            }
            expect(analysisV2ProgressCopy({ ...result.snapshot, events: result.events }))
                .not.toBe('서버에서 판독을 진행하고 있습니다.');
        });
    });

    it('walks every public and private cursor page without duplicates', () => {
        let publicCursor: string | null = null;
        let privateCursor: string | null = null;
        const publicIds = new Set<string>();
        const privateIds = new Set<string>();
        do {
            const page = demoResultPage({ requestId, femaleCursor: publicCursor, privateCursor, pageSize: 50 });
            page.femaleAccounts.forEach(row => publicIds.add(row.instagramId));
            page.privateAccounts.forEach(row => privateIds.add(row.instagramId));
            publicCursor = page.femaleNextCursor;
            privateCursor = page.privateNextCursor;
        } while (publicCursor || privateCursor);
        expect(publicIds).toHaveLength(242);
        expect(privateIds).toHaveLength(142);
    });
});
