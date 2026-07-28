import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    AUTHORIZED_TEXT_DEMO_FIXTURE_VERSION,
    DEMO_FIXTURE_VARIANTS,
    DEMO_FIXTURE_VERSION,
    LEGACY_DEMO_FIXTURE_VERSION,
    REDACTED_DEMO_FIXTURE_VERSION,
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
import { parseSafePublicRiskNarrative } from '@/lib/services/analysis/narrative-privacy';
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
        expect(DEMO_FIXTURE_VERSION).toBe('authorized-redacted-fixture-v4');
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
    it('dispatches legacy and current runs to distinct static fixtures', () => {
        const requestId = '123e4567-e89b-42d3-a456-426614174000';
        const legacy = createDemoFixture(requestId, LEGACY_DEMO_FIXTURE_VERSION);
        const current = createDemoFixture(requestId, DEMO_FIXTURE_VERSION);

        expect(legacy.version).toBe(LEGACY_DEMO_FIXTURE_VERSION);
        expect(current.version).toBe(DEMO_FIXTURE_VERSION);
        expect(legacy.publicAccounts[0]?.instagramId).not.toBe(current.publicAccounts[0]?.instagramId);
    });

    it('retains the original canonical v1 fixture layout for every legacy row', () => {
        const legacy = createDemoFixture(requestId, LEGACY_DEMO_FIXTURE_VERSION);

        expect(legacy.publicAccounts).toHaveLength(242);
        expect(legacy.privateAccounts).toHaveLength(142);
        expect(legacy.publicAccounts.slice(0, 4).map(row => row.displayScore)).toEqual([8, 5, 5, 3]);
        expect(new Set(legacy.publicAccounts.map(row => row.fullName)).size).toBe(4);
        expect(new Set(legacy.privateAccounts.map(row => row.fullName)).size).toBe(4);
        expect(legacy.publicAccounts.filter(row => row.riskBand === 'high_risk')).toHaveLength(1);
        expect(legacy.publicAccounts.filter(row => row.riskBand === 'caution')).toHaveLength(2);
    });

    it('keeps persisted v2 rows on their original fixture namespace', () => {
        const v2 = createDemoFixture(requestId, AUTHORIZED_TEXT_DEMO_FIXTURE_VERSION);
        const v4 = createDemoFixture(requestId, DEMO_FIXTURE_VERSION);
        expect(v2.version).toBe(AUTHORIZED_TEXT_DEMO_FIXTURE_VERSION);
        expect(v2.publicAccounts[0]?.profileImage).toMatch(/^\/demo-avatars\/synthetic-blurred-avatar-/u);
        expect(v4.publicAccounts[0]?.profileImage).toMatch(/^\/demo-avatars\/demo-v3-female-/u);
    });

    it('keeps persisted v3 rows on their original repeated-card fixture', () => {
        const v3 = createDemoFixture(requestId, REDACTED_DEMO_FIXTURE_VERSION);

        expect(v3.version).toBe(REDACTED_DEMO_FIXTURE_VERSION);
        expect(v3.publicAccounts).toHaveLength(242);
        expect(v3.privateAccounts).toHaveLength(142);
    });

    it('dispatches unstarted legacy preflights to their canonical v1 presentation', () => {
        const run = { id: requestId, created_at: '2026-07-01T00:00:00.000Z' };
        const legacy = demoReadyPreflight(run, LEGACY_DEMO_FIXTURE_VERSION);
        const current = demoReadyPreflight(run, DEMO_FIXTURE_VERSION);

        expect(legacy.target).not.toEqual(current.target);
        expect(legacy.target.profileImage).not.toBe(current.target.profileImage);
        expect(legacy.plans).toEqual(current.plans);
    });
    it('uses only existing local permanently defocused raster assets', async () => {
        const assets = await validateDemoAssetManifest();
        expect(assets).toHaveLength(234);
        expect(assets).toContain('/demo-avatars/demo-v3-target-000.webp');
        expect(assets.filter(asset => asset.endsWith('.webp'))).toHaveLength(230);
    });

    it('is deterministic and has exact source-backed relationship totals', () => {
        const first = createDemoFixture(requestId);
        expect(first).toEqual(createDemoFixture(requestId));
        expect(first.publicAccounts).toHaveLength(84);
        expect(first.privateAccounts).toHaveLength(145);
        expect(new Set(first.publicAccounts.map(row => row.instagramId)).size).toBe(84);
        expect(new Set(first.privateAccounts.map(row => row.instagramId)).size).toBe(145);
        expect(first.publicAccounts.filter(row => row.riskBand === 'high_risk')).toHaveLength(1);
        expect(first.publicAccounts.filter(row => row.riskBand === 'caution').length).toBeGreaterThanOrEqual(2);
        expect(first.publicAccounts.every(row => Number.isInteger(row.displayScore))).toBe(true);
        expect(first.publicAccounts.every(row => row.displayScore >= 1 && row.displayScore <= 10)).toBe(true);
        expect(first.publicAccounts.filter(row => row.riskBand === 'caution')).toHaveLength(2);
        expect(first.publicAccounts.flatMap(row => row.featuredRank ?? [])).toEqual([1, 2, 3]);
        expect(first.publicAccounts.flatMap(row => row.recentMutualRank ?? [])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        expect(parseSafePublicRiskNarrative(first.publicAccounts[0]?.highRiskNarrative)).not.toBeNull();
        expect(first.publicAccounts.every(row => !/[\u0000-\u001f\ufffd]/u.test([
            row.fullName ?? '', row.bio ?? '', row.oneLineOverview, ...(row.highRiskNarrative ?? []),
        ].join('')))).toBe(true);
        expect(first.publicAccounts.every(row => !row.instagramId.startsWith('synth.'))).toBe(true);
        expect(first.publicAccounts.every(row => !/가상 프로필|비공개 프로필/u.test(row.fullName ?? ''))).toBe(true);
        expect(first.summary.genderStats.male + first.summary.genderStats.female + first.summary.genderStats.unknown)
            .toBe(first.summary.screenedMutuals);
        expect(first.summary.publicMutuals).toBe(first.publicAccounts.length);
        expect(first.summary.privateMutuals).toBe(first.privateAccounts.length);
        expect(first.summary.screenedMutuals).toBe(first.publicAccounts.length);
    });

    it('uses static redacted v4 text and only local baked blurred avatars', () => {
        const fixture = createDemoFixture(requestId);
        const publicRows = fixture.publicAccounts;
        const preflight = demoReadyPreflight({ id: requestId, created_at: '2026-07-01T00:00:00.000Z' });
        const renderedFixtureText = [
            preflight.target.fullName ?? '',
            preflight.target.bio ?? '',
            ...publicRows.flatMap(row => [
            row.fullName ?? '',
            row.bio ?? '',
            row.oneLineOverview,
            ...(row.highRiskNarrative ?? []),
            ]),
            ...fixture.privateAccounts.flatMap(row => [
                row.fullName ?? '',
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
        expect(renderedFixtureText.every(value => !/(?:https?:\/\/|www\.|instagram(?:\.com)?)/iu.test(value))).toBe(true);
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
            /^\/demo-avatars\/demo-v3-(female|private)-\d{3}\.webp$/u.test(row.profileImage ?? ''),
        )).toBe(true);
    });

    it('keeps the requested current account normal and moves the third featured caution rank to a distinct row', () => {
        const fixture = createDemoFixture(requestId, DEMO_FIXTURE_VERSION);
        const requested = fixture.publicAccounts.find(row => row.instagramId === 'bl1ckcherdk_cuu6');
        const featuredCaution = fixture.publicAccounts.find(row => row.riskBand === 'caution' && row.featuredRank === 3);

        expect(requested).toMatchObject({
            fullName: '이유진',
            riskBand: 'normal',
            displayScore: 3,
            featuredRank: null,
        });
        expect(featuredCaution).toBeDefined();
        expect(featuredCaution?.instagramId).not.toBe(requested?.instagramId);
        expect(fixture.publicAccounts.flatMap(row => row.featuredRank ?? [])).toEqual([1, 2, 3]);
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
        expect(publicIds).toHaveLength(84);
        expect(privateIds).toHaveLength(145);
    });

    it('continues to emit the production result-page DTO for the demo UI', () => {
        const page = demoResultPage({ requestId, femaleCursor: null, privateCursor: null, pageSize: 50 });
        const parsed = analysisResultPageV1Schema.safeParse(page);
        expect(parsed.success).toBe(true);
        expect(page.femaleAccounts).toHaveLength(50);
        expect(page.privateAccounts).toHaveLength(50);
    });

    it('uses only static fixture data at runtime', () => {
        const source = readFileSync(new URL('./demo-analysis.ts', import.meta.url), 'utf8');
        expect(source).not.toMatch(/supabase|createClient|analysis_results|fetch\(/iu);
    });

    it('pins the v4 builder to one fully-ready sealed source and a bijective local derivation', () => {
        const avatarBuilder = readFileSync(new URL('../../../scripts/build-demo-v3-avatars.ts', import.meta.url), 'utf8');
        const fixtureBuilder = readFileSync(new URL('../../../scripts/build-demo-v3-fixture.ts', import.meta.url), 'utf8');
        [avatarBuilder, fixtureBuilder].forEach(source => {
            expect(source).toMatch(/total_objects\s*=\s*230/u);
            expect(source).toMatch(/total_target\s*=\s*1/u);
            expect(source).toMatch(/total_female\s*=\s*84/u);
            expect(source).toMatch(/total_private\s*=\s*145/u);
            expect(source).toMatch(/ready_total\s*=\s*230/u);
            expect(source).toMatch(/ready_target\s*=\s*1/u);
            expect(source).toMatch(/ready_female\s*=\s*84/u);
            expect(source).toMatch(/ready_private\s*=\s*145/u);
        });
        expect(fixtureBuilder).toMatch(/DEMO_V4_CURATED_OVERRIDES/u);
        expect(fixtureBuilder).toContain('Math.round(indexes.length * 0.3)');
        expect(fixtureBuilder).toContain('sourceCandidateId');
        expect(fixtureBuilder).toContain('selectedRunIds.size !== 1');
        expect(fixtureBuilder).toContain('uniqueByImageOrdinal');
        expect(fixtureBuilder).toContain('new Set(publicFixture.map(row => row.imageSortOrdinal))');
        expect(fixtureBuilder).not.toContain('index % orderedPublicRows.length');
        expect(fixtureBuilder).toContain('parseSafePublicRiskNarrative(highRiskNarrative)');
        expect(fixtureBuilder).toContain('narrativeSource.narrative_line_one');
        expect(fixtureBuilder).toContain('const orderedPublicRows = [narrativeSource');
        expect(fixtureBuilder).toContain('KOREAN_WORD_ALTERNATIVES');
        expect(fixtureBuilder).not.toContain('String.fromCodePoint');
    });
});
