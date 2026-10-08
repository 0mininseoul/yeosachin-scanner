# Dev UI 검증 환경 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development. 상위 세션이 편집권·의존성·환경 연결·PR·통합 검증을 맡는다. 구현자와 다른 agent가 명세 준수 후 코드 품질을 순서대로 검토한다.

**Goal:** 승인한 별도 Free Supabase·Vercel에서 모의 결제 후 합성 분석 UI를 검증하고, 검증한 후보만 main에 반영한다.

**Architecture:** Production schema 기준점은 데이터 없이 복제하고 환경별 외부 동작을 비활성화한다. Dev identity를 검증한 서버만 합성 preflight·모의 주문·원자적 실행 연결을 사용한다. 기존 화면과 순수 demo projection을 재사용하되 production demo의 즉시 결과 이동·예약 target·결과 cookie 우회는 재사용하지 않는다.

**Tech Stack:** Next.js 16·React 19·Supabase Auth/PostgreSQL·Vercel·기존 Vitest/PGlite·Aside CLI.

작성일: 2026-10-09 KST. 한국어 원본. 사용자가 [설계](../specs/2026-10-09-dev-ui-environment-design.ko.md)의 추천 후보 브랜치 방식을 승인했다. Vertex US$1 예산은 별도 승인 대기이며 이 계획의 실행에 필요하지 않다.

## 편집권과 공통 경계

- 상위: 이 계획·배포 identity 등록 파일·schema 기준점/안전한 영수증·운영 설정·도메인·OAuth·상태판·Git.
- D1 구현자: 배포/origin guard·proxy·Dev telemetry 차단·그 기능의 기존 검사.
- D2 구현자: `lib/services/dev-ui/`의 계약/store/projection·Dev 전용 control SQL·DB 행동 검사. D1 파일은 읽기만 한다.
- D3 구현자: preflight/checkout/progress/result/archive의 Dev 분기와 모의 checkout UI·관련 기존 route/UI 검사. D1/D2 완료 후 진행한다.
- 독립 schema 조사와 코드/명세 리뷰는 읽기 전용으로 병렬 진행한다. 다른 작업자의 변경을 되돌리거나 공유 파일을 동시에 편집하지 않는다.
- 실제 계정 분석·카드 결제·Apify/Vertex/RapidAPI/Instagram·운영 메일/Discord/Amplitude/R2·production worker 호출은 하지 않는다. 원시 행·UUID·credential은 기록하지 않는다.

## D0: 계정·무료 범위·운영 schema 기준점

파일/도구: canonical root의 native Supabase linked metadata, 격리된 0700 임시 workdir, `supabase db query`, `pg_dump`가 사용 가능한 경우 그 schema-only 출력, `supabase/dev-ui/`의 검토된 초기화 자료.

- [x] Aside에서 지정 계정과 Free 조직/생성 eligibility를 확인하고 신규 `yeosachin-dev` 프로젝트를 생성한다. 자동 유료 전환·기존 프로젝트 pause/delete·production link 변경을 하지 않는다. DB password는 UI의 생성 경로를 사용하며 값을 읽거나 출력/보존하지 않는다.
- [x] Production CLI는 canonical root의 인증·linked identity를 기준으로 사용한다. 실패한 원문은 출력하지 않고 parse 대상·안전한 오류 분류만 남긴다. 동일 실패를 반복하지 않는다.
- [x] 현행 user-defined schema·extension·managed Auth/Storage에 붙은 사용자 정의 trigger/policy·Realtime 의존성을 catalog로 확인한다. public-only snapshot이나 과거 392 migration의 무조건 적용으로 대체하지 않는다.
- [x] schema-only 정의는 메모리에서 고정 UUID/JWT/비밀값/외부 목적지 검사를 먼저 수행한 후 안전한 자료만 저장한다. 환경별 함수·cron·webhook·Discord signup outbox trigger는 Dev에서 비활성화할 대상을 개별 검토하고 parity 예외를 명시한다.
- [x] 기본 테이블/타입/제약/index/view/RPC/권한/RLS의 구조 hash를 비교한다. Dev 지원용 private control namespace/RPC가 필요한 경우 production 기준점과 별도로 관리한다. Production 기준 객체를 완화하거나 remote DDL/history를 변경하지 않는다.

