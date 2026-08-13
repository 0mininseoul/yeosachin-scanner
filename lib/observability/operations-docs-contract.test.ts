import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ANALYSIS_PLAN_CATALOG } from '@/lib/domain/analysis/plan-catalog';
import {
    CANDIDATE_INTERACTION_POST_LIMIT,
    CANDIDATE_LIKER_LIMIT_PER_POST,
    MAX_INTERACTION_CANDIDATES,
    TARGET_COMMENT_LIMIT_PER_POST,
    TARGET_COMMENT_POST_LIMIT,
    TARGET_LIKER_LIMIT_PER_POST,
    TARGET_LIKER_POST_LIMIT,
} from '@/lib/services/analysis/interaction-stage';
import { REPLACEMENT_PROFILE_ACTOR } from '@/lib/services/instagram/providers/apify-profile-details';
import { APIFY_PROFILE_SUMMARY_MAX_CHARGE_USD } from '@/lib/services/instagram/providers/apify';

const root = new URL('../../', import.meta.url);

function source(relativePath: string): string {
    const url = new URL(relativePath, root);
    return existsSync(url) ? readFileSync(url, 'utf8') : '';
}

function dotenvNumber(document: string, key: string): number {
    const value = document.match(new RegExp(`^${key}=([0-9.]+)$`, 'm'))?.[1];
    return value === undefined ? Number.NaN : Number(value);
}

