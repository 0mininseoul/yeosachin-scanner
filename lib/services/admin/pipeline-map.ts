import 'server-only';
import {
    ANALYSIS_PLAN_CATALOG,
} from '@/lib/domain/analysis/plan-catalog';
import {
    FEATURED_RISK_LIMITS,
    PRE_SCORE_MAX,
    RAW_SCORE_MAX,
    RISK_COMPONENT_WEIGHTS,
    RISK_DISPLAY_THRESHOLDS,
    RISK_POLICY_VERSION,
    STRONG_PARTNER_PUBLIC_SCORE_CAP,
    VERIFICATION_SHORTLIST_LIMIT,
    WEAK_PARTNER_RAW_ADJUSTMENT,
} from '@/lib/domain/analysis/risk-policy';
import {
    ANALYSIS_V2_FEATURED_HIGH_RISK_LIMIT,
    ANALYSIS_V2_PRIVATE_NAME_BATCH_LIMIT,
    ANALYSIS_V2_PROFILE_BATCH_LIMIT,
    ANALYSIS_V2_TARGET_INTERACTOR_LIMIT,
} from '@/lib/services/analysis/v2-dag-planner';
import {
    ANALYSIS_V2_FINALIZER_MAX_ATTEMPTS,
    ANALYSIS_V2_JOB_MAX_ATTEMPTS,
    type AnalysisV2StageId,
} from '@/lib/services/analysis/v2-worker';
import { RESULT_IMAGE_RETENTION_MS } from '@/lib/services/media/result-image-capture';

/**
 * Operator-console map of the analysis pipeline, from the target-account input
 * to the published result.
 *
 * Keep this in sync with the pipeline (AGENTS.md "분석 파이프라인 맵"):
 * - Worker stages are keyed by `AnalysisV2StageId`, so adding, renaming or
 *   removing a DAG stage fails the typecheck until this map is updated.
 * - Numbers come from the code's own constants, so policy changes show up here
 *   without edits; prose that describes behaviour still needs a manual check.
 * - `tests/operations/pipeline-map.test.ts` checks that every code path exists
 *   and that the graph stays connected.
 */

export type PipelineNodeKind = 'infra' | 'collect' | 'ai' | 'join';
export type PipelineBandId = 'before_payment' | 'payment' | 'worker' | 'result';
export type PipelineEdgeRoute = 'auto' | 'elbow-h' | 'elbow-v' | 'bus';

export type PipelineNumber = Readonly<{ label: string; value: string }>;

export type PipelineNode = Readonly<{
    id: string;
    band: PipelineBandId;
    col: number;
    row: number;
    kind: PipelineNodeKind;
    title: string;
    subtitle: string;
    workerStage: AnalysisV2StageId | null;
    /** Runs once per batch (drawn as a stack). */
    batched: boolean;
    /** Turned on or off by configuration (drawn dashed). */
    optional: boolean;
    does: readonly string[];
    services: string;
    numbers: readonly PipelineNumber[];
    failure: string;
    code: readonly string[];
}>;

export type PipelineEdge = Readonly<{
    from: string;
    to: string;
    route: PipelineEdgeRoute;
    dashed: boolean;
    label: string;
}>;

export type PipelineBand = Readonly<{ id: PipelineBandId; title: string; rows: number }>;
export type PipelineNote = Readonly<{ band: PipelineBandId; col: number; row: number; text: string }>;

export type PipelineMap = Readonly<{
    riskPolicyVersion: string;
    workerStageCount: number;
    deployedCommit: string | null;
    bands: readonly PipelineBand[];
    nodes: readonly PipelineNode[];
    edges: readonly PipelineEdge[];
    notes: readonly PipelineNote[];
}>;

type NodeSpec = Omit<PipelineNode, 'id' | 'band' | 'workerStage' | 'batched' | 'optional'>
    & Partial<Pick<PipelineNode, 'batched' | 'optional'>>;

const n = (value: number) => value.toLocaleString('ko-KR');
const points = (value: number) => `${n(value)}점`;
const people = (value: number) => `${n(value)}명`;
const W = RISK_COMPONENT_WEIGHTS;
const PLANS = ANALYSIS_PLAN_CATALOG;

