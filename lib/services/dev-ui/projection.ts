import 'server-only';

import {
    analysisResultPageV1Schema, preflightStatusV1Schema, progressReadV1Schema,
    type AnalysisResultPageV1, type FemaleResultRowV1, type PrivateResultRowV1, type ProgressReadV1,
} from '@/lib/contracts/analysis-v2';
import { assessRelationshipCoverage } from '@/lib/domain/analysis/plan-catalog';
import { demoResultPageFromFixture, projectDemoProgress, type DemoFixture } from '@/lib/services/demo-analysis/demo-analysis';
import {
    DEV_UI_RELATIONSHIP_COUNTS, DevUiStoreError,
    type DevUiOrder, type DevUiOrderRow, type DevUiPreflight, type DevUiPreflightRow, type DevUiRun, type DevUiRunRow,
} from './contracts';

const targetImage = '/demo-avatars/synthetic-blurred-avatar-1-v1.png';
const failureRatio = 0.75;

function coverage(declared: number, collected: number) {
    const assessment = assessRelationshipCoverage(declared, collected);
    return { declared, collected, coverageRatio: assessment.coverageRatio, meetsCoverageGate: assessment.meetsCoverageGate, exactCountMatch: assessment.exactCountMatch };
}

function publicAccount(index: number): FemaleResultRowV1 {
    const high = index === 0;
    const caution = index > 0 && index < 3;
    return {
        instagramId: `dev_person_${String(index + 1).padStart(3, '0')}`,
        fullName: `테스트 인물 ${index + 1}`,
        profileImage: `/demo-avatars/synthetic-blurred-avatar-${index % 4 + 1}-v1.png`,
        bio: '화면 검증을 위한 합성 프로필입니다.',
        displayScore: high ? 8.5 : caution ? 5.5 : 3.2,
        riskBand: high ? 'high_risk' : caution ? 'caution' : 'normal',
        featuredRank: index < 3 ? index + 1 : null,
        recentMutualRank: index < 10 ? index + 1 : null,
        analysisDepth: high ? 'narrative' : 'features',
        oneLineOverview: high ? '합성된 공개 단서에서 친밀한 흐름이 비교적 눈에 띕니다.' : '합성된 공개 단서의 연결을 화면에서 확인할 수 있습니다.',
        highRiskNarrative: high ? [
            '비슷한 공개 표현이 함께 나타나 친밀한 흐름으로 분류됩니다.',
            '좋아요와 댓글은 합성된 수집 범위에서 구성한 신호이며 화면 흐름을 확인하는 데 사용됩니다.',
        ] : null,
    };
}

/** Fresh code-generated fixture; never reads published demo rows or source profiles. */
export function createDevUiFixture(run: DevUiRun): DemoFixture {
    const empty = run.fixtureScenario === 'empty';
    const partial = run.fixtureScenario === 'partial';
    const publicAccounts = Array.from({ length: empty ? 0 : partial ? 12 : 60 }, (_, index) => publicAccount(index));
    const privateAccounts: PrivateResultRowV1[] = Array.from({ length: empty ? 0 : partial ? 8 : 20 }, (_, index) => ({
        instagramId: `dev_private_${String(index + 1).padStart(3, '0')}`,
        fullName: `테스트 비공개 ${index + 1}`,
        profileImage: `/demo-avatars/synthetic-blurred-avatar-${index % 4 + 1}-v1.png`,
    }));
    const male = empty ? 0 : 4;
    const publicMutuals = publicAccounts.length + male;
    return {
        version: run.fixtureVersion,
        summary: {
            targetInstagramId: run.targetInstagramId, targetFullName: '합성 테스트 프로필', targetProfileImage: targetImage, planId: run.planId,
            followers: coverage(DEV_UI_RELATIONSHIP_COUNTS.followers, partial ? 317 : DEV_UI_RELATIONSHIP_COUNTS.followers),
            following: coverage(DEV_UI_RELATIONSHIP_COUNTS.following, partial ? 297 : DEV_UI_RELATIONSHIP_COUNTS.following),
            detectedMutuals: publicMutuals + privateAccounts.length, publicMutuals, privateMutuals: privateAccounts.length,
            screenedMutuals: publicMutuals, genderStats: { male, female: publicAccounts.length, unknown: 0 },
            notScreenedMutuals: 0, exclusionApplied: false, scorePolicyVersion: 'risk-policy-v2.3',
        },
        publicAccounts, privateAccounts,
    };
}

export function projectDevUiPreflight(row: DevUiPreflightRow, now: Date): DevUiPreflight {
    const status = row.consumed_at ? 'consumed' : Date.parse(row.expires_at) <= now.getTime() ? 'expired' : 'ready';
    const common = { schemaVersion: 1 as const, preflightId: row.id, exclusionDecision: 'skip' as const };
    if (status === 'consumed' && !row.request_id) throw new DevUiStoreError('DEV_UI_INVALID_ROW');
    const snapshot = status === 'expired' ? null : preflightStatusV1Schema.parse(status === 'consumed'
        ? { ...common, status, requestId: row.request_id }
        : {
            ...common, status, expiresAt: row.expires_at,
            target: { username: row.target_instagram_id, fullName: '합성 테스트 프로필', bio: '화면 검증을 위한 합성 프로필입니다.', profileImage: targetImage,
                followersCount: DEV_UI_RELATIONSHIP_COUNTS.followers, followingCount: DEV_UI_RELATIONSHIP_COUNTS.following, isPrivate: false },
            accessMode: 'production', capacityRequiredPlan: 'basic', requiredPlan: 'basic',
            plans: [row.plan_snapshot.basic, row.plan_snapshot.standard, row.plan_snapshot.plus], pricingVersion: row.pricing_version,
        });
    return {
        preflightId: row.id, targetInstagramId: row.target_instagram_id, fixtureVersion: row.fixture_version,
        fixtureScenario: row.fixture_scenario, createdAt: row.created_at, expiresAt: row.expires_at,
        status, runId: row.request_id ?? null, snapshot, simulation: true,
    };
}