catalog 검증 입력은 업무 행 대신 `pg_namespace`, `pg_class`, `pg_attribute`, `pg_constraint`, `pg_index`, `pg_proc`, `pg_policy`, `pg_trigger`, grants 및 publication metadata다. 결과는 객체 개수·일치/예외 개수와 안전한 hash만 기록한다.

D0 검증: 기준점 2,935개 중 strict 2,793·제한 정규화 136·명시 환경 예외 6개로 미분류 0. 추가 보안/비SQL metadata 3,775개 strict match 및 구현자 외 통합 리뷰 PASS. 이는 D2 추가 객체 적용 전 기준점이다.

## D1: 배포 identity·origin·외부 동작 차단

파일: `lib/constants/app-url.ts`, 새 Dev 배포 identity/guard 모듈, `proxy.ts`, 기존 client/server telemetry 진입점, `tests/shared/constants/app-url.test.ts`와 직접 관련 검사.

- [x] 기존 origin 검사를 먼저 실행하고 Dev production build가 production origin으로 돌아가는 실패를 추가한다. 알 수 없는 Host·중첩 redirect·production DB·잘못된 Vercel identity를 거절하는 검사를 함께 작성한다.
- [x] `NODE_ENV`가 아닌 명시적 배포 역할과 등록한 실제 Dev Vercel/Supabase identity 조합으로 Dev 서버를 판정한다. 사용자 header/query/body는 판정에 사용하지 않는다. 등록 전에는 fail-closed로 유지한다.

검증할 핵심 계약은 다음과 같다.

```ts
type RegisteredDevIdentity = Readonly<{
    vercelProjectId: string;
    supabaseProjectRef: string;
}>;
type DeploymentEnvironment = Readonly<Record<string, string | undefined>>;
function matchesRegisteredDev(
    env: DeploymentEnvironment,
    registered: RegisteredDevIdentity,
): boolean {
    if (env.DEPLOYMENT_ROLE !== 'dev'
        || env.VERCEL_PROJECT_ID !== registered.vercelProjectId) return false;
    try {
        const url = new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? '');
        return url.protocol === 'https:'
            && url.hostname === `${registered.supabaseProjectRef}.supabase.co`
            && !url.username && !url.password && url.pathname === '/';
    } catch { return false; }
}
```

- [x] Dev 앱 origin은 고정 `https://dev.yeosachin.com`으로 제한한다. Production/localhost의 기존 redirect 계약과 host-only cookie를 유지한다. 브라우저의 테스트 표시와 서버 권한 판정은 별개로 둔다.
- [x] Dev proxy/API 경계에서 필요한 Auth·owner read·합성 flow API만 허용한다. 기존 worker·admission·webhook·실제 결제/provider 작업은 handler 실행 전에 거절한다. 합성 handler도 내부에서 guard와 테스트 계정 allowlist를 반복 확인한다.
- [x] Dev에서는 운영 telemetry/client init을 건너뛰고 테스트 표시·검색 차단을 제공한다. `app/page.tsx`의 기존 마케팅 카피는 변경하지 않는다.
- [x] 관련 검사·타입체크·대상 ESLint를 실행하고 명세 리뷰 후 코드 품질 리뷰를 받는다. 외부 client/fetch spy는 provider 호출 0회를 확인한다.

D1 검증: 12개 파일·301개 검사, 타입체크·대상 ESLint·diff 검사와 구현자 외 명세/품질 리뷰 PASS. 빌드/런타임 DB identity 불일치 양방향 거절과 정상 Next chunk 허용을 포함한다.

## D2: persisted 모의 주문과 합성 실행

파일: 새 `lib/services/dev-ui/contracts.ts`, `store.ts`, `projection.ts`, `supabase/dev-ui/control-plane.sql`; 기존 demo의 순수 projection·계약 정의는 읽기/재사용한다.

- [x] 아래 계약을 구현하고 malformed row·소유권 불일치·동일 idempotency 다른 payload를 거절한다. 합성 fixture는 고정 version·로컬 소유 asset만 사용하며 기존 production fixture 행을 복사하지 않는다.