const BEFORE_PAYMENT: Record<string, NodeSpec> = {
    input: {
        col: 0, row: 0, kind: 'infra', title: '대상 계정 입력', subtitle: '/analyze · 리드 기록',
        does: [
            '분석할 인스타그램 아이디를 받습니다. 로그인 없이도 입력할 수 있습니다.',
            '입력 1회를 리드 1행으로 남기고 유입 경로를 함께 기록합니다.',
        ],
        services: '없음 (Vercel)',
        numbers: [{ label: '기록 테이블', value: 'landing_leads' }],
        failure: '형식이 틀리면 화면에서 바로 막습니다.',
        code: ['app/analyze/page.tsx', 'lib/services/landing/landing-lead-journey.ts'],
    },
    preflight: {
        col: 1, row: 0, kind: 'collect', title: 'Preflight 사전 점검', subtitle: '대상 프로필 · 필요 플랜',
        does: [
            '대상 프로필을 수집합니다. 자체 크롤러가 먼저, 실패하면 Apify로 넘깁니다.',
            '비공개·없는 계정·형식 오류를 판정하고 팔로워·팔로잉 수로 필요한 플랜을 계산합니다.',
        ],
        services: '자체 크롤러 → Apify (대체)',
        numbers: [{ label: 'API', value: 'POST /api/analysis/preflight' }],
        failure: '실패 사유를 preflight 실패 원장에 남기고, 콘솔 Preflight 메뉴에 실패로 표시합니다.',
        code: ['app/api/analysis/preflight/route.ts', 'lib/services/analysis/preflight.ts', 'lib/services/analysis/preflight-failure-ledger.ts'],
    },
    plan: {
        col: 2, row: 0, kind: 'infra', title: '제외 계정 · 플랜', subtitle: '여자친구 제외 · 플랜 카드',
        does: [
            '여자친구 계정을 입력하거나 건너뜁니다. 이 계정은 이후 모든 단계에서 빠집니다.',
            '플랜 카드를 보여주고, 수용 상한을 넘는 플랜은 선택할 수 없게 막습니다.',
        ],
        services: '없음',
        numbers: (['basic', 'standard', 'plus'] as const).map(id => ({
            label: `${id} 수용 상한 · 상세 분석`,
            value: `각 ${n(PLANS[id].relationshipCapacity.followers)} · ${people(PLANS[id].detailedMutualLimit)}`,
        })),
        failure: '상한을 넘는 계정은 결제 전에 막습니다.',
        code: ['lib/domain/analysis/plan-catalog.ts', 'components/analysis-preflight-presentation.tsx'],
    },
    blite: {
        col: 3, row: 0, kind: 'ai', title: 'B-lite 티저', subtitle: '결제 전 미리보기 · 설정', optional: true,
        does: [
            '결제 전에 대상 계정의 성향을 짧게 미리 보여줍니다.',
            '실제 분석은 하지 않고, 후보 수는 팔로워·팔로잉 수로 계산한 범위로만 보여줍니다.',
        ],
        services: 'Gemini',
        numbers: [{ label: '켜는 설정', value: 'PRECHECKOUT_BLITE_ENABLED' }],
        failure: '실패하면 티저 없이 결제 화면으로 넘어갑니다.',
        code: ['app/api/analysis/precheckout-blite/route.ts', 'lib/services/precheckout/blite-runner.ts'],
    },
};

