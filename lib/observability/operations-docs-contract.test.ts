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
        expect(disclosure).toMatch(/Amplitude[^<]*?이용 통계[^<]*?Session Replay[^<]*?비활성화/);
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
        expect(operations).toContain('environment == "production"');
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

    it('documents the closed Amplitude schema with replay disabled and eight event panels', () => {
        const operations = source('docs/amplitude-analytics-operations.md');

        expect(operations).toContain('NEXT_PUBLIC_AMPLITUDE_API_KEY');
        expect(operations).toContain('Supabase UUID');
        expect(operations).toMatch(/Session Replay[^\n]*비활성화/);
        expect(operations).toMatch(/sampleRate[^\n]*0/);
        expect(operations).toContain('얼리버드 전환 대시보드');
        expect(operations.match(/^\d+\. /gm)).toHaveLength(8);
        expect(operations).toMatch(/이벤트 기반[^\n]*이탈/);
        expect(operations).toMatch(/Plus[^\n]*대기 신청[^\n]*(만들지|제외)/);
        expect(operations).toMatch(/Comet[^\n]*UI/);
        expect(operations).toMatch(/금지 (속성|프로퍼티)[^\n]*검사/);
        expect(operations).toMatch(/롤백/);
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
        expect(groble).toMatch(
            /awaiting_operator[^\n]*recovery[^\n]*자동 승인하지 않/
        );

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

        const plus = ANALYSIS_PLAN_CATALOG.plus;
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
            plus.relationshipCapacity.followers * relationshipRate
        );
        const followingRelationshipExposure = (
            plus.relationshipCapacity.following * relationshipRate
        );
        const fallbackExposure = plus.detailedMutualLimit * fallbackRate;
        const repairExposure = (
            plus.detailedMutualLimit * REPLACEMENT_PROFILE_ACTOR.estimatedResultCostUsd
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
        const senaryExposure = (
            followerRelationshipExposure
            + fallbackExposure
            + repairExposure
            + APIFY_PROFILE_SUMMARY_MAX_CHARGE_USD
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
            freshTargetProfileExposure: APIFY_PROFILE_SUMMARY_MAX_CHARGE_USD,
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
            followerRelationshipExposure: 1.02,
            followingRelationshipExposure: 1.02,
            fallbackExposure: 2.34,
            repairExposure: 2.43,
            freshTargetProfileExposure: 0.0026,
            targetLikerExposure: 0.93,
            commentExposure: 0.234,
            candidateLikerExposure: 1.55,
            senaryExposure: 6.7226,
            quinaryExposure: 2.57,
            tertiaryExposure: 0.234,
            senaryMinimumBalance: 7.39486,
            quinaryMinimumBalance: 2.827,
            tertiaryMinimumBalance: 0.2574,
        });
        for (const formula of [
            '1200 × $0.00085 = $1.02',
            '900 × $0.0026 = $2.34',
            '900 × $0.0027 = $2.43',
            'fresh target profile `$0.0026`',
            '4 × 150 × $0.00155 = $0.93',
            '6 × 15 × $0.0026 = $0.234',
            '10 × 1 × 100 × $0.00155 = $1.55',
        ]) {
            expect(runbook).toContain(formula);
        }
        for (const [slot, total, minimum] of [
            ['senary', '6.7226', '7.39486'],
            ['quinary', '2.57', '2.827'],
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