```ts
type DevCheckoutOutcome = 'success' | 'cancel' | 'failure';
type DevCheckoutCompletion =
    | { status: 'success'; orderId: string; runId: string; replayed: boolean }
    | { status: 'cancel' | 'failure'; orderId: string; runId: null; replayed: boolean };
type DevUiStore = {
    createOrReplayPreflight(input: {
        userId: string; targetInstagramId: string; idempotencyKey: string;
    }): Promise<{ preflightId: string; expiresAt: string; created: boolean }>;
    createOrReplayCheckout(input: {
        userId: string; preflightId: string; planId: 'basic' | 'standard';
        disclosureAccepted: true;
    }): Promise<{ orderId: string; nextUrl: string; expiresAt: string }>;
    completeCheckout(input: {
        userId: string; orderId: string; outcome: DevCheckoutOutcome;
    }): Promise<DevCheckoutCompletion>;
};
```

- [x] 소유자/preflight unique 및 주문당 실행 unique를 DB에서 보장한다. success RPC는 row lock 뒤 TTL·소유자·상태·plan snapshot을 검증하고, 완료와 유일 실행 생성/시작을 같은 transaction에서 확정한다. 이미 success이면 기존 run/start를 반환한다. cancel/failure는 실행·TTL 연장을 만들지 않는다.
- [x] control table/RPC는 Dev에만 적용한다. 기본 schema parity와 추가 Dev control 객체는 분리 검증하며, service role 외 RPC 권한을 허가하지 않는다. 운영 outbox·실제 fulfillment·queue를 쓰지 않는다.
- [x] 기존 `projectDemoProgress`, result pagination/summary 계약을 이용해 persisted start/version의 결정적 상태를 구성한다. 완료/부분/실패/빈 결과 fixture를 명시적으로 선택할 수 있게 한다. 결과 cookie 우회는 발급하지 않는다.
- [x] PGlite/기존 DB 검사 경계에서 success/cancel/failure·소유권·병렬 중복 완료·미결제 TTL 직전/직후·완료 직후 중단 replay·30분 이상 지연을 검증한다. 완료 주문당 실행/시작은 1개여야 한다.
- [x] 명세 리뷰 후 코드 품질 리뷰를 받는다. reviewer가 발견한 문제를 해결한 뒤 다음 단계로 간다.

D2 검증: 2개 파일·30개 검사, 타입/ESLint/diff 및 독립 명세→품질 리뷰 PASS. 기존 global/public default ACL을 보존하도록 P1 수정 전 RED·수정 후 PASS를 확인했다. 실제 Dev PostgreSQL의 독립 세션 row lock·원자적 가시성·완료 실행 1개·동일 시작 replay·미결제 TTL 경과 후 완료 복구·취소/실패 실행 0개를 확인했다. 합성 Auth/업무 행은 특정 생성 범위로 정리했고 실제 사용자 자료는 사용하지 않았다. 원격 RPC 권한도 anon/authenticated 차단·service_role 허용으로 확인했다.

## D3: 기존 UI/API 연결

파일: `app/api/analysis/preflight/route.ts`, `[preflightId]/route.ts`, `app/api/earlybird/checkout/route.ts`, `app/api/analysis/v2/progress/[requestId]/route.ts`·`result/[requestId]/route.ts`의 실제 존재 경로, `app/analyze/page.tsx`, `lib/services/earlybird/checkout-continuation.ts`, `app/mypage/page.tsx`, 새 Dev checkout page/API, 관리자 Dev 모의 감사 영역.

- [x] Dev preflight를 합성 ready로 연결한다. accepted DTO는 `demo:true`를 넣지 않는다. 그 값은 현재 UI에서 즉시 result로 이동하는 계약이기 때문이다. `demoResponseHeaders()`의 analytics/action capability만 재사용한다.
- [x] Dev checkout 목적지를 엄격한 내부 경로 검증에 추가한다. 실제 Groble sandbox/독립 설정을 공식 근거로 확인할 수 없으면 승인된 모의 checkout을 사용한다. 운영 Groble 주소/secret/webhook에 모의 이벤트를 보내지 않는다.
- [x] 성공/취소/실패 UI를 제공하고, 성공 확정 응답의 run으로 기존 progress 화면을 연다. double submit·새로고침·재방문은 같은 실행을 복구한다. 완료 전 result는 거절하고 소유자 외 상세 조회도 거절한다.
- [x] archive와 관리자에는 모의 주문/실행 표시를 제공한다. 읽기 감사만 허용하고 provider refresh/실제 dispatch/action은 Dev에서 차단한다. 운영자 목록은 Dev Auth 계정으로 별도 등록한다.
- [x] 기존 preflight/checkout/progress/result/demo capability 검사를 실행하고 필요한 Dev 행동 검사만 추가한다. 모바일/데스크톱 실제 UI 확인은 D5에서 수행한다.
- [x] 명세 리뷰 후 코드 품질 리뷰를 받는다.