const PAYMENT: Record<string, NodeSpec> = {
    checkout: {
        col: 2, row: 0, kind: 'infra', title: '결제 (Groble)', subtitle: '주문 생성 · 결제창',
        does: [
            '주문을 결제 대기로 만들고 Groble 결제창으로 보냅니다.',
            '결제 기기 정보를 주문에 남깁니다.',
        ],
        services: 'Groble',
        numbers: [{ label: 'API', value: 'POST /api/earlybird/checkout' }],
        failure: '결제창에서 이탈하면 주문은 결제 대기로 남습니다.',
        code: ['app/api/earlybird/checkout/route.ts', 'lib/services/earlybird/checkout.ts'],
    },
    webhook: {
        col: 1, row: 0, kind: 'infra', title: '결제 웹훅 확정', subtitle: 'paid · 결제 증거',
        does: [
            'Groble 웹훅으로 결제를 확정하고 결제 증거를 기록합니다.',
            '취소·환불 이벤트도 여기서 처리하고 Discord로 알립니다.',
        ],
        services: 'Groble · Discord',
        numbers: [{ label: 'API', value: 'POST /api/webhooks/groble' }],
        failure: '같은 이벤트가 다시 와도 한 번만 반영합니다.',
        code: ['app/api/webhooks/groble/route.ts'],
    },
    admission: {
        col: 0, row: 0, kind: 'infra', title: '실행 승인', subtitle: '크레딧 예약 · Cloud Tasks',
        does: [
            '결제된 주문에 Apify 슬롯을 묶고 플랜 크레딧을 예약합니다.',
            '분석 요청을 만들고 첫 작업을 Cloud Tasks에 등록합니다.',
        ],
        services: 'Cloud Tasks · Apify 크레딧 풀',
        numbers: [{ label: '작업 최대 시도', value: `${n(ANALYSIS_V2_JOB_MAX_ATTEMPTS)}회` }],
        failure: 'preflight가 만료됐으면 다시 묶고, 안 되면 운영자 확인으로 넘깁니다.',
        code: ['lib/services/earlybird/fulfillment-store.ts', 'lib/services/analysis/fresh-plan-admission.ts', 'lib/services/analysis/v2-tasks.ts'],
    },
};

