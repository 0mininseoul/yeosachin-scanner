import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../', import.meta.url);

function source(relativePath: string): string {
    const url = new URL(relativePath, root);
    return existsSync(url) ? readFileSync(url, 'utf8') : '';
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

        expect(runbook).toMatch(/runtime slot[^\n]*`primary`[^\n]*`senary`/);
        expect(runbook).toMatch(/`septenary`[^\n]*(unsupported|지원하지 않)/);
        expect(runbook).toContain('APIFY_SENARY_API_TOKEN');
        expect(runbook).toMatch(/ai-baram-v2-apify-senary:<numeric-version>/);
        for (const binding of [
            'ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWERS_SLOT=senary',
            'ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWING_SLOT=quinary',
            'ANALYSIS_V2_AUTHORIZED_TEST_PROFILE_FALLBACK_SLOT=primary',
            'ANALYSIS_V2_AUTHORIZED_TEST_TARGET_LIKERS_SLOT=senary',
            'ANALYSIS_V2_AUTHORIZED_TEST_TARGET_COMMENTS_SLOT=tertiary',
            'ANALYSIS_V2_AUTHORIZED_TEST_CANDIDATE_LIKERS_SLOT=quinary',
        ]) {
            expect(runbook).toContain(binding);
        }
        expect(runbook).toMatch(
            /live[\s\S]{0,80}(credit|크레딧)[\s\S]{0,80}Actor[\s\S]{0,80}(allowance|허용량|quota)/i
        );
        expect(runbook).toMatch(
            /profile-repair microcanary[\s\S]{0,100}senary[\s\S]{0,80}(지원하지 않|사용하지 않)/i
        );
        expect(runbook).toMatch(/signed `test_entitlement`[^\n]*(owner|소유자)[^\n]*(target|대상)/i);
        expect(runbook).toMatch(/sharding[^\n]*`false`/i);
        expect(runbook).toMatch(/temporary[^\n]*(reference|ref|참조)[^\n]*(제거|remove)/i);
        expect(runbook).toMatch(/normal selected slot[^\n]*`primary`/i);
    });
});