D3 구현 검증: 22개 파일·360검사 및 타입/ESLint/diff PASS. 독립 명세 리뷰 16개 파일·312검사 PASS, 별도 품질 리뷰 7개 파일·127검사 PASS. 원격 Next build가 발견한 GET Request 타입 오류는 556e579d에서 수정해 관련 79검사·명세/품질 리뷰와 실제 빌드 PASS를 확인했다. 실제 Dev 로그인에서 발견한 KOE205는 e21f823f에서 Dev 요청 scope 3개로 최소 수정했으며 관련 95검사·명세/품질 리뷰·새 배포의 실제 SSO/user-me 200·Dev 복귀를 확인했다. 운영 scope 7개는 유지한다. 전체 Aside UX 검증은 D5에서 진행한다.

UI fidelity 보완: e21 후보의 Dev가 기존 immersive 대기·성별 확인·미리보기를 생략하는 것을 발견했다. 공유 Production 화면과 callback을 그대로 사용하고 API·cache·telemetry보다 먼저 순수 합성 표시 DTO를 반환하도록 4파일을 보완했다. 관련 11파일·216검사, 타입/ESLint/diff PASS와 서로 다른 agent의 명세·품질 리뷰(각 2파일·43검사)를 확인했다. 성별 확인은 고정 합성 DTO의 로컬 표시이며 실제 추론·영속 성별 정정을 검증하지 않는다. 주문은 명시적인 구매 클릭 이후에 생성하고, 전체 run은 모의 결제 성공 확정 이후에만 생성한다. a299 후보의 실제 성별 확인 예/아니오·미리보기·플랜·모의 결제 이후 failed/empty 결과를 D5에서 확인했다. 결과 시안 승인과 영향을 받는 최종 검증·승격은 아직 미완료다.

## D4: Vercel·OAuth·도메인 연결

파일/도구: Dev 전용 배포 workdir/linked metadata, native Vercel CLI, Aside의 지정 Supabase 계정과 카카오 개발자 설정, 신규 Dev identity 등록 자료.

- [x] 기존 팀에 별도 `yeosachin-dev` Vercel 프로젝트를 만든다. Hobby 외 유료 기능/seat/domain purchase는 사용하지 않는다. Production 프로젝트/도메인/link를 이동하지 않는다.
- [x] Dev Supabase의 URL·publishable/anon·service key만 메모리에서 native Vercel stdin으로 전달한다. root `.env.local` 전체 복사·local secret 파일·credential argument/출력은 만들지 않는다. 등록한 non-secret identity를 후보 코드에 고정한다.
- [x] Dev Site URL·app callback을 `dev.yeosachin.com`으로 설정한다. 카카오 provider callback은 Dev Supabase의 `/auth/v1/callback`이다. 허가된 Dev OAuth 설정만 적용하고 Production 설정을 대체하지 않는다.
- [x] `dev` subdomain의 필요한 새 DNS만 추가하고 native inspect로 프로젝트/도메인 일치를 확인한다. 권한/무료 quota 부족이면 해당 작업을 중단하고 정확한 blocker·재개 조건을 남긴다.
- [x] 후보 브랜치를 고정 Dev 도메인에 배포한다. Dev 검증 전에 main merge를 하지 않는다.

D4 검증: 새 Dev Auth 카카오 principal을 메모리에서 확인해 tester/admin/operator 3개 allowlist의 production/preview 6개 sensitive 기록을 별도 등록했다. 최신 a299eb34 후보의 dpl_Aw1pZzD5WENkCKu7XoVx9C9EhF4Y가 exact Dev project·READY다. 처음 `--local-config vercel.dev.json`만 사용한 배포에 cron 2개가 남는 것을 native project에서 발견했다. Dev-only disable 후, 0700 임시 tracked archive의 표준 vercel.json에 승인된 Dev 설정을 적용해 재배포했다. 실제 cron disabled·정의 0개·Git 자동 배포 없음·임시 자료 정리를 확인했으며 Production/source checkout의 vercel.json은 바꾸지 않았다. 원격 builder 내부 우선순위는 미확인이다. 후보 source SHA와 설정 overlay SHA를 함께 기록한다.