/** One entry per DAG stage: a new `AnalysisV2StageId` fails the typecheck here. */
const WORKER_STAGES: Record<AnalysisV2StageId, NodeSpec> = {
    relationships: {
        col: 0, row: 0, kind: 'collect', title: '관계 수집', subtitle: 'relationships',
        does: [
            '팔로워·팔로잉을 수집해 맞팔을 뽑고 제외 계정을 뺍니다.',
            '공개·비공개로 나누고 프로필 배치와 비공개 이름 배치를 계획합니다.',
        ],
        services: 'Apify (관계 actor)',
        numbers: [
            { label: '프로필 배치', value: people(ANALYSIS_V2_PROFILE_BATCH_LIMIT) },
            { label: '비공개 이름 배치', value: people(ANALYSIS_V2_PRIVATE_NAME_BATCH_LIMIT) },
        ],
        failure: '작업 단위로 재시도합니다.',
        code: ['lib/services/analysis/v2-collection-executors.ts', 'lib/services/analysis/v2-dag-planner.ts'],
    },
    target_evidence: {
        col: 2, row: 0, kind: 'collect', title: '대상 상호작용 수집', subtitle: 'target_evidence',
        does: [
            '대상의 최근 게시물에 좋아요·댓글을 남긴 계정을 수집합니다.',
            '관계 수집과 동시에 진행됩니다.',
        ],
        services: 'Apify (상호작용 actor)',
        numbers: [{ label: '상호작용 계정 상한', value: people(ANALYSIS_V2_TARGET_INTERACTOR_LIMIT) }],
        failure: '작업 단위로 재시도합니다.',
        code: ['lib/services/analysis/v2-collection-executors.ts'],
    },
    profile_fetch: {
        col: 0, row: 1, kind: 'collect', title: '공개 프로필 수집', subtitle: 'profile_fetch', batched: true,
        does: [
            `공개 맞팔의 프로필과 게시물을 ${people(ANALYSIS_V2_PROFILE_BATCH_LIMIT)}씩 수집합니다.`,
            '캐시 → 자체 크롤러 → 남은 계정만 Apify 순서로 찾습니다.',
        ],
        services: '자체 크롤러 · Apify',
        numbers: [{ label: '배치 크기', value: people(ANALYSIS_V2_PROFILE_BATCH_LIMIT) }],
        failure: '배치 단위로 재시도합니다.',
        code: ['lib/services/analysis/v2-collection-executors.ts', 'lib/services/analysis/profile-cache.ts'],
    },
    profile_ai: {
        col: 0, row: 2, kind: 'ai', title: '프로필 AI', subtitle: 'profile_ai', batched: true,
        does: [
            '맞팔 계정의 성별을 판정합니다 (1차 → 트리아지 → 해결).',
            'Standard 1차 판독은 호출 전에 후보 묶음을 저장합니다. 작업이 재전달되면 같은 묶음의 호출 기록을 확인합니다.',
            '여성 후보는 외모·노출·계정 성격·파트너 근거를 분석합니다.',
        ],
        services: 'Gemini',
        numbers: [{ label: '외모·노출 배점', value: points(W.appearanceExposure) }],
        failure: '일시적인 DB 저장 오류는 재시도합니다. 이전 묶음의 호출 기록과 입력을 일치시킬 수 없으면 새 호출 전에 중단합니다.',
        code: ['lib/services/ai/v2-staged-analysis.ts', 'lib/services/analysis/v2-ai-scoring-executors.ts', 'lib/services/analysis/v2-ai-result-store.ts'],
    },
    private_names: {
        col: 1, row: 1, kind: 'ai', title: '비공개 이름 성별', subtitle: 'private_names', batched: true,
        does: [
            '비공개 맞팔은 이름만으로 성별을 추정합니다.',
            '결과는 결과 화면의 비공개 계정 목록에 쓰입니다.',
        ],
        services: 'Gemini',
        numbers: [{ label: '배치 크기', value: people(ANALYSIS_V2_PRIVATE_NAME_BATCH_LIMIT) }],
        failure: '배치 단위로 재시도합니다.',
        code: ['lib/services/ai/v2-staged-analysis.ts'],
    },
    primary_join: {
        col: 2, row: 3, kind: 'join', title: '예비 점수 조인', subtitle: 'primary_join',
        does: [
            '관계·대상 상호작용·프로필 AI 결과를 합칩니다.',
            '품질 검사가 적용된 요청에서 미확정 비율이 기준을 넘으면 저장된 AI 정책에 따라 성별을 재판독합니다.',
            '검증된 여성 후보마다 예비 점수를 계산합니다 (대상→후보 좋아요 제외).',
        ],
        services: 'Gemini (재판독 시)',
        numbers: [
            { label: '예비 점수 상한', value: points(PRE_SCORE_MAX) },
            { label: '후보→대상 좋아요', value: points(W.candidateToTargetLikes) },
            { label: '후보→대상 댓글', value: points(W.candidateToTargetComments) },
            { label: '후보→대상 태그·언급', value: points(W.candidateToTargetTagOrCaptionMention) },
            { label: '대상→후보 태그·언급', value: points(W.targetToCandidateTagOrCaptionMention) },
            { label: '최근 맞팔', value: points(W.recentMutual) },
            { label: '외모·노출', value: points(W.appearanceExposure) },
        ],
        failure: '모든 배치가 완료돼야 시작하며 재판독 후에도 품질 기준을 충족하지 못하면 수동 검토로 보냅니다.',
        code: ['lib/domain/analysis/risk-policy.ts', 'lib/services/analysis/v2-ai-scoring-executors.ts', 'lib/services/analysis/v2-dag-planner.ts'],
    },
    screening: {
        col: 2, row: 4, kind: 'join', title: '검증 후보 선별', subtitle: 'screening',
        does: ['예비 점수 상위 후보를 검증 대상으로 고정합니다. 고정된 목록은 다시 바뀌지 않습니다.'],
        services: '없음',
        numbers: [{ label: '검증 대상', value: `상위 ${people(VERIFICATION_SHORTLIST_LIMIT)}` }],
        failure: '예비 점수가 모두 저장된 뒤에만 시작합니다.',
        code: ['lib/domain/analysis/risk-policy.ts'],
    },
    reverse_likes: {
        col: 2, row: 5, kind: 'collect', title: '역방향 좋아요 확인', subtitle: 'reverse_likes',
        does: [
            '검증 대상의 최신 게시물 좋아요 목록에서 대상 계정을 찾습니다.',
            '수집하지 못한 경우는 0점이 아니라 미수집으로 남깁니다.',
        ],
        services: 'Apify (상호작용 actor)',
        numbers: [{ label: '대상→후보 좋아요', value: points(W.targetToCandidateLike) }],
        failure: '작업 단위로 재시도합니다.',
        code: ['lib/services/analysis/v2-ai-scoring-executors.ts'],
    },
    partner_safety: {
        col: 3, row: 5, kind: 'ai', title: '파트너 근거 확인', subtitle: 'partner_safety',
        does: ['검증 대상의 게시물에서 연인으로 보이는 근거를 확인합니다.'],
        services: 'Gemini',
        numbers: [
            { label: '약한 근거', value: `원점수 ${WEAK_PARTNER_RAW_ADJUSTMENT}` },
            { label: '강한 근거', value: `공개 점수 ${STRONG_PARTNER_PUBLIC_SCORE_CAP} 상한` },
        ],
        failure: 'AI 실패 시 재시도합니다.',
        code: ['lib/services/ai/v2-staged-analysis.ts'],
    },
    final_score: {
        col: 2, row: 6, kind: 'join', title: '최종 점수', subtitle: 'final_score',
        does: [
            `${points(RAW_SCORE_MAX)} 만점 점수를 1.0~10.0으로 바꾸고 위험 구간을 나눕니다.`,
            '대표 후보를 고릅니다.',
        ],
        services: '없음',
        numbers: [
            { label: '주의', value: `${RISK_DISPLAY_THRESHOLDS.caution} 이상` },
            { label: '고위험', value: `${RISK_DISPLAY_THRESHOLDS.high} 이상` },
            { label: '대표 고위험 / 주의', value: `${people(FEATURED_RISK_LIMITS.high_risk)} / ${people(FEATURED_RISK_LIMITS.caution)}` },
        ],
        failure: '역방향 좋아요와 파트너 근거가 모두 와야 시작합니다.',
        code: ['lib/domain/analysis/risk-policy.ts'],
    },
    narrative: {
        col: 2, row: 7, kind: 'ai', title: '고위험 총평', subtitle: 'narrative',
        does: ['대표 고위험 후보의 총평을 씁니다.', '개인정보가 드러나는 문장은 걸러냅니다.'],
        services: 'Gemini',
        numbers: [{ label: '총평 대상', value: `최대 ${people(ANALYSIS_V2_FEATURED_HIGH_RISK_LIMIT)}` }],
        failure: '형식이 틀리면 고쳐 쓰기를 시도합니다.',
        code: ['lib/services/ai/v2-staged-analysis.ts'],
    },
    finalize: {
        col: 2, row: 8, kind: 'infra', title: '결과 확정', subtitle: 'finalize',
        does: [
            '총평과 비공개 이름 결과가 모두 모이면 결과를 저장합니다.',
            '결과 화면용 이미지를 R2에 보관하고 주문 감사 번들을 대기열에 넣습니다.',
        ],
        services: 'Cloudflare R2',
        numbers: [{ label: '최대 시도', value: `${n(ANALYSIS_V2_FINALIZER_MAX_ATTEMPTS)}회` }],
        failure: '일시적인 이미지 저장 오류는 기존 저장 내역부터 확인해 재시도합니다. 필수 이미지가 준비돼야 결과를 발행합니다.',
        code: ['lib/services/analysis/v2-worker.ts', 'lib/services/analysis/v2-ai-scoring-executors.ts', 'lib/services/media/result-image-capture.ts'],
    },
};

