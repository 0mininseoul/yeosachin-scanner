import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    DEMO_FIXTURE_VARIANTS,
    DEMO_FIXTURE_VERSION,
    LEGACY_DEMO_FIXTURE_VERSION,
    DEMO_SOURCE_HANDLE_FIXTURE,
    DEMO_SOURCE_PROFILE_FIXTURE,
    DEMO_TARGET_USERNAME,
    createDemoFixture,
    demoReadyPreflight,
    demoDurationSeconds,
    demoPreflightLifecycle,
    isDemoEligible,
    projectDemoProgress,
    demoResultPage,
    validateDemoAssetManifest,
} from './demo-analysis';
import { analysisV2ProgressCopy } from '@/lib/services/analysis/owner-view-presentation';
import { analysisResultPageV1Schema } from '@/lib/contracts/analysis-v2';

const ownerId = '123e4567-e89b-42d3-a456-426614174000';
const requestId = '223e4567-e89b-42d3-a456-426614174000';
const externalFixtureReferencePattern = /(?:https?:)?\/\/|www\.|(?:^|[\s(\[{'":,])[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.(?:xn--[a-z0-9-]{2,59}|\p{L}{2,63})(?:[\/?#:;,!?\])'"]|$|\.(?![\p{L}\p{N}-]))|@|[\r\n]/iu;
const unsafeFixtureIdentifierPattern = /(?:https?:)?\/\/|www\.|@|[\r\n]/iu;

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
        expect(demoDurationSeconds({ DEMO_ANALYSIS_DURATION_SECONDS: '1' })).toBe(30);
        expect(demoDurationSeconds({ DEMO_ANALYSIS_DURATION_SECONDS: '999' })).toBe(45);
        expect(demoDurationSeconds({})).toBe(38);
        expect(DEMO_FIXTURE_VERSION).toBe('authorized-text-fixture-v2');
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

describe('isolated demo fixtures', () => {
    it('dispatches legacy and v2 runs to distinct static fixtures', () => {
        const requestId = '123e4567-e89b-42d3-a456-426614174000';
        const legacy = createDemoFixture(requestId, LEGACY_DEMO_FIXTURE_VERSION);
        const current = createDemoFixture(requestId, DEMO_FIXTURE_VERSION);

        expect(legacy.version).toBe(LEGACY_DEMO_FIXTURE_VERSION);
        expect(current.version).toBe(DEMO_FIXTURE_VERSION);
        expect(legacy.publicAccounts[0]?.instagramId).not.toBe(current.publicAccounts[0]?.instagramId);
    });
    it('uses only existing local permanently defocused raster assets', async () => {
        await expect(validateDemoAssetManifest()).resolves.toEqual([
            '/demo-avatars/synthetic-blurred-avatar-1-v1.png',
            '/demo-avatars/synthetic-blurred-avatar-2-v1.png',
            '/demo-avatars/synthetic-blurred-avatar-3-v1.png',
            '/demo-avatars/synthetic-blurred-avatar-4-v1.png',
        ]);
    });

    it('is deterministic and has exact fixture relationship totals', () => {
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
        expect(DEMO_SOURCE_HANDLE_FIXTURE).toHaveLength(86);
        expect(first.publicAccounts.slice(0, DEMO_SOURCE_HANDLE_FIXTURE.length).map(row => row.instagramId))
            .toEqual(DEMO_SOURCE_HANDLE_FIXTURE);
        expect(first.publicAccounts.slice(0, DEMO_SOURCE_PROFILE_FIXTURE.length).map(row => ({
            fullName: row.fullName,
            bio: row.bio,
        }))).toEqual(DEMO_SOURCE_PROFILE_FIXTURE.map(row => ({
            fullName: row.fullName,
            bio: row.bio,
        })));
        expect(first.summary.genderStats.male + first.summary.genderStats.female + first.summary.genderStats.unknown)
            .toBe(first.summary.screenedMutuals);
    });

    it('uses authorized static v2 text, fictional fallback copy, and only local blurred avatars', () => {
        const fixture = createDemoFixture(requestId);
        const publicRows = fixture.publicAccounts;
        const preflight = demoReadyPreflight({ id: requestId, created_at: '2026-07-01T00:00:00.000Z' });
        const renderedFixtureText = [
            fixture.version,
            fixture.summary.targetProfileImage ?? '',
            fixture.summary.planId,
            fixture.summary.scorePolicyVersion,
            preflight.target.username,
            preflight.target.fullName ?? '',
            preflight.target.bio ?? '',
            preflight.target.profileImage ?? '',
            ...preflight.plans.flatMap(plan => [
                plan.planId,
                plan.launchStatus,
                plan.selectionState,
                plan.unavailableReason ?? '',
                plan.pricingVersion,
                plan.price.status,
                plan.price.currency,
            ]),
            ...publicRows.flatMap(row => [
            row.fullName ?? '',
            row.profileImage ?? '',
            row.bio ?? '',
            row.oneLineOverview,
            ...(row.highRiskNarrative ?? []),
            ]),
            ...fixture.privateAccounts.flatMap(row => [
                row.fullName ?? '',
                row.profileImage ?? '',
            ]),
        ];
        const renderedFixtureIdentifiers = [
            fixture.summary.targetInstagramId,
            preflight.target.username,
            ...publicRows.map(row => row.instagramId),
            ...fixture.privateAccounts.map(row => row.instagramId),
        ];

        expect(new Set(publicRows.map(row => row.fullName)).size).toBeGreaterThanOrEqual(16);
        expect(new Set(publicRows.map(row => row.bio)).size).toBeGreaterThanOrEqual(12);
        expect(new Set(publicRows.map(row => row.oneLineOverview)).size).toBeGreaterThanOrEqual(12);
        expect(new Set(fixture.privateAccounts.map(row => row.fullName)).size).toBeGreaterThanOrEqual(16);
        expect(renderedFixtureText.every(value => !externalFixtureReferencePattern.test(value))).toBe(true);
        expect(renderedFixtureIdentifiers.every(value => !unsafeFixtureIdentifierPattern.test(value))).toBe(true);
        expect(externalFixtureReferencePattern.test('preview.example.xyz/path')).toBe(true);
        expect(externalFixtureReferencePattern.test('(example.xyz)')).toBe(true);
        expect(externalFixtureReferencePattern.test('xn--bcher-kva.xn--p1ai')).toBe(true);
        expect(externalFixtureReferencePattern.test('유니코드.한국')).toBe(true);
        expect(externalFixtureReferencePattern.test('"example.xyz"')).toBe(true);
        expect(externalFixtureReferencePattern.test('링크:example.xyz')).toBe(true);
        expect(externalFixtureReferencePattern.test('링크,example.xyz')).toBe(true);
        expect(externalFixtureReferencePattern.test('링크[example.xyz]')).toBe(true);
        expect([...publicRows, ...fixture.privateAccounts].every(row =>
            /^\/demo-avatars\/synthetic-blurred-avatar-[1-4]-v1\.png$/u.test(row.profileImage ?? ''),
        )).toBe(true);
    });

    it('keeps every named fixture selector within its template range', () => {
        expect(DEMO_FIXTURE_VARIANTS).toHaveLength(86);
        DEMO_FIXTURE_VARIANTS.forEach(variant => {
            expect(variant.handleIndex).toBeGreaterThanOrEqual(0);
            expect(variant.handleIndex).toBeLessThan(24);
            expect(variant.nameIndex).toBeGreaterThanOrEqual(0);
            expect(variant.nameIndex).toBeLessThan(24);
            expect(variant.bioIndex).toBeGreaterThanOrEqual(0);
            expect(variant.bioIndex).toBeLessThan(18);
            expect(variant.overviewIndex).toBeGreaterThanOrEqual(0);
            expect(variant.overviewIndex).toBeLessThan(18);
        });
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
        const activeProfile = early.snapshot.activeProfile?.maskedUsername ?? '';
        expect(activeProfile).not.toBe('profile.***');
        expect(activeProfile.endsWith('*')).toBe(true);
        expect(createDemoFixture(requestId).publicAccounts.some(row => row.instagramId === activeProfile.slice(0, -1))).toBe(true);
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

    it('continues to emit the production result-page DTO for the demo UI', () => {
        const page = demoResultPage({ requestId, femaleCursor: null, privateCursor: null, pageSize: 50 });
        expect(analysisResultPageV1Schema.safeParse(page).success).toBe(true);
        expect(page.femaleAccounts).toHaveLength(50);
        expect(page.privateAccounts).toHaveLength(50);
    });

    it('uses only static fixture data at runtime', () => {
        const source = readFileSync(new URL('./demo-analysis.ts', import.meta.url), 'utf8');
        expect(source).not.toMatch(/supabase|createClient|analysis_results|fetch\(/iu);
    });
});