## D5: 통합·Aside·승격

- [x] 현재 a299 후보의 기능 경계 검사·`npx tsc --noEmit`·대상 ESLint·`git diff --check`와 exact-head CI를 완료했다. 새 UI 구현 이후 영향을 받는 검사를 다시 수행한다. 새 오류나 변경 없이 전체 suite를 반복하지 않는다.
- [x] D0/D2에서 Dev DB 기준 schema parity·Dev control 권한/transaction과 운영 데이터 미복제를 확인했다. 실제 브라우저 업무 데이터도 합성 fixture만 사용한다. Production 행 복제나 추가 DDL은 하지 않는다.
- [ ] Aside CLI로 카카오 로그인/로그아웃·deep link·preflight ready·플랜·모의 checkout cancel/failure/success·진행·완료/부분/실패·result 재방문·archive·관리자 읽기를 확인한다. 모바일/데스크톱과 빈 결과/권한 부족/조회 실패를 포함한다. 원시 화면 행·UUID·cookie는 기록하지 않는다.
- [ ] 10월 9일 추가 요청에 따라 실제 사용자가 흐름과 다음 행동을 이해할 수 있는지 UX·시각 감사를 함께 수행한다. 현재 실행에서 캡처한 안전한 화면을 직접 확인하고 단계별 상태·발견 사항·접근성 검증 한계를 기록한다. 재구성이 필요한 화면은 구현 전에 현재 디자인을 기반으로 시안을 만들고 한국어 검토본의 승인을 받는다. 기능 오류의 최소 수정과 시각 재설계를 구분한다.
- [x] provider/client 차단 검사·금지 credential 없음·cron 정의 0개와 실제 브라우저 리소스 분류에서 Apify·Vertex·실제 카드/메일/운영 telemetry/worker 미호출을 확인했다. 브라우저 관측은 서버 egress/billing 전수 감사가 아니며 UI 성공을 실제 worker/provider 품질 성공으로 기록하지 않는다.
- [x] a299 commit/tree·runtime/설정 hash·schema 기준점·Dev identity·검사/Aside safe receipt를 연결했다. runtime 변경 시 영향을 받는 검증과 배포를 갱신한다.
- [ ] PR → exact-head 검사·구현자와 다른 agent의 명세/품질 리뷰 → main merge → root main/origin/main fetch/fast-forward 동기화로 마감한다. 기존 보호 파일·보존 refs/stash 불변을 확인한다.

D5 실제 관측과 미결: [UX 감사](../../operations/2026-10-09-dev-ui-ux-audit.ko.md), [안전한 브라우저 영수증](../../operations/2026-10-09-dev-ui-browser.safe.json). 로그아웃·관리자 deep link·Kakao Dev 복귀, 모의 결제 취소/실패/성공, complete/partial/failed/empty 화면과 확인한 새로고침·복귀·dialog focus 동작을 기록했다. 부분 수집 안내·점수 의미·Dev 관리자 대비·상태/복귀의 공통 개선과 [결과 시안](../specs/2026-10-09-analysis-result-ux-review.ko.md)은 사용자 승인 대기다. 전체 UX PASS는 아니며 PR #603은 draft, #602도 미병합이다. Aside REPL은 request interception을 제공하지 않아 503/망단절 주입은 실제로 검증하지 않았고, 실패한 합성 실행의 결과404와 실패 화면/입력 복귀는 확인했다. 실제 계정·실물 기기·스크린리더·결제사/provider 품질은 별도 경계다.

## 별도 Vertex 최소 수정과 비용

공유 selector의 일부 escalation이 3.7 + MINIMAL을 만드는 확정된 계약 오류는 별도 branch/PR로 최소 수정한다. SDK·DB mock 검사로 검증하며 실 호출/품질 승격은 하지 않는다. Dev 검증 후보에 포함할 때 source commit을 연결한다. US$1 실제 연결 probe는 별도 사용자 승인 및 thinking 포함 과금 ceiling 확인 이후에만 수행한다.