const RESULT: Record<string, NodeSpec> = {
    publish: {
        col: 2, row: 0, kind: 'infra', title: '결과 공개', subtitle: '발행 확인 · 주문 완료',
        does: [
            'DB가 주문·이행의 발행 조건을 확인한 뒤에만 유료 결과를 읽을 수 있게 합니다.',
            '주문을 완료로 바꿉니다.',
        ],
        services: '없음',
        numbers: [{ label: '발행 확인', value: 'isAnalysisResultAuthoritativelyPublished' }],
        failure: '발행 전에는 결과 화면이 대기 상태로 보입니다.',
        code: ['lib/services/analysis/result-publication-authority.ts'],
    },
    result: {
        col: 1, row: 0, kind: 'infra', title: '결과 화면', subtitle: '/result · 이미지 보관',
        does: ['진행 화면이 끝나면 결과 화면으로 넘어갑니다.', '후보는 페이지 단위로 불러옵니다.'],
        services: 'Cloudflare R2 (이미지)',
        numbers: [{ label: '결과 이미지 보관', value: `${n(RESULT_IMAGE_RETENTION_MS / 86_400_000)}일` }],
        failure: '이미지가 만료되면 기본 아바타로 보입니다.',
        code: ['app/result/[requestId]/page.tsx', 'app/api/analysis/v2/result/[requestId]/route.ts'],
    },
    audit: {
        col: 3, row: 0, kind: 'infra', title: '감사 · 원가 기록', subtitle: '주문 감사 메뉴 근거',
        does: ['주문별 감사 번들과 원가 스냅샷을 남깁니다.', '운영 콘솔 주문 감사 메뉴가 이 기록을 읽습니다.'],
        services: '없음',
        numbers: [{ label: '콘솔 메뉴', value: '주문 감사' }],
        failure: '기록이 없으면 주문 감사에 번들 없음으로 표시합니다.',
        code: ['lib/services/analysis/order-audit-bundle.ts'],
    },
};

