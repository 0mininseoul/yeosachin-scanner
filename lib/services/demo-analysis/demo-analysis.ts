import 'server-only';

import { access } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type {
    AnalysisResultSummaryV1,
    FemaleResultRowV1,
    PrivateResultRowV1,
    ProgressEventV1,
    ProgressSnapshotV1,
} from '@/lib/contracts/analysis-v2';
import { paginateAnalysisResults } from '@/lib/domain/analysis/result-pagination';
import { ANALYSIS_PLAN_CATALOG, PLAN_PRICING_VERSION, buildPlanSelectionCards } from '@/lib/domain/analysis/plan-catalog';

/** The only canonical demo target. Do not duplicate this value in route or SQL code. */
export const DEMO_TARGET_USERNAME = 'junho_dem' as const;
export const DEMO_FIXTURE_VERSION = 'synthetic-fixture-v1' as const;
export const DEMO_ASSET_PREFIX = '/demo-avatars/synthetic-blurred-avatar-' as const;

export function demoResponseCapabilities() {
    return {
        'X-Analytics-Eligible': '0',
        'X-External-Profile-Links': 'disabled',
        'X-Result-Actions': 'disabled',
    } as const;
}

/** Deployment/test guard: synthetic profiles may only reference these local rasters. */
export async function validateDemoAssetManifest(): Promise<string[]> {
    const assets = [1, 2, 3, 4].map(index => `${DEMO_ASSET_PREFIX}${index}-v1.png`);
    await Promise.all(assets.map(async asset => {
        const diskPath = path.join(process.cwd(), 'public', asset);
        await access(diskPath);
        const metadata = await sharp(diskPath).metadata();
        if (metadata.format !== 'png' || !metadata.width || !metadata.height) {
            throw new Error(`Invalid synthetic demo image: ${asset}`);
        }
        const { data, info } = await sharp(diskPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        let edgeTotal = 0;
        let edgeCount = 0;
        for (let y = 1; y < info.height; y += 8) for (let x = 1; x < info.width; x += 8) {
            const offset = (y * info.width + x) * info.channels;
            const left = (y * info.width + x - 1) * info.channels;
            const up = ((y - 1) * info.width + x) * info.channels;
            edgeTotal += Math.abs(data[offset]! - data[left]!) + Math.abs(data[offset]! - data[up]!);
            edgeCount += 2;
        }
        if (edgeTotal / Math.max(1, edgeCount) > 35) throw new Error(`Synthetic demo image is not sufficiently defocused: ${asset}`);
    }));
    return assets;
}

type DemoEnvironment = Readonly<{
    DEMO_ANALYSIS_ENABLED?: string;
    DEMO_ANALYSIS_OPERATOR_USER_IDS?: string;
    DEMO_ANALYSIS_DURATION_SECONDS?: string;
}>;

export function demoDurationSeconds(env: DemoEnvironment = process.env as DemoEnvironment): number {
    const value = Number.parseInt(env.DEMO_ANALYSIS_DURATION_SECONDS ?? '', 10);
    if (!Number.isFinite(value)) return 75;
    return Math.max(60, Math.min(90, value));
}

export function isDemoEligible(
    userId: string,
    rawTargetInstagramId: unknown,
    env: DemoEnvironment = process.env as DemoEnvironment,
): boolean {
    if (rawTargetInstagramId !== DEMO_TARGET_USERNAME) return false;
    return isDemoOperator(userId, env);
}

export function isDemoOperator(userId: string, env: DemoEnvironment = process.env as DemoEnvironment): boolean {
    if (env.DEMO_ANALYSIS_ENABLED !== 'true') return false;
    const operators = (env.DEMO_ANALYSIS_OPERATOR_USER_IDS ?? '')
        .split(',')
        .filter(value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
    return operators.includes(userId);
}

function avatar(index: number): string {
    return `${DEMO_ASSET_PREFIX}${(index % 4) + 1}-v1.png`;
}

function identifier(index: number): string {
    const stems = ['mira.lane', 'sori.park', 'dana.river', 'june.willow'];
    return `${stems[index % stems.length]}.${String(index + 1).padStart(3, '0')}`;
}

function publicAccount(index: number): FemaleResultRowV1 {
    const riskBand = index === 0 ? 'high_risk' : index < 3 ? 'caution' : 'normal';
    const displayScore = index === 0 ? 8 : index < 3 ? 5 : 3;
    return {
        instagramId: identifier(index),
        fullName: ['미라 류', '서린 박', '다나 윤', '주은 한'][index % 4],
        profileImage: avatar(index),
        bio: '일상과 취미를 기록하는 공개 프로필입니다.',
        displayScore,
        riskBand,
        featuredRank: index === 0 ? 1 : index < 3 ? index + 1 : null,
        recentMutualRank: index < 10 ? index + 1 : null,
        analysisDepth: index === 0 ? 'narrative' : 'features',
        oneLineOverview: index === 0
            ? '공개 프로필의 표현과 흐름이 눈에 띄지만 단정할 근거는 아닙니다.'
            : index < 3
                ? '공개 프로필의 최근 표현을 참고 신호로 살펴볼 수 있습니다.'
                : '공개 프로필에서 특별한 주의 신호는 확인되지 않았습니다.',
        highRiskNarrative: index === 0
            ? [
                '공개 프로필의 표현과 흐름이 눈에 띄지만, 굳이 단정할 근거는 아닙니다.',
                '공개 범위에서 확인된 좋아요 표현은 참고 신호이며 수집 범위의 한계가 있습니다.',
            ]
            : null,
    };
}

function privateAccount(index: number): PrivateResultRowV1 {
    return {
        instagramId: `quiet.${['mira', 'sori', 'dana', 'june'][index % 4]}.${String(index + 1).padStart(3, '0')}`,
        fullName: ['민아 류', '소연 박', '다은 윤', '지우 한'][index % 4],
        profileImage: avatar(index),
    };
}

export interface DemoFixture {
    version: typeof DEMO_FIXTURE_VERSION;
    summary: AnalysisResultSummaryV1;
    publicAccounts: FemaleResultRowV1[];
    privateAccounts: PrivateResultRowV1[];
}

export function demoReadyPreflight(run: { id: string; created_at: string }) {
    const counts = { followers: 600, following: 580 };
    const catalog = {
        ...ANALYSIS_PLAN_CATALOG,
        plus: { ...ANALYSIS_PLAN_CATALOG.plus, launchStatus: 'disabled' as const },
    };
    const cards = buildPlanSelectionCards(counts, { catalog });
    return {
        schemaVersion: 1 as const,
        preflightId: run.id,
        expiresAt: new Date(new Date(run.created_at).getTime() + 30 * 60_000).toISOString(),
        status: 'ready' as const,
        exclusionDecision: 'skip' as const,
        target: {
            username: DEMO_TARGET_USERNAME,
            fullName: '준호의 공개 프로필',
            bio: '사진과 일상을 기록하는 공개 프로필입니다.',
            profileImage: avatar(0),
            followersCount: counts.followers,
            followingCount: counts.following,
            isPrivate: false,
        },
        accessMode: 'production' as const,
        capacityRequiredPlan: 'standard' as const,
        requiredPlan: 'standard' as const,
        plans: cards.map(card => ({
            planId: card.planId,
            launchStatus: catalog[card.planId].launchStatus,
            relationshipCapacity: catalog[card.planId].relationshipCapacity,
            detailedMutualLimit: catalog[card.planId].detailedMutualLimit,
            selectionState: card.selectionState,
            unavailableReason: card.unavailableReason,
            pricingVersion: PLAN_PRICING_VERSION,
            price: catalog[card.planId].price,
            remainingSlots: null,
        })),
        pricingVersion: PLAN_PRICING_VERSION,
    };
}

/** Fixed seed-equivalent generator: only its request-independent namespace is rendered. */
export function createDemoFixture(requestId: string): DemoFixture {
    if (!requestId) throw new TypeError('A demo run id is required.');
    const publicAccounts = Array.from({ length: 242 }, (_, index) => publicAccount(index));
    const privateAccounts = Array.from({ length: 142 }, (_, index) => privateAccount(index));
    return {
        version: DEMO_FIXTURE_VERSION,
        summary: {
            targetInstagramId: DEMO_TARGET_USERNAME,
            targetProfileImage: avatar(0),
            planId: 'standard',
            followers: { declared: 600, collected: 600, coverageRatio: 1, meetsCoverageGate: true, exactCountMatch: true },
            following: { declared: 580, collected: 580, coverageRatio: 1, meetsCoverageGate: true, exactCountMatch: true },
            detectedMutuals: 384,
            publicMutuals: 242,
            privateMutuals: 142,
            screenedMutuals: 242,
            genderStats: { male: 112, female: 96, unknown: 34 },
            notScreenedMutuals: 0,
            exclusionApplied: false,
            scorePolicyVersion: 'risk-policy-v2.3',
        },
        publicAccounts,
        privateAccounts,
    };
}

export function demoResultPage(input: {
    requestId: string;
    femaleCursor: string | null;
    privateCursor: string | null;
    pageSize: number;
}) {
    const fixture = createDemoFixture(input.requestId);
    const publicPage = paginateAnalysisResults(fixture.publicAccounts, {
        list: 'public', direction: 'desc', sortKeyType: 'number', cursor: input.femaleCursor,
        pageSize: input.pageSize, getSortKey: row => row.displayScore, getCandidateId: row => row.instagramId,
    });
    const privatePage = paginateAnalysisResults(fixture.privateAccounts, {
        list: 'private', direction: 'asc', sortKeyType: 'string', cursor: input.privateCursor,
        pageSize: input.pageSize, getSortKey: row => row.instagramId, getCandidateId: row => row.instagramId,
    });
    return {
        schemaVersion: 1 as const,
        requestId: input.requestId,
        summary: fixture.summary,
        femaleAccounts: publicPage.items,
        privateAccounts: privatePage.items,
        femaleNextCursor: publicPage.nextCursor,
        privateNextCursor: privatePage.nextCursor,
    };
}

function track(progressBp: number, start: number, end: number, code: string) {
    const ratio = Math.max(0, Math.min(1, (progressBp - start) / Math.max(1, end - start)));
    const done = Math.round(ratio * 100);
    return { state: done === 100 ? 'completed' as const : done === 0 ? 'pending' as const : 'running' as const, stageCode: code, done, total: 100, progressBp: done * 100 };
}

export function projectDemoProgress(input: {
    requestId: string;
    startedAt: Date;
    durationSeconds: number;
    now: Date;
}): { snapshot: ProgressSnapshotV1; events: ProgressEventV1[] } {
    const elapsed = Math.max(0, input.now.getTime() - input.startedAt.getTime());
    const progressBp = Math.min(10_000, Math.floor(elapsed / (input.durationSeconds * 1_000) * 10_000));
    const completed = progressBp === 10_000;
    const tracks = {
        relationshipAi: track(progressBp, 0, 4_000, 'PROFILE_SCREENING'),
        interactions: track(progressBp, 3_000, 8_000, 'TARGET_INTERACTIONS_COLLECTING'),
        finalization: track(progressBp, 7_000, 10_000, 'RESULT_FINALIZING'),
    };
    if (completed) {
        tracks.relationshipAi = track(10_000, 0, 4_000, 'PROFILE_SCREENING');
        tracks.interactions = track(10_000, 3_000, 8_000, 'TARGET_INTERACTIONS_COLLECTING');
        tracks.finalization = track(10_000, 7_000, 10_000, 'RESULT_FINALIZING');
    }
    const events: ProgressEventV1[] = [{
        schemaVersion: 1, requestId: input.requestId, seq: 1, revision: Math.floor(progressBp / 500),
        occurredAt: input.startedAt.toISOString(), state: 'confirmed', eventCode: completed ? 'ANALYSIS_COMPLETED' : 'TARGET_PROFILE_READY',
        copyCode: completed ? 'ANALYSIS_COMPLETED' : progressBp < 2_000 ? 'TARGET_PROFILE_READY' : progressBp < 4_000 ? 'RELATIONSHIPS_COLLECTING' : progressBp < 6_000 ? 'PROFILE_SCREENING' : progressBp < 8_000 ? 'TARGET_INTERACTIONS_COLLECTING' : 'RESULT_FINALIZING', aggregateCount: null,
    }];
    return {
        snapshot: {
            schemaVersion: 1, requestId: input.requestId, revision: Math.floor(progressBp / 500),
            status: completed ? 'completed' : 'processing', progressBp, backgroundProcessing: !completed,
            tracks, activeProfile: completed ? null : { maskedUsername: 'profile.***', imageUrl: avatar(0) },
            etaRange: completed ? null : { lowSeconds: Math.ceil((10_000 - progressBp) / 10_000 * input.durationSeconds), highSeconds: Math.ceil((10_000 - progressBp) / 10_000 * input.durationSeconds) },
            lastEventSeq: 1,
        },
        events,
    };
}