describe('analytics and observability disclosure contract', () => {
    it('documents bounded betatest Apify pool telemetry, recovery, grants, and rollout', () => {
        const runbook = source('docs/betatest-apify-credit-pool-runbook.md');
        const operations = source('docs/analysis-v2-production-operations.md');
        const normalizedRunbook = runbook.replace(/\s+/g, ' ');

        for (const term of [
            'refresh success/failure/latency',
            'total effective headroom',
            'reservation/actual/released USD',
            'stale snapshot',
            'settlement lag',
            'active allocations',
            'repeated refresh failure',
            'negative/overcommitted invariant',
            'unexpected beta use while the feature is disabled',
            'frozen maps',
            'idempotent',
            'service-role',
            'migration dry-run',
            'numeric version',
            'synthetic',
            'live canary',
            'no per-analysis deployment',
            'runtime reservation',
        ]) expect(normalizedRunbook).toContain(term);

        expect(runbook).toContain('<USER_UUID_FROM_APPROVED_OUT_OF_BAND_SOURCE>');
        expect(runbook).toContain('<AUDIT_REFERENCE_SHA256_64_LOWERCASE_HEX>');
        expect(runbook).toContain('upsert_analysis_beta_access_grant');
        expect(runbook).toContain('audit_reference_hash');
        expect(runbook).not.toContain('insert into public.analysis_beta_access_grants');
        expect(runbook).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
        expect(runbook).toMatch(/secondary[^\n]*(exclude|excluded|invalid)/i);
        expect(operations).toContain('betatest-apify-credit-pool-runbook.md');
        for (const migration of [
            '20260802010000', '20260802010100', '20260802020000',
            '20260802030000', '20260802030100', '20260802040000',
            '20260802050000', '20260802060000', '20260802070000',
            '20260802080000', '20260802090000', '20260802100000',
            '20260802100100', '20260802100200', '20260802100300',
            '20260802100400', '20260802100500', '20260802100600',
        ]) expect(runbook).toContain(migration);
    });
    it('discloses transient Groble matching and bounded analytics processing actually used', () => {
        const privacy = source('app/privacy/page.tsx');
        const disclosure = privacy.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

        expect(disclosure).toMatch(/Axiom[^<]*?운영 로그|운영 로그[^<]*?Axiom/);
        expect(disclosure).toMatch(
            /인스타그램 계정 아이디[^<]*?장애[^<]*?진단|장애[^<]*?진단[^<]*?인스타그램 계정 아이디/
        );
        expect(disclosure).toMatch(/Axiom[^<]*?(30일|30 일)|30일[^<]*?Axiom/);
        expect(disclosure).toMatch(/그로블 구매자[^<]*?주문자명[^<]*?이메일[^<]*?전화번호[^<]*?일시적/);
        expect(disclosure).toMatch(/결제 매칭[^<]*?(이행|결과 제공)[^<]*?(분쟁|환불)/);
        expect(disclosure).toMatch(/웹훅[^<]*?처리 트랜잭션[^<]*?영속[^<]*?저장하지/);
        expect(disclosure).not.toContain('메모리에서만');
        expect(disclosure).not.toMatch(/구매자[^<]*?(연락처|이메일|전화번호)[^<]*?(증거로 보관|결제 증거)/);
        expect(disclosure).toMatch(
            /주문자명[^<]*?이메일[^<]*?전화번호[^<]*?영속[^<]*?저장하지[^<]*?Amplitude[^<]*?Axiom[^<]*?전송하지/
        );
        expect(disclosure).toMatch(/카드[^<]*?원문 웹훅[^<]*?보관하지/);
        expect(disclosure).toMatch(/Amplitude[^<]*?이용 통계[^<]*?Session Replay[^<]*?활성화된 경우/);
        expect(disclosure).toMatch(/허용된 서비스 화면[^<]*?(일반 UI|화면)/);
        expect(disclosure).toMatch(/입력값[^<]*?식별 정보[^<]*?(마스킹|차단)/);
        expect(disclosure).toMatch(/구매자[^<]*?연락처[^<]*?댓글[^<]*?소개글[^<]*?캡션[^<]*?(이미지|미디어) URL[^<]*?제외/);
        expect(disclosure).toMatch(/리에종\(그로블\)[^<]*?통신판매중개/);
        expect(disclosure).not.toContain('주식회사 리에종');
        expect(disclosure).toMatch(/외부[^<]*?전자지급결제대행\(PG\)/);
        expect(disclosure).toMatch(/(수탁자|위탁사)[^<]*?포함되지 않/);
    });

    it('uses provider-specific transfer fields and the verified runtime regions', () => {
        const disclosure = source('app/privacy/page.tsx')
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ');

        for (const heading of [
            '이전받는 자',
            '국가·리전',
            '이전 항목',
            '일시·방법',
            '목적',
            '보유·이용 기간',
            '거부 방법·영향',
        ]) {
            expect(disclosure).toContain(heading);
        }
        expect(disclosure).toMatch(/Supabase[^<]*?대한민국[^<]*?서울[^<]*?ap-northeast-2/);
        expect(disclosure).toMatch(/Vercel[^<]*?대한민국[^<]*?서울[^<]*?icn1/);
        expect(disclosure).toMatch(/Google[^<]*?global[^<]*?특정[^<]*?위치[^<]*?보장하지/);
        expect(disclosure).toMatch(/Axiom[^<]*?미국[^<]*?30일/);
        expect(disclosure).not.toMatch(/Supabase\(미국\)|Vercel\(미국\)/);
    });

    it('documents an ingest-only Axiom rollout and a privacy audit before production', () => {
        const operations = source('docs/axiom-observability-operations.md');

        expect(operations).toContain('yeosachin-logs');
        expect(operations).toMatch(/Events/);
        expect(operations).toMatch(/30일/);
        expect(operations).toMatch(/실제 조직 ID[^\n]*UI[^\n]*확인/);
        expect(operations).toMatch(/ingest[^\n]*(전용|만)/i);
        expect(operations).toMatch(/PAT[^\n]*(Vercel|런타임)[^\n]*(금지|사용하지|넣지)/i);
        for (const scenario of ['auth', 'preflight', 'fallback', 'V2 worker', 'Gemini', 'Groble']) {
            expect(operations).toContain(scenario);
        }
        expect(operations).toContain('Yeosachin Operational Health');
        expect(operations).toContain('3개 모니터');
        expect(operations).toContain("['fields.environment'] == \"production\"");
        expect(operations).toContain("['fields.event'] in (");
        expect(operations).toContain("['fields.user_id']");
        expect(operations).toContain("['fields.preflight_id']");
        expect(operations).toMatch(/Vercel lifecycle[^\n]*Axiom/);
        expect(operations).toMatch(/Cloud Run preflight worker[^\n]*Axiom transport[^\n]*stdout[^\n]*Cloud Logging/);
        expect(operations).toContain('resource.type="cloud_run_revision"');
        expect(operations).toContain('resource.labels.service_name="analysis-worker"');
        expect(operations).toContain('timestamp');
        expect(operations).toContain('jsonPayload.event=~"^preflight\\.(completed|failed)$"');
        expect(operations).toMatch(/attempt[^\n]*at-least-once/);
        expect(operations).toMatch(/preflight_id[^\n]*event[^\n]*attempt[^\n]*(모두|있을 때)/);
        expect(operations).toContain('preflight_id + event + attempt');
        expect(operations).toMatch(/correlation field[^\n]*제한된 시간 창/);
        expect(operations).toMatch(/영속 exactly-once[^\n]*(보장하지|보장하지 않는다)/);
        expect(operations).not.toMatch(/^\| where (?:fields\.)?environment ==/m);
        expect(operations).not.toMatch(/^\| where (?:fields\.)?event (?:==|in)/m);
        expect(operations).toMatch(/notifier[^\n]*(없|미구성)[^\n]*(비활성|disabled)/i);
        expect(operations).toMatch(/토큰 회전/);
        expect(operations).toMatch(/즉시[^\n]*(ingest|인제스트)[^\n]*(중단|차단)/i);
        expect(operations).toMatch(/Trim[^\n]*(블록|이전|older)[^\n]*(최신|특정)[^\n]*(보장하지|삭제하지 못)/i);
        expect(operations).toMatch(/(데이터셋 재생성|Axiom 지원)[^\n]*(명시적 승인|승인)/);

        const dispositions = [
            'accepted',
            'duplicate_event',
            'duplicate_payment',
            'unmatched',
            'ambiguous_buyer',
            'mismatch',
            'overflow_refund_required',
            'cancel_requested',
            'cancel_duplicate_event',
            'cancel_unmatched',
            'cancel_mismatch',
            'cancel_before_payment',
            'late_cancelled_payment',
        ];
        for (const disposition of dispositions) {
            expect(operations).toContain(`\`${disposition}\``);
        }
        expect(operations).not.toMatch(/`ambiguous`|`cancel`/);
    });

    it('documents bounded B-lite fallback and SLA outcomes without provider-attempt inflation', () => {
        const operations = source('docs/axiom-observability-operations.md');

        for (const event of [
            'precheckout_blite.fallback_latched',
            'precheckout_blite.demo_completed',
            'precheckout_blite.demo_failed',
        ]) expect(operations).toContain(event);
        for (const disposition of [
            'terminal_before_48',
            'unresolved_at_48',
            'demo_error',
        ]) expect(operations).toContain(`\`${disposition}\``);
        expect(operations).toMatch(/T\+48/);
        expect(operations).toMatch(/T\+60/);
        expect(operations).toMatch(/provider attempt|provider outcome/i);
        expect(operations).toMatch(/cache hit|pending lease|access denial/i);
        expect(operations).toMatch(/no provider|provider.*(?:없|not|금지)/i);
    });

    it('keeps browser-only fallback/demo outcomes on Amplitude without a server logging endpoint', () => {
        const operations = source('docs/axiom-observability-operations.md');

        expect(operations).toMatch(/fallback_latched[\s\S]*demo_started[\s\S]*demo_completed[\s\S]*demo_failed/);
        expect(operations).toMatch(/Amplitude/);
        expect(operations).toMatch(/(?:별도|new|new public)[^\n]*(?:endpoint|logging endpoint|로깅 endpoint)[^\n]*(?:추가하지|not|없)/i);
        expect(operations).toMatch(/Vercel\/Axiom[\s\S]*(?:server outcomes|서버 결과|서버 운영)/i);
    });

    it('documents the production B-lite terminal outcome query and fail-open response', () => {
        const operations = source('docs/axiom-observability-operations.md');

        expect(operations).toContain("['fields.environment'] == \"production\"");
        for (const event of [
            'precheckout_blite.completed',
            'precheckout_blite.profile_collection_failed',
            'precheckout_blite.inference_failed',
        ]) {
            expect(operations).toContain(`\"${event}\"`);
        }
        for (const field of [
            'provider',
            'operation',
            'error_code',
            'disposition',
            'duration_ms',
            'preflight_id',
        ]) {
            expect(operations).toContain(`['fields.${field}']`);
        }
        expect(operations).toMatch(/B-lite[^\n]*204[^\n]*(preflight|checkout)/i);
    });

    it('marks the contact-retention design documents as superseded without rewriting history', () => {
        for (const path of [
            'docs/superpowers/specs/2026-07-18-amplitude-axiom-groble-phone-design.md',
            'docs/superpowers/plans/2026-07-18-groble-phone-matching.md',
        ]) {
            const historical = source(path);
            expect(historical).toMatch(/역사적[^\n]*(설계|계획)/);
            expect(historical).toMatch(/20260719131500_stop_persisting_groble_buyer_contacts\.sql/);
            expect(historical).toMatch(/(보관하지 않|보관 금지|폐기)/);
        }
    });

    it('documents the Groble product fence and rolling-deploy drain contract', () => {
        const operations = source('docs/groble-earlybird-operations.md');

        expect(operations).toContain('payment -> product -> user ID 오름차순');
        expect(operations).toContain('product -> user');
        expect(operations).toContain('earlybird:groble:product:<product_id>');
        expect(operations).toMatch(/직접 INSERT[^\n]*trigger[^\n]*product lock/);
        expect(operations).toMatch(/canonical[^\n]*payment -> user/);
        expect(operations).toMatch(/기존 payment ID 주문 owner/);
        expect(operations).toMatch(/NULL[^\n]*event type[^\n]*GROBLE_PAYMENT_EVIDENCE_INVALID/);
        expect(operations).toMatch(/0 active writer/);
        expect(operations).toMatch(/Phase 1[^\n]*relation[^\n]*drain/);
        expect(operations).toMatch(/internal checkout body[^\n]*post-drain/);
    });

    it('documents fail-closed 100% beta Amplitude Session Replay with eight event panels', () => {
        const operations = source('docs/amplitude-analytics-operations.md');
        const env = source('.env.example');
        const dashboardSection = operations.match(/## 4\. 대시보드 생성[\s\S]*?(?=## 5\. Live 검증)/)?.[0] ?? '';

        expect(operations).toContain('NEXT_PUBLIC_AMPLITUDE_API_KEY');
        expect(operations).toContain('Supabase UUID');
        expect(operations).toMatch(
            /NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_ENABLED[^\n]*true/
        );
        expect(operations).toMatch(
            /NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_SAMPLE_RATE[^\n]*1/
        );
        expect(operations).toMatch(
            /DEMO_ANALYSIS_ENABLED[^\n]*(server-only|서버 전용)[^\n]*(데모 자격|demo eligibility)/i
        );
        expect(operations).toMatch(
            /DEMO_ANALYSIS_ENABLED[^\n]*값과 관계없이[^\n]*`\/analyze`[^\n]*`\/progress\/:requestId`[^\n]*`\/result\/:requestId`[^\n]*`\/share\/:token`[^\n]*수집 후보/i
        );
        expect(operations).toMatch(/현재 승인된[^\n]*NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_SAMPLE_RATE=1[^\n]*(100%|100 %)/);
        expect(operations).toMatch(/0\.01[^\n]*0\.10[^\n]*1/);
        expect(operations).toMatch(/(범위 밖|형식 오류)[^\n]*(fail-closed|sampleRate:[^\n]*0)/);
        expect(operations).toMatch(/(beta|베타)[^\n]*100%[^\n]*(검증|확인)/i);
        expect(operations).toMatch(
            /Session Replay 허용 경로 템플릿[^\n]*`\/`[^\n]*`\/privacy`[^\n]*`\/terms`[^\n]*`\/login`[^\n]*`\/analyze`[^\n]*`\/earlybird`[^\n]*`\/mypage`[^\n]*`\/progress\/:requestId`[^\n]*`\/result\/:requestId`[^\n]*`\/share\/:token`/i
        );
        expect(operations).toMatch(
            /query·hash[^\n]*동적 request ID·share token[^\n]*local UGC filter rule[^\n]*Replay meta[^\n]*batched click·scroll interaction[^\n]*식별자[^\n]*정적 경로 템플릿/i
        );
        expect(operations).toMatch(
            /알 수 없는 경로[^\n]*admin[^\n]*API 경로[^\n]*fail-closed/i
        );
        expect(operations).toMatch(
            /명시 이벤트[^\n]*페이지 URL[^\n]*(보내지 않|전송하지 않)/
        );
        expect(operations).toMatch(
            /click·scroll interaction[^\n]*batching[^\n]*network[^\n]*console[^\n]*performance[^\n]*document title[^\n]*끈다/i
        );
        expect(operations).toMatch(
            /클릭·스크롤 행동 관찰[^\n]*Session Replay interaction[^\n]*일반 autocapture[^\n]*(우회|켜지 않)/i
        );
        expect(operations).toMatch(
            /(고객|사용자 입력)[^\n]*(이메일|email)[^\n]*(연락처|contact)[^\n]*(replay|event)[^\n]*(보내지 않|전송하지 않)/i
        );
        expect(operations).toMatch(
            /light[^\n]*(일반|static)[^\n]*(text|텍스트|media|미디어)[^\n]*(보이|표시)/i
        );
        expect(operations).toContain('[data-amp-mask]');
        expect(operations).toContain('[data-amp-block]');
        expect(operations).not.toContain('contact@ascentum.co.kr');
        expect(operations).not.toContain('mailto:');
        expect(operations).toMatch(/DNT[^\n]*(GPC|Global Privacy Control)|(GPC|Global Privacy Control)[^\n]*DNT/);
        expect(operations).toMatch(/DNT[^\n]*GPC[^\n]*fail-closed[^\n]*sampleRate:[^\n]*0/i);
        expect(operations).toMatch(/Vercel[^\n]*(표본|sample)[^\n]*(권위|결정|적용)/i);
        expect(operations).toMatch(/Amplitude[^\n]*capture_enabled[^\n]*false[^\n]*(veto|차단)/i);
        expect(operations).toMatch(/(오류|실패|malformed|형식 오류)[^\n]*(fail-closed|sample[^\n]*0)/i);
        expect(operations).toMatch(/(캐시|cache)[^\n]*(거부|무시|적용하지 않)/i);
        expect(operations).toMatch(/(캐시|cache)[^\n]*(타임아웃|timeout)[^\n]*captureEnabled[^\n]*false/i);
        expect(operations).not.toMatch(/(타임아웃|timeout)[^\n]*sampleRate[^\n]*0/i);
        expect(operations).toMatch(/(마스킹|mask)/i);
        expect(operations).toMatch(/(차단|block)/i);
        for (const excludedValue of ['인스타그램', '이름', 'bio', '댓글', 'caption', '이미지', '미디어', '결제 연락처']) {
            expect(operations).toContain(excludedValue);
        }
        expect(operations).toMatch(/(replay|event)[^\n]*(보내지 않|전송하지 않)|(보내지 않|전송하지 않)[^\n]*(replay|event)/i);
        expect(env).toContain('NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_ENABLED=false');
        expect(env).toContain('NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_SAMPLE_RATE=0');
        expect(env).not.toContain('NEXT_PUBLIC_DEMO_ANALYSIS_ENABLED');
        expect(operations).toContain('닫힌 allowlist');
        expect(operations).toContain('얼리버드 전환 대시보드');
        expect(dashboardSection.match(/^\d+\. /gm)).toHaveLength(9);
        expect(operations).toMatch(/이벤트 기반[^\n]*이탈/);
        expect(operations).toMatch(/Plus[^\n]*대기 신청[^\n]*(만들지|제외)/);
        expect(operations).toMatch(/Comet[^\n]*UI/);
        expect(operations).toMatch(/금지 (속성|프로퍼티)[^\n]*검사/);
        expect(operations).toMatch(/롤백[^\n]*NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_ENABLED=false[^\n]*NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_SAMPLE_RATE=0/);
        expect(operations).toMatch(/NEXT_PUBLIC_AMPLITUDE_API_KEY[^\n]*(전체|all)[^\n]*(analytics|분석)[^\n]*(kill switch|중단)/i);
    });

    it('keeps Axiom runtime variables server-only and excludes provisioning credentials', () => {
        const env = source('.env.example');
        const provisioningCredential = ['AXIOM', 'PERSONAL', 'ACCESS', 'TOKEN'].join('_');
        const publicAxiomPrefix = ['NEXT', 'PUBLIC', 'AXIOM'].join('_');

        expect(env).toContain('AXIOM_TOKEN=');
        expect(env).toContain('AXIOM_DATASET=yeosachin-logs');
        expect(env).toContain('AXIOM_ORG_ID=');
        expect(env).not.toContain(provisioningCredential);
        expect(env).not.toContain(publicAxiomPrefix);
    });

    it('freezes the evidence-backed pre-Starter decision boundary', () => {
        const costs = source('docs/operations-cost-model.md');
        const checklist = source('docs/pre-starter-launch-checklist.md');
        const groble = source('docs/groble-earlybird-operations.md');

        for (const value of [
            '$3.33835',
            '$0.5858645',
            '$3.9242145',
        ]) {
            expect(costs).toContain(value);
        }
        expect(costs).toMatch(/Plus[^\n]*통제[^\n]*표본/);
        expect(costs).toMatch(/costComplete=false/);
        expect(costs).toMatch(/Gemini[^\n]*1건[^\n]*usage[^\n]*누락/);
        expect(costs).toMatch(/GCP[^\n]*포함하지/);
        expect(costs).toMatch(/Basic\/Standard[^\n]*(미측정|확정하지)/);
        expect(costs).toMatch(/최종 판매가[^\n]*(보류|확정하지)/);

        expect(checklist).toMatch(
            /reference-confirmed[^\n]*실결제[^\n]*1건 이상/
        );
        expect(checklist).toMatch(/미확인 paid[^\n]*0건/);
        expect(checklist).toMatch(/기한 초과[^\n]*0건/);
        expect(checklist).toMatch(/환불 책임[^\n]*0건/);
        expect(checklist).toMatch(
            /active analysis requests[^\n]*jobs[^\n]*provider runs[^\n]*fulfillment leases[^\n]*모두 0/
        );
        expect(checklist).toMatch(/Gemini[^\n]*8개[^\n]*available/);
        expect(checklist).toMatch(/quarantined[^\n]*0개/);
        expect(checklist).toMatch(
            /production migration history[^\n]*reviewed branch/
        );
        expect(checklist).toMatch(
            /Groble[^\n]*가격[^\n]*재고[^\n]*server catalog/
        );
        expect(checklist).toMatch(
            /Starter[^\n]*구매[^\n]*APIFY_SECONDARY_API_TOKEN[^\n]*명시적 승인/
        );
        expect(checklist).toMatch(
            /통과[^\n]*(구매|구독)[^\n]*(변경|교체)[^\n]*(자동|의미하지)/
        );
        expect(checklist).toContain('npm run report:earlybird-demand');

        expect(groble).toMatch(
            /awaiting_operator[^\n]*(analysis_requests|자동 분석)[^\n]*(만들지 않|시작하지 않)/
        );
        expect(groble).toContain('--confirm-paid-api-call');
        for (const document of [groble, checklist]) {
            expect(document).toContain(
                'EARLYBIRD_AUTOMATIC_FULFILLMENT_ENABLED=false'
            );
            expect(document).toMatch(
                /false[^\n]*(자동 승인|자동 입장)[^\n]*(하지 않|없)/
            );
            expect(document).toMatch(
                /정확히 `true`[^\n]*canonical `analysis-worker`[^\n]*(자동 승인|자동 입장)/
            );
        }
        expect(groble).toMatch(/기존[^\n]*awaiting_operator[^\n]*복구 pass/);
        expect(groble).toMatch(/false[^\n]*이미 admission_pending[^\n]*계속/);

        for (const document of [costs, checklist, groble]) {
            expect(document).not.toMatch(/Plus[^\n]*(구매 가능|판매 중)/);
            expect(document).not.toMatch(/최종 정가[^\n]*(확정|결정)/);
            expect(document).not.toMatch(/자동 public launch|자동 공개 출시/);
        }
    });

    it('documents the exact same-named senary authorized E2E boundary and teardown', () => {
        const runbook = source('docs/authorized-apify-sharded-e2e-runbook.md');
        const plan = source(
            'docs/superpowers/plans/2026-07-24-expand-authorized-senary-e2e-slot.md'
        );
        const exampleEnv = source('.env.example');

        expect(runbook).toMatch(/runtime slot[^\n]*`primary`[^\n]*`senary`/);
        expect(runbook).toMatch(/`septenary`[^\n]*(unsupported|지원하지 않)/);
        expect(runbook).toContain('APIFY_SENARY_API_TOKEN');
        expect(runbook).toMatch(/ai-baram-v2-apify-senary:<numeric-version>/);
        for (const binding of [
            'ANALYSIS_V2_APIFY_API_TOKEN_SLOT=senary',
            'ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWERS_SLOT=senary',
            'ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWING_SLOT=quinary',
            'ANALYSIS_V2_AUTHORIZED_TEST_PROFILE_FALLBACK_SLOT=senary',
            'ANALYSIS_V2_AUTHORIZED_TEST_TARGET_LIKERS_SLOT=senary',
            'ANALYSIS_V2_AUTHORIZED_TEST_TARGET_COMMENTS_SLOT=tertiary',
            'ANALYSIS_V2_AUTHORIZED_TEST_CANDIDATE_LIKERS_SLOT=quinary',
        ]) {
            expect(runbook).toContain(binding);
        }
        expect(exampleEnv).toMatch(
            /staging[^\n]*senary[^\n]*teardown[^\n]*primary/i
        );
        expect(exampleEnv).toContain('ANALYSIS_V2_APIFY_API_TOKEN_SLOT=senary');
        expect(plan).toContain('target profile and profile fallback/repair: senary');
        for (const document of [runbook, plan]) {
            expect(document).toContain(
                '--prune-apify-secret-refs=tertiary,quinary,senary'
            );
            expect(document).toMatch(/primary:3/);
            expect(document).toMatch(/active/i);
            expect(document).toMatch(/unreconciled|미정산/i);
            expect(document).toMatch(/profile-repair/i);
        }
        expect(runbook).toContain(
            'APIFY_PRIMARY_API_TOKEN=ai-baram-v2-apify-primary:3'
        );
        for (const mode of ['--dry-run', '--check']) {
            expect(runbook).toContain(
                `bash scripts/deploy-analysis-v2-worker.sh ${mode}`
            );
        }
        expect(runbook).toMatch(
            /bash scripts\/deploy-analysis-v2-worker\.sh \\\n\s+--prune-apify-secret-refs=tertiary,quinary,senary/
        );
        expect(runbook).toMatch(/staging 전과 promotion 직전/);
        expect(runbook).toMatch(/일반 deploy[\s\S]{0,120}보존/);
        expect(runbook).toMatch(/prune flag 없이 일반 deploy/);
        expect(runbook).toMatch(/deploy lock[\s\S]{0,80}정확히 300초/);
        expect(runbook).toMatch(/metadata\.generation[\s\S]{0,100}status\.observedGeneration/);
        expect(runbook).toMatch(/revision 생성 시각은 실제 serving 시간을 증명하지 않으므로/);
        expect(runbook).toMatch(
            /build manifest[\s\S]{0,100}Supabase URL[\s\S]{0,100}latest\/active Cloud Run/
        );
        expect(runbook).toContain(
            '--clear-apify-secret-ref-prune-fence=tertiary,quinary,senary'
        );
        expect(runbook).toMatch(
            /durable singleton DB fence[\s\S]{0,180}성공[\s\S]{0,120}실패[\s\S]{0,120}rollback[\s\S]{0,120}자동으로 해제하지 않는다/
        );
        expect(runbook).toMatch(
            /latest와 active inventory[\s\S]{0,180}compare-and-clear/
        );
        expect(runbook).toMatch(
            /owner, slot,[\s\S]{0,80}inventory가 바뀌면 실패[\s\S]{0,80}fence를 유지/
        );
        expect(plan).toMatch(/ordinary-deploy exact primary:3[\s\S]{0,240}300-second drain/);

        const standard = ANALYSIS_PLAN_CATALOG.standard;
        const relationshipRate = dotenvNumber(
            exampleEnv,
            'APIFY_RELATIONSHIP_ESTIMATED_COST_PER_RESULT_USD'
        );
        const fallbackRate = dotenvNumber(
            exampleEnv,
            'APIFY_PROFILE_ESTIMATED_COST_PER_RESULT_USD'
        );
        const likerRate = dotenvNumber(
            exampleEnv,
            'APIFY_LIKERS_ESTIMATED_COST_PER_RESULT_USD'
        );
        const commentRate = dotenvNumber(
            exampleEnv,
            'APIFY_COMMENTS_ESTIMATED_COST_PER_RESULT_USD'
        );
        const followerRelationshipExposure = (
            standard.relationshipCapacity.followers * relationshipRate
        );
        const followingRelationshipExposure = (
            standard.relationshipCapacity.following * relationshipRate
        );
        const fallbackExposure = standard.detailedMutualLimit * fallbackRate;
        const repairExposure = (
            standard.detailedMutualLimit
            * REPLACEMENT_PROFILE_ACTOR.estimatedResultCostUsd
        );
        const targetLikerExposure = (
            TARGET_LIKER_POST_LIMIT * TARGET_LIKER_LIMIT_PER_POST * likerRate
        );
        const commentExposure = (
            TARGET_COMMENT_POST_LIMIT * TARGET_COMMENT_LIMIT_PER_POST * commentRate
        );
        const candidateLikerExposure = (
            MAX_INTERACTION_CANDIDATES
            * CANDIDATE_INTERACTION_POST_LIMIT
            * CANDIDATE_LIKER_LIMIT_PER_POST
            * likerRate
        );
        const targetProfileAcquisitionExposure = (
            APIFY_PROFILE_SUMMARY_MAX_CHARGE_USD * 2
        );
        const senaryExposure = (
            followerRelationshipExposure
            + fallbackExposure
            + repairExposure
            + targetProfileAcquisitionExposure
            + targetLikerExposure
        );
        const quinaryExposure = followingRelationshipExposure + candidateLikerExposure;
        const tertiaryExposure = commentExposure;
        const liveBalanceMargin = 1.1;

        expect({
            followerRelationshipExposure: Number(followerRelationshipExposure.toFixed(6)),
            followingRelationshipExposure: Number(followingRelationshipExposure.toFixed(6)),
            fallbackExposure: Number(fallbackExposure.toFixed(6)),
            repairExposure: Number(repairExposure.toFixed(6)),
            targetProfileAcquisitionExposure: Number(
                targetProfileAcquisitionExposure.toFixed(6)
            ),
            targetLikerExposure: Number(targetLikerExposure.toFixed(6)),
            commentExposure: Number(commentExposure.toFixed(6)),
            candidateLikerExposure: Number(candidateLikerExposure.toFixed(6)),
            senaryExposure: Number(senaryExposure.toFixed(6)),
            quinaryExposure: Number(quinaryExposure.toFixed(6)),
            tertiaryExposure: Number(tertiaryExposure.toFixed(6)),
            senaryMinimumBalance: Number((senaryExposure * liveBalanceMargin).toFixed(6)),
            quinaryMinimumBalance: Number((quinaryExposure * liveBalanceMargin).toFixed(6)),
            tertiaryMinimumBalance: Number((tertiaryExposure * liveBalanceMargin).toFixed(6)),
        }).toEqual({
            followerRelationshipExposure: 0.68,
            followingRelationshipExposure: 0.68,
            fallbackExposure: 1.56,
            repairExposure: 1.62,
            targetProfileAcquisitionExposure: 0.0052,
            targetLikerExposure: 0.93,
            commentExposure: 0.234,
            candidateLikerExposure: 1.55,
            senaryExposure: 4.7952,
            quinaryExposure: 2.23,
            tertiaryExposure: 0.234,
            senaryMinimumBalance: 5.27472,
            quinaryMinimumBalance: 2.453,
            tertiaryMinimumBalance: 0.2574,
        });
        for (const formula of [
            '800 × $0.00085 = $0.68',
            '600 × $0.0026 = $1.56',
            '600 × $0.0027 = $1.62',
            'initial + fresh target profiles `2 × $0.0026 = $0.0052`',
            '4 × 150 × $0.00155 = $0.93',
            '6 × 15 × $0.0026 = $0.234',
            '10 × 1 × 100 × $0.00155 = $1.55',
        ]) {
            expect(runbook).toContain(formula);
        }
        for (const [slot, total, minimum] of [
            ['senary', '4.7952', '5.27472'],
            ['quinary', '2.23', '2.453'],
            ['tertiary', '0.234', '0.2574'],
        ]) {
            expect(runbook).toMatch(new RegExp(
                `\\| \`${slot}\` \\|[^\\n]*\\| \`\\$${total}\` \\| \`\\$${minimum}\` \\|`
            ));
        }
        expect(runbook).toMatch(/110%[^\n]*(balance|잔액)/i);
        expect(runbook).toMatch(/Actor[^\n]*(daily|일일)[^\n]*(quota|할당량|한도)/i);
        expect(runbook).toMatch(/quota[^\n]*(balance|잔액)[^\n]*(대체|갈음)[^\n]*(금지|않)/i);
        expect(runbook).toMatch(/baseline[^\n]*primary:3/i);
        expect(runbook).toMatch(/selected[^\n]*senary[^\n]*numeric/i);
        expect(runbook).toMatch(/selected plan[^\n]*Standard/i);
        expect(runbook).toMatch(/Standard[^\n]*(800|600)/i);
        expect(plan).toMatch(/authorized Standard E2E/i);
        expect(plan).not.toMatch(/authorized Plus E2E/i);
        expect(runbook).toMatch(/additional[^\n]*quinary[^\n]*tertiary/i);
        expect(runbook).toMatch(/false[^\n]*→[^\n]*true[^\n]*(유일|only)/i);
        expect(runbook).toMatch(
            /ANALYSIS_V2_ADMISSION_ENABLED=true[\s\S]{0,240}(ordinary|일반)[^\n]*(preflight|work)/i
        );
        expect(runbook).toMatch(
            /(ordinary|일반)[^\n]*(preflight|work)[^\n]*(중단|stop)[^\n]*(empty-work|empty work)/i
        );
        expect(runbook).toMatch(
            /live[\s\S]{0,80}(credit|크레딧)[\s\S]{0,80}Actor[\s\S]{0,80}(allowance|허용량|quota)/i
        );
        expect(runbook).toMatch(
            /profile-repair microcanary[\s\S]{0,100}senary[\s\S]{0,80}(지원하지 않|사용하지 않)/i
        );
        expect(runbook).toMatch(/signed `test_entitlement`[^\n]*(owner|소유자)[^\n]*(target|대상)/i);
        expect(runbook).toMatch(/sharding[^\n]*`false`/i);
        expect(runbook).toMatch(/temporary[^\n]*(reference|ref|참조)[^\n]*(제거|remove)/i);
        expect(runbook).toMatch(/teardown[^\n]*primary:3/i);
    });
});