const BANDS: readonly PipelineBand[] = [
    { id: 'before_payment', title: '① 결제 전 · Vercel API', rows: 1 },
    { id: 'payment', title: '② 결제 · 실행 승인 (오른쪽에서 왼쪽으로)', rows: 1 },
    { id: 'worker', title: '③ 분석 워커 · Cloud Tasks → Cloud Run DAG', rows: 9 },
    { id: 'result', title: '④ 결과', rows: 1 },
];

function edge(from: string, to: string, options: Partial<Omit<PipelineEdge, 'from' | 'to'>> = {}): PipelineEdge {
    return { from, to, route: options.route ?? 'auto', dashed: options.dashed ?? false, label: options.label ?? '' };
}

const EDGES: readonly PipelineEdge[] = [
    edge('input', 'preflight'),
    edge('preflight', 'plan'),
    edge('plan', 'blite', { dashed: true, label: '설정이 켜져 있을 때' }),
    edge('plan', 'checkout'),
    edge('checkout', 'webhook'),
    edge('webhook', 'admission'),
    edge('admission', 'relationships'),
    edge('admission', 'target_evidence', { route: 'bus' }),
    edge('relationships', 'profile_fetch'),
    edge('relationships', 'private_names', { route: 'elbow-h' }),
    edge('profile_fetch', 'profile_ai'),
    edge('profile_ai', 'primary_join', { route: 'elbow-v', label: '모든 배치가 끝난 뒤' }),
    edge('target_evidence', 'primary_join'),
    edge('primary_join', 'screening'),
    edge('screening', 'reverse_likes'),
    edge('screening', 'partner_safety', { route: 'elbow-h' }),
    edge('reverse_likes', 'final_score'),
    edge('partner_safety', 'final_score', { route: 'elbow-v' }),
    edge('final_score', 'narrative'),
    edge('narrative', 'finalize'),
    edge('private_names', 'finalize', { route: 'elbow-v', dashed: true }),
    edge('finalize', 'publish'),
    edge('publish', 'result'),
    edge('publish', 'audit'),
];

const NOTES: readonly PipelineNote[] = [
    { band: 'worker', col: 3, row: 0, text: '트랙 B · 트랙 A(관계·프로필)와 동시에 진행' },
    { band: 'worker', col: 3, row: 3, text: `다음 단계(검증 후보 선별)에서 상위 ${people(VERIFICATION_SHORTLIST_LIMIT)}만 남깁니다` },
];

function nodesOf(band: PipelineBandId, specs: Record<string, NodeSpec>, worker: boolean): PipelineNode[] {
    return Object.entries(specs).map(([id, spec]) => ({
        ...spec,
        id,
        band,
        workerStage: worker ? id as AnalysisV2StageId : null,
        batched: spec.batched ?? false,
        optional: spec.optional ?? false,
    }));
}

export function buildPipelineMap(env: Readonly<Record<string, string | undefined>> = process.env): PipelineMap {
    const sha = env.VERCEL_GIT_COMMIT_SHA?.trim();
    return {
        riskPolicyVersion: RISK_POLICY_VERSION,
        workerStageCount: Object.keys(WORKER_STAGES).length,
        deployedCommit: sha ? sha.slice(0, 7) : null,
        bands: BANDS,
        nodes: [
            ...nodesOf('before_payment', BEFORE_PAYMENT, false),
            ...nodesOf('payment', PAYMENT, false),
            ...nodesOf('worker', WORKER_STAGES, true),
            ...nodesOf('result', RESULT, false),
        ],
        edges: EDGES,
        notes: NOTES,
    };
}