export function projectDevUiRun(row: DevUiRunRow): DevUiRun {
    return {
        runId: row.id, orderId: row.order_id, preflightId: row.preflight_id, targetInstagramId: row.target_instagram_id,
        planId: row.plan_id, pricingVersion: row.pricing_version, planSnapshot: row.plan_snapshot,
        fixtureVersion: row.fixture_version, fixtureScenario: row.fixture_scenario, durationSeconds: row.duration_seconds,
        createdAt: row.created_at, startedAt: row.started_at, expiresAt: row.expires_at, simulation: true,
    };
}

export function devUiRunStatus(run: DevUiRun, now: Date): Exclude<DevUiOrder['runStatus'], null> {
    if (Date.parse(run.expiresAt) <= now.getTime()) return 'expired';
    const elapsed = now.getTime() - Date.parse(run.startedAt);
    if (run.fixtureScenario === 'failed' && elapsed >= run.durationSeconds * 1_000 * failureRatio) return 'failed';
    return elapsed >= run.durationSeconds * 1_000 ? 'completed' : 'processing';
}

export function projectDevUiOrder(row: DevUiOrderRow, runRow: DevUiRunRow | null, now: Date): DevUiOrder {
    const run = runRow ? projectDevUiRun(runRow) : null;
    const runStatus = run ? devUiRunStatus(run, now) : null;
    return {
        orderId: row.id, preflightId: row.preflight_id, targetInstagramId: row.target_instagram_id,
        planId: row.plan_id, pricingVersion: row.pricing_version, price: row.plan_snapshot.price,
        fixtureVersion: row.fixture_version, fixtureScenario: row.fixture_scenario,
        status: row.status === 'pending' && Date.parse(row.expires_at) <= now.getTime() ? 'expired' : row.status,
        createdAt: row.created_at, expiresAt: row.expires_at, completedAt: row.completed_at,
        run, runStatus,
        nextUrl: run ? (runStatus === 'completed' ? `/result/${run.runId}` : `/progress/${run.runId}`) : `/dev-ui/checkout/${row.id}`,
        simulation: true,
    };
}

export function projectDevUiProgress(run: DevUiRun, input: { now?: Date; afterSequence?: number; eventLimit?: number } = {}): ProgressReadV1 {
    const now = input.now ?? new Date();
    const status = devUiRunStatus(run, now);
    if (status === 'expired') throw new DevUiStoreError('DEV_UI_RUN_EXPIRED');
    const fixture = createDevUiFixture(run);
    // The shared progress projector expects a profile even for an empty result.
    // This placeholder is synthetic presentation only and is never a result row.
    const progressFixture = fixture.publicAccounts.length ? fixture : { ...fixture, publicAccounts: [publicAccount(0)] };
    const projected = projectDemoProgress({
        requestId: run.runId, fixtureVersion: run.fixtureVersion, startedAt: new Date(run.startedAt), durationSeconds: run.durationSeconds,
        now: status === 'failed' ? new Date(Date.parse(run.startedAt) + run.durationSeconds * 1_000 * failureRatio) : now,
        fixture: progressFixture, eventLimit: 200,
    });
    if (status === 'failed') {
        projected.snapshot.status = 'failed';
        projected.snapshot.backgroundProcessing = false;
        projected.snapshot.activeProfile = null;
        projected.snapshot.etaRange = null;
        projected.snapshot.tracks.finalization = { ...projected.snapshot.tracks.finalization, state: 'failed', stageCode: 'ANALYSIS_FAILED' };
        const sequence = projected.snapshot.lastEventSeq + 1;
        projected.events.push({ schemaVersion: 1, requestId: run.runId, seq: sequence, revision: sequence,
            occurredAt: new Date(Date.parse(run.startedAt) + run.durationSeconds * 1_000 * failureRatio).toISOString(),
            state: 'confirmed', eventCode: 'RELATIONSHIP_PROGRESS', copyCode: 'ANALYSIS_FAILED', aggregateCount: null });
        projected.snapshot.lastEventSeq = sequence;
        projected.snapshot.revision = sequence;
    }
    const after = input.afterSequence ?? 0;
    const limit = input.eventLimit ?? 100;
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new DevUiStoreError('DEV_UI_INVALID_INPUT');
    return progressReadV1Schema.parse({ schemaVersion: 1, snapshot: projected.snapshot, events: projected.events.filter(event => event.seq > after).slice(0, limit) });
}

export function projectDevUiResult(run: DevUiRun, input: {
    now?: Date; femaleCursor: string | null; privateCursor: string | null; pageSize: number;
}): AnalysisResultPageV1 {
    const status = devUiRunStatus(run, input.now ?? new Date());
    if (status === 'expired') throw new DevUiStoreError('DEV_UI_RUN_EXPIRED');
    if (status === 'failed') throw new DevUiStoreError('DEV_UI_RUN_FAILED');
    if (status !== 'completed') throw new DevUiStoreError('DEV_UI_RESULT_NOT_READY');
    return analysisResultPageV1Schema.parse(demoResultPageFromFixture(createDevUiFixture(run), { ...input, requestId: run.runId }));
}
