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
export const DEMO_PREFLIGHT_TTL_MS = 30 * 60_000;

export function demoResponseCapabilities() {
    return {
        'X-Analytics-Eligible': '0',
        'X-External-Profile-Links': 'disabled',
        'X-Result-Actions': 'disabled',
    } as const;
}

/**
 * Public contract for every response after a request has been recognized as a
 * synthetic demo request.  Keep this free of internal run state: clients only
 * need to know that analytics and actionable result affordances are disabled.
 */
export function demoResponseHeaders() {
    return {
        ...demoResponseCapabilities(),
        'Cache-Control': 'private, no-store, max-age=0',
        Vary: 'Cookie',
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

export function demoPreflightLifecycle(
    run: { created_at: string; started_at: string | null },
    now: Date = new Date(),
): 'ready' | 'expired' | 'consumed' {
    if (run.started_at) return 'consumed';
    return new Date(run.created_at).getTime() + DEMO_PREFLIGHT_TTL_MS <= now.getTime()
        ? 'expired'
        : 'ready';
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

/**
 * Deliberately fictional, hand-written derivatives for the isolated fixture.
 * They make the result screens read naturally without carrying a source handle,
 * name, profile image, URL, or verbatim account copy into the demo domain.
 */
const DEMO_PUBLIC_HANDLES = [
    'dawn.notebook', 'mood.weekend', 'olive.window', 'slow.morning',
    'paper.and.light', 'tiny.blue.room', 'walk.after.rain', 'blooming.shelf',
    'film.in.april', 'softly.recorded', 'bookish.afternoon', 'cloudy.kitchen',
    'dayoff.palette', 'smalltown.frame', 'sunny.corner', 'weekend.postcard',
    'quietly.made', 'garden.on.table', 'little.moonlog', 'warmth.archive',
    'everyday.glass', 'notes.by.river', 'tangerine.desk', 'mellow.weekdays',
] as const;

const DEMO_PUBLIC_NAMES = [
    '윤하린', '서유진', '김도아', '박나율', '한소민', '이채온',
    '정유라', '최다은', '문서연', '강하진', '오지안', '류세빈',
    '배수아', '신예린', '임다현', '권유나', '남지수', '송하은',
    '장민서', '노아린', '황지우', '백소율', '유채린', '조은별',
] as const;

const DEMO_PUBLIC_BIOS = [
    '아침 산책과 작은 기록을 좋아해요.',
    '주말마다 새로운 전시를 찾아갑니다.',
    '커피, 책, 그리고 느린 오후.',
    '집밥과 계절 꽃을 담아두는 중이에요.',
    '필름 카메라로 일상을 남깁니다.',
    '퇴근 뒤 가볍게 달리고 있어요.',
    '좋아하는 음악을 차곡차곡 모읍니다.',
    '낯선 동네의 빵집을 기록해요.',
    '반려식물과 함께 사는 집의 이야기.',
    '여행 전에는 꼭 지도를 오래 봐요.',
    '손으로 만드는 취미를 좋아합니다.',
    '비 오는 날의 창가를 특히 좋아해요.',
    '친구들과 나눈 식사를 기억합니다.',
    '작은 운동 루틴을 이어가는 중이에요.',
    '읽고 본 것들을 천천히 정리합니다.',
    '도시의 저녁 풍경을 자주 찍어요.',
    '매일 한 장의 사진을 남기고 있어요.',
    '주말의 여유를 배우는 중입니다.',
] as const;

const DEMO_PUBLIC_OVERVIEWS = [
    '공개 프로필의 최근 기록에서 가벼운 참고 신호가 보입니다.',
    '일상 게시물의 흐름을 함께 살펴볼 수 있는 프로필입니다.',
    '공개 범위의 표현은 맥락을 확인하며 참고할 만합니다.',
    '최근 기록은 평이하며 별도의 주의 신호는 크지 않습니다.',
    '공개된 취미 기록이 비교적 일관되게 이어집니다.',
    '게시물의 분위기는 차분하며 판단을 서두를 근거는 없습니다.',
    '공개 프로필의 활동 흐름을 참고 수준으로 확인할 수 있습니다.',
    '일상 사진과 짧은 기록이 자연스럽게 이어지는 계정입니다.',
    '표현의 변화는 있으나 공개 정보만으로 의미를 단정하기 어렵습니다.',
    '공개 범위에서 확인된 내용은 추가 맥락과 함께 보는 편이 좋습니다.',
    '최근 게시물은 일반적인 일상 공유 흐름에 가깝습니다.',
    '프로필 소개와 게시물의 주제가 무난하게 이어집니다.',
    '공개 기록에는 제한적인 참고 요소만 확인됩니다.',
    '짧은 일상 업데이트가 중심인 공개 프로필입니다.',
    '게시물의 흐름은 안정적이며 특별한 경고 신호는 보이지 않습니다.',
    '공개된 정보는 참고용으로만 조심스럽게 해석할 수 있습니다.',
    '최근 활동은 취미와 일상 기록 위주로 구성되어 있습니다.',
    '표현의 결은 다양하지만 단정적인 해석은 피하는 편이 좋습니다.',
] as const;

/**
 * One-time, in-memory transformation of the authorized source result.  Each
 * tuple selects fictional handle/name/bio/overview variants only; it contains
 * no source identifier, profile copy, image path, URL, or source hash.
 */
const DEMO_AUTHORIZED_SOURCE_VARIANTS = [
    [4, 18, 0, 6], [13, 21, 7, 4], [20, 11, 2, 12], [8, 0, 10, 12],
    [9, 20, 1, 0], [6, 13, 6, 0], [8, 23, 16, 7], [3, 5, 4, 3],
    [18, 23, 10, 17], [13, 23, 9, 10], [5, 0, 15, 5], [6, 21, 16, 12],
    [2, 3, 0, 4], [10, 18, 15, 7], [4, 22, 13, 6], [23, 23, 16, 2],
    [20, 4, 7, 8], [6, 12, 2, 13], [2, 20, 10, 14], [22, 5, 3, 12],
    [18, 8, 2, 10], [13, 21, 3, 3], [5, 11, 0, 10], [5, 2, 9, 14],
    [23, 1, 16, 0], [14, 5, 2, 5], [5, 17, 0, 2], [2, 9, 12, 7],
    [18, 16, 8, 16], [7, 6, 17, 12], [18, 14, 4, 0], [17, 19, 5, 6],
    [13, 3, 1, 5], [8, 4, 13, 2], [12, 3, 3, 6], [22, 9, 8, 1],
    [14, 0, 4, 16], [12, 8, 5, 13], [9, 4, 1, 4], [17, 23, 12, 8],
    [0, 0, 2, 4], [22, 8, 1, 6], [12, 1, 5, 5], [7, 5, 1, 0],
    [14, 22, 4, 2], [1, 21, 10, 0], [14, 7, 13, 13], [11, 4, 9, 13],
    [12, 4, 0, 7], [5, 5, 6, 6], [17, 18, 7, 8], [6, 20, 13, 10],
    [4, 21, 3, 11], [13, 15, 2, 5], [16, 0, 2, 17], [5, 6, 5, 4],
    [20, 7, 12, 11], [8, 6, 7, 0], [6, 19, 17, 7], [17, 8, 12, 15],
    [7, 20, 5, 17], [3, 4, 8, 10], [6, 8, 16, 13], [0, 8, 16, 9],
    [14, 11, 3, 6], [0, 20, 4, 17], [1, 2, 11, 7], [1, 12, 2, 14],
    [16, 1, 2, 11], [1, 13, 16, 1], [2, 17, 12, 13], [23, 3, 15, 6],
    [10, 21, 1, 13], [8, 23, 16, 4], [12, 2, 9, 10], [16, 2, 9, 2],
    [13, 11, 2, 2], [12, 0, 7, 10], [1, 6, 9, 7], [14, 5, 17, 4],
    [5, 17, 11, 15], [3, 12, 11, 10], [18, 6, 1, 3], [2, 23, 9, 16],
    [18, 17, 11, 1], [19, 14, 2, 4],
] as const;

const DEMO_PRIVATE_HANDLES = [
    'locked.dawn', 'locked.mood', 'locked.olive', 'locked.slow',
    'locked.paper', 'locked.blue', 'locked.walk', 'locked.bloom',
    'locked.film', 'locked.soft', 'locked.book', 'locked.cloud',
    'locked.palette', 'locked.frame', 'locked.sunny', 'locked.postcard',
    'locked.quiet', 'locked.garden', 'locked.moon', 'locked.warmth',
    'locked.glass', 'locked.river', 'locked.tangerine', 'locked.mellow',
] as const;

const DEMO_PRIVATE_NAMES = [
    '김가을', '이유빈', '박소정', '최하나', '정유빈', '한예원',
    '오서진', '문하늘', '배유나', '신다인', '임수빈', '권채아',
    '남유리', '송예진', '장서아', '노유진', '황다빈', '백하린',
    '유소연', '조다은', '차예린', '진수아', '표지민', '구채원',
] as const;

function fixtureIdentifier(stems: readonly string[], index: number): string {
    return `${stems[index % stems.length]}.${String(index + 1).padStart(3, '0')}`;
}

function publicAccount(index: number): FemaleResultRowV1 {
    const [handleIndex, nameIndex, bioIndex, overviewIndex] = DEMO_AUTHORIZED_SOURCE_VARIANTS[
        index % DEMO_AUTHORIZED_SOURCE_VARIANTS.length
    ]!;
    const riskBand = index === 0 ? 'high_risk' : index < 3 ? 'caution' : 'normal';
    const displayScore = index === 0 ? 8 : index === 1 ? 6 : index === 2 ? 5 : [3, 3, 2, 2, 1][index % 5]!;
    return {
        instagramId: fixtureIdentifier(DEMO_PUBLIC_HANDLES, handleIndex + index * DEMO_PUBLIC_HANDLES.length),
        fullName: DEMO_PUBLIC_NAMES[nameIndex]!,
        profileImage: avatar(index),
        bio: DEMO_PUBLIC_BIOS[bioIndex]!,
        displayScore,
        riskBand,
        featuredRank: index === 0 ? 1 : index < 3 ? index + 1 : null,
        recentMutualRank: index < 10 ? index + 1 : null,
        analysisDepth: index === 0 ? 'narrative' : 'features',
        oneLineOverview: DEMO_PUBLIC_OVERVIEWS[overviewIndex]!,
        highRiskNarrative: index === 0
            ? [
                '공개 프로필과 최근 흐름은 굳이 눈에 띄지만, 단정할 근거는 아닙니다.',
                '좋아요 흔적은 제법 친절하지만 수집 범위 밖의 맥락까지 없다고 믿기는 이릅니다.',
            ]
            : null,
    };
}

function privateAccount(index: number): PrivateResultRowV1 {
    return {
        instagramId: fixtureIdentifier(DEMO_PRIVATE_HANDLES, index),
        fullName: DEMO_PRIVATE_NAMES[index % DEMO_PRIVATE_NAMES.length]!,
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
        expiresAt: new Date(new Date(run.created_at).getTime() + DEMO_PREFLIGHT_TTL_MS).toISOString(),
        status: 'ready' as const,
        exclusionDecision: 'skip' as const,
        target: {
            username: DEMO_TARGET_USERNAME,
            fullName: '모의 분석용 공개 계정',
            bio: '산책과 사진을 기록하는 데모 프로필입니다.',
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

function demoTrack(
    progressBp: number,
    start: number,
    end: number,
    runningCode: string,
    pendingCode: string,
    completedCode: string,
) {
    const projected = track(progressBp, start, end, runningCode);
    return {
        ...projected,
        stageCode: projected.state === 'completed'
            ? completedCode
            : projected.state === 'pending' ? pendingCode : runningCode,
    };
}

/** Canonical synthetic progression; the sequence mirrors the production V2 DAG. */
export const DEMO_PROGRESS_STAGE_SCHEDULE = [
    ['TARGET_PROFILE_READY', 0],
    ['RELATIONSHIPS_COLLECTING', 750],
    ['TARGET_INTERACTIONS_COLLECTING', 1500],
    ['PUBLIC_PROFILES_COLLECTING', 2250],
    ['PROFILE_SCREENING', 3000],
    ['PRIVATE_NAMES_SCREENING', 3750],
    ['EVIDENCE_JOINING', 4500],
    ['CANDIDATES_RANKING', 5250],
    ['SHORTLIST_INTERACTIONS_COLLECTING', 6000],
    ['PARTNER_CONTEXT_CHECKING', 6750],
    ['FINAL_SCORE_CALCULATING', 7500],
    ['HIGH_RISK_NARRATIVES_WRITING', 8250],
    ['RESULT_FINALIZING', 9000],
    ['ANALYSIS_COMPLETED', 10000],
] as const;

export function projectDemoProgress(input: {
    requestId: string;
    startedAt: Date;
    durationSeconds: number;
    now: Date;
    afterSequence?: number;
    eventLimit?: number;
}): { snapshot: ProgressSnapshotV1; events: ProgressEventV1[] } {
    const elapsed = Math.max(0, input.now.getTime() - input.startedAt.getTime());
    const progressBp = Math.min(10_000, Math.floor(elapsed / (input.durationSeconds * 1_000) * 10_000));
    const completed = progressBp === 10_000;
    const activeStageCode = [...DEMO_PROGRESS_STAGE_SCHEDULE].reverse()
        .find(([, threshold]) => progressBp >= threshold)![0];
    const tracks = {
        relationshipAi: demoTrack(progressBp, 0, 5_250, activeStageCode, 'RELATIONSHIP_AI_QUEUED', 'RELATIONSHIP_AI_COMPLETE'),
        interactions: demoTrack(progressBp, 1_500, 7_500, activeStageCode, 'INTERACTIONS_QUEUED', 'INTERACTIONS_COMPLETE'),
        finalization: demoTrack(progressBp, 7_500, 10_000, activeStageCode, 'FINALIZATION_QUEUED', 'FINALIZATION_COMPLETE'),
    };
    if (completed) {
        tracks.relationshipAi = demoTrack(10_000, 0, 5_250, activeStageCode, 'RELATIONSHIP_AI_QUEUED', 'RELATIONSHIP_AI_COMPLETE');
        tracks.interactions = demoTrack(10_000, 1_500, 7_500, activeStageCode, 'INTERACTIONS_QUEUED', 'INTERACTIONS_COMPLETE');
        tracks.finalization = demoTrack(10_000, 7_500, 10_000, activeStageCode, 'FINALIZATION_QUEUED', 'FINALIZATION_COMPLETE');
    }
    const allEvents: ProgressEventV1[] = DEMO_PROGRESS_STAGE_SCHEDULE.filter((entry) => progressBp >= entry[1]).map(([copyCode, threshold], index) => ({
        schemaVersion: 1, requestId: input.requestId, seq: index + 1, revision: index + 1,
        occurredAt: new Date(input.startedAt.getTime() + input.durationSeconds * 1_000 * threshold / 10_000).toISOString(), state: 'confirmed',
        eventCode: copyCode === 'ANALYSIS_COMPLETED' ? 'ANALYSIS_COMPLETED' : index === 0 ? 'TARGET_PROFILE_READY' : index === 4 ? 'PROFILE_SCREENED' : 'RELATIONSHIP_PROGRESS',
        copyCode, aggregateCount: null,
    }));
    const afterSequence = Math.max(0, input.afterSequence ?? 0);
    const eventLimit = Math.max(1, input.eventLimit ?? 100);
    const events = allEvents.filter(event => event.seq > afterSequence).slice(0, eventLimit);
    return {
        snapshot: {
            schemaVersion: 1, requestId: input.requestId, revision: allEvents.length,
            status: completed ? 'completed' : 'processing', progressBp, backgroundProcessing: !completed,
            tracks, activeProfile: completed ? null : { maskedUsername: 'profile.***', imageUrl: avatar(0) },
            etaRange: completed ? null : { lowSeconds: Math.ceil((10_000 - progressBp) / 10_000 * input.durationSeconds), highSeconds: Math.ceil((10_000 - progressBp) / 10_000 * input.durationSeconds) },
            lastEventSeq: allEvents.length,
        },
        events,
    };
}
