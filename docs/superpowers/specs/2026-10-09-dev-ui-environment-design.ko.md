# Dev UI 검증 환경 설계 — 승인됨

작성일: 2026-10-09, Asia/Seoul. 이 문서는 한국어 원본이다. 사용자가 2026-10-09에 전체 설계와 추천 후보 브랜치 방식을 승인했다. 프로젝트 생성·도메인 연결·구현은 이 승인에 따라 진행한다.

## 목표와 사용자 결정

현재 단일 Supabase·Vercel production 환경과 분리된 `dev.yeosachin.com`에서 로그인 → 사전 점검 → 플랜/checkout → 결제 완료 → 자동 진행 → 결과/보관함 → 관리자 조회를 반복 검증한다. Instagram 수집과 AI 생성은 더미 데이터로 대체하며 Apify·Vertex·RapidAPI·실제 Instagram 호출을 만들지 않는다. Dev에서 검증한 변경만 PR·독립 리뷰·관련 검사 후 main으로 승격한다.

- Supabase 계정은 사용자가 지정한 `ascentumf4@gmail.com`을 사용한다.
- 사용자는 **결제사 테스트 모드 우선, 미지원이면 결제 완료 이벤트 모의**를 선택했다. Dev에서 실제 카드 결제·운영 Groble 상품/재고 변경을 수행하지 않는다.
- 첫 단계는 **UI 검증**이다. 실제 provider 성공·Vertex 품질·production worker/queue 부하 성공으로 해석하지 않는다.
- 별도 Vertex 실제 호출은 금액 승인 후에만 허용된다. 이 Dev 더미 환경에는 AI 호출을 포함하지 않는다.
- 기존 관리자 접근 오류는 독립된 [PR #600](https://github.com/0mininseoul/yeosachin-scanner/pull/600)에서 수정한다. 이 환경 설계 승인이 그 수정의 권한 경계를 완화하지 않는다.

## 접근 방법 비교와 권고

| 방법 | 장점 | 제약 | 판정 |
| --- | --- | --- | --- |
| 별도 Dev DB·Vercel + UI용 합성 실행 | 고정 도메인, 운영 데이터/키 분리, 수집·AI 없이 checkout 이후 화면 검증. 추가 GCP worker·queue 불필요 | 실제 V2 DAG·Cloud Tasks·lease·복구를 검증하지 않음 | **1차 권고** |
| 별도 Dev DB·Vercel + 전체 V2 합성 worker | 실제 Dev DB의 admission·DAG·checkpoint·Realtime·복구까지 검증 | Dev 전용 worker 2개·queue·OIDC/IAM·dispatcher 구성과 별도 비용 산정 필요 | 필요할 때 2차 설계·승인 |
| 운영 DB 안에 테스트 schema/행만 추가 | 초기 인프라 설정이 적음 | Auth·프로젝트 설정·운영 함수·외부 목적지의 격리가 약함 | 채택하지 않음 |

UI만 검증하려는 현재 목표에 전체 worker 인프라를 먼저 구축하지 않는다. 다만 기존 demo 그대로는 preflight 단계에서 이미 실행을 시작하고 checkout은 진행 화면만 반환하므로, **Dev에서는 결제 완료 이후에만 합성 실행을 시작하도록 수명을 바꿔야 한다**.

## 환경 구성과 격리

| 항목 | Production | Dev |
| --- | --- | --- |
| 웹 | 기존 `yeosachin.com`·기존 Vercel 프로젝트 | 신규 별도 Vercel 프로젝트·`dev.yeosachin.com` |
| DB/Auth/Realtime | 기존 linked Supabase 프로젝트 | 지정 계정의 신규 별도 Supabase 프로젝트 |
| schema | 현행 검증된 정의 | 승인한 동일 schema 기준점과 이후 동일 migration |
| 업무 데이터 | 현재 운영 데이터 | 새 로그인 사용자의 Dev Auth 컨텍스트와 합성 seed/주문/분석 |
| 결제 | 기존 Groble 운영 경로 | 지원이 확인된 sandbox 또는 Dev 전용 모의 완료 경로 |
| 분석 | 기존 실제 provider·worker | Dev 전용 합성 진행/결과 어댑터 |
| provider·메일·분석 telemetry | 현행 운영 구성 | 유료 수집/AI·R2·운영 Resend/Discord/Amplitude 전송 없음 |

Dev의 URL/key/service role은 Dev Supabase만 가리킨다. `.env.local` 전체, 운영 사용자·주문·결제·Instagram 자료, Auth 행, Storage 객체, vault 값, provider 토큰, 운영 Tasks target/IAM credential을 복제하지 않는다. 기존 root `.env.local`·`.playwright-mcp/`·보호 migration·보존 refs/stash는 유지한다.

Dev는 운영체제의 `NODE_ENV`와 별개인 배포 역할 및 검증된 Vercel project/Supabase project identity로 판정한다. Vercel Dev 프로젝트도 production build를 사용하기 때문이다. 더미 어댑터는 승인한 Dev identity에서만 선택 가능하고, production DB/프로젝트·불일치 origin/identity에서는 생성·결제 모의·분석 시작 전에 거절한다. 클라이언트 query/header나 일반 사용자가 모드를 선택할 수 없다.

Dev는 허용된 테스트 계정에 한정하고 화면에 테스트 환경·모의 결제/결과 표시를 제공한다. 검색 노출을 차단한다. 기존 production 마케팅 카피는 변경하지 않는다.

## Schema 기준점과 초기화

현행 운영 schema의 테이블·타입·제약·index·view·RPC/function·trigger·grant·RLS·필요한 Realtime publication과 extension 의존성을 기준으로 Dev 초기화 자료를 만든다. 테이블 이름과 개수만 맞추는 것으로 완료하지 않는다.

초기화 자료는 업무 행을 포함하지 않는 검토된 schema 기준점과 별도 합성 seed다. 함수·trigger 정의에 환경 전용 주소/식별자/비밀값이 들어 있는지 저장 전에 검사한다. 발견된 값은 자동 복사·자동 치환하지 않고 Dev에서 유지할 동작과 환경 구성을 먼저 분리·검토한다. Supabase가 관리하는 Auth/Storage 시스템 객체는 새 프로젝트의 관리 정의와 필요한 사용자 정의 의존성을 구분한다. cron 실행·webhook 목적지·운영 알림은 Dev로 활성화하지 않는다.

과거 source-set 392개 parity는 빈 DB 초기화 검증이 아니다. **과거 migration 392개를 무조건 실행하거나 production correction DML을 Dev에 적용하지 않는다.** 기존 production의 local-only/remote-only 6대6 차이와 비공개 보존 원본은 유지한다. `history repair`·`--include-all`·production reset을 하지 않는다.

최초 기준점 이후에는 같은 신규 migration을 먼저 Dev에서 검증한다. production 적용이 필요한 경우 정확한 allowlist·dry-run·독립 리뷰·원격 history 검증 절차를 따른다. Dev 검증만으로 임의 production DDL을 허가하지 않는다. 이 설계의 완료에 추가 DB 경량화나 22-table 목표는 포함하지 않는다.

## 카카오 로그인과 도메인

현재 `lib/constants/app-url.ts`는 localhost를 제외한 주소를 production origin으로 고정한다. 환경값만 `dev.yeosachin.com`으로 바꾸면 OAuth·로그아웃·공유/결과 링크가 운영으로 나갈 수 있다. 승인된 배포 역할별 origin을 검증하는 정책으로 바꾸고 request Host를 임의 redirect 근거로 사용하지 않는다.

Dev Supabase Site URL과 앱 redirect는 `https://dev.yeosachin.com`·`https://dev.yeosachin.com/auth/callback`이다. 카카오 provider에 등록할 URI는 **Dev Supabase의 `/auth/v1/callback`**이며 앱 callback과 구분한다. Dev의 실제 auth 식별자는 production과 별개이므로 운영자 목록도 별도로 등록한다. 기존 production 로그인 설정을 대체하지 않으며 cookie Domain을 `.yeosachin.com`으로 넓히거나 production cookie를 옮기지 않는다.

도메인은 신규 Vercel 프로젝트에만 연결한다. 기존 production 도메인·DNS 레코드·연결을 이동하거나 덮어쓰지 않는다. 공급자가 요구하는 정확한 신규 subdomain 레코드를 확인한 뒤 추가한다.

## Checkout 이후 합성 자동 진행

Dev에서도 사용자 소유권·플랜/가격 snapshot·주문 상태·중복 방지·결과 접근 경계를 유지한다. 미리 완료 결과만 반환하는 UI stub 대신 checkout 이후의 상태 변화를 제공한다.

1. Dev preflight는 합성 프로필과 일관된 플랜 snapshot을 만들고 준비 상태까지만 진행한다. 여기서는 분석을 시작하지 않는다.
2. checkout은 Dev 주문을 만든다. Groble 공식 sandbox 지원과 독립 설정이 확인되면 sandbox만 사용한다. 현재 앱에 sandbox 구현이 없고 서비스 지원도 확정되지 않았으므로 **1차 구현 기본값은 Dev 모의 checkout**이다.
3. 모의 checkout은 성공/취소/실패를 선택할 수 있다. 성공은 인증된 소유자의 해당 주문·플랜에만 적용되는 Dev 서버 계약으로 결제 완료 상태를 만들며, 중복 완료는 한 번만 효력을 갖는다. 운영 Groble webhook에 모의 이벤트를 보내거나 운영 webhook secret을 사용하지 않는다.
4. 완료 확정 뒤에만 합성 실행을 시작한다. Dev DB에 소유자와 주문의 연결, 진행/실패/결과 수명을 유지하고 새로고침·재방문에도 같은 실행이 이어진다. 미결제 주문의 만료와 완료 주문의 실행 수명을 분리한다. 모의 완료와 주문당 유일한 실행 연결은 같은 DB transaction에서 확정하며, 완료 후 응답 중단·재시도·재방문은 그 실행을 복구한다. 진행 시작이 지연되어도 완료된 주문을 기존 demo의 미시작 30분 TTL로 거절하거나 두 번째 실행을 만들지 않는다. 완료된 실행에는 별도의 명시적 보존/만료 정책을 적용한다. 기존 demo의 합성 fixture·진행/결과 renderer·소유권 계약을 재사용하되 checkout 이전 실행·미결제 만료·production demo 동작은 섞지 않는다.
5. 진행 화면과 결과 API에는 실제 UI가 소비하는 계약에 맞는 합성 데이터를 공급한다. 주문·결과·감사 조회가 모의 실행이라는 점을 구분한다. profile/comment/media, 결과 이미지/파일도 합성 또는 소유한 정적 Dev asset이며 실제 수집·이미지 capture·archive를 하지 않는다.
6. 일반 production provider registry·beta credit refresh·운영 outbox를 생성하지 않는다. API key 부재만으로 무호출을 보장하지 않고, 테스트에서 외부 fetch/client를 차단해 예상치 못한 외부 호출이 발생하면 실패시킨다.

이 단계는 production Cloud Tasks/DAG를 재현하지 않는다. 별도 queue/worker가 필요하지 않은 이유이며, 그 통합 경계를 검증하려면 위 2차 방식을 별도 설계한다.

## 브랜치와 승격

고정 Dev 환경과 검증할 Git 후보를 분리한다. **추천은 `codex/*` 후보를 Dev에 배포하고, 그 후보를 검증한 뒤 main PR을 병합하는 방식**이다. 장기 `dev` 브랜치의 미검증 변경이 함께 승격되는 문제를 줄이고 기존 PR→검사/독립 리뷰→main 절차를 유지한다.

장기 `dev`를 사용한다면 feature PR→dev와 검증된 dev 후보→main PR을 분리하고, merge 뒤 다시 main과 동기화해야 한다. 사용자가 제안한 `dev` 브랜치는 가능한 대안이며, 이 설계의 기본안은 단기 후보를 직렬로 고정 Dev 도메인에 배포하는 것이다.

승격 근거에는 후보 commit·code tree 또는 artifact hash, schema 기준점, Dev identity, 검사/Aside 결과를 연결한다. 후보 코드나 migration이 바뀌면 관련 Dev 검증을 갱신한다. main은 직접 push하지 않는다. Vercel의 현재 main 자동 production 배포를 고려해 Dev 검사·독립 리뷰 통과 전에는 main PR을 병합하지 않는다. 최초 환경 분리 변경도 Dev 후보에서 확인한 뒤 승격한다.

## 비용과 승인 범위

10월 9일 Aside에서 지정 Supabase 계정 로그인 일치, 현재 조직 Free, 새 Free 프로젝트 생성 가능 표시를 확인했다. native Vercel linked team은 Hobby다. **1차는 Free Dev Supabase + 기존 팀의 별도 Vercel 프로젝트로 신규 고정 구독 요금 $0을 목표로 한다.** Apify·Vertex·실제 카드 결제는 0회이고 추가 GCP worker·queue는 만들지 않는다.

무료 quota와 프로젝트 eligibility는 생성 직전에 재확인한다. 유료 프로젝트/조직 전환, 유료 Vercel 기능, 새 유료 seat·도메인 구매는 승인 범위에 없다. 무료 생성이 불가능하거나 유료 전환이 필요하면 생성/전환을 중단하고 정확한 월 비용과 이유를 제시해 별도 승인받는다. 무료 quota 안에서 소규모 UI 검증을 수행하며 전체 운영/Dev 사용량을 무제한 무료라고 주장하지 않는다. Free Supabase의 휴면 pause는 환경 가용성 제약이다.

가격 근거: [Supabase 가격/Free 한도](https://supabase.com/pricing), [Vercel 가격](https://vercel.com/pricing). 계정의 실제 청구액이나 새 유료 구독 승인을 뜻하지 않는다.

## 수용 기준

- Dev 계정/조직·프로젝트 identity와 production의 분리를 확인하고, schema 계약·권한·Realtime 의존성 parity를 검증한다. 운영 업무 데이터·비밀값 복사와 production 연결 변경은 0건이다.
- Dev 카카오 로그인·로그아웃·deep link가 Dev 도메인에 머물고, production 로그인·관리자 경계 기존 검사가 통과한다.
- preflight에서는 분석이 시작되지 않는다. checkout 취소·실패는 분석을 만들지 않고, 모의 결제 완료 후 자동 진행·완료/부분/실패·결과 재방문이 동작한다. 미결제 TTL 직전/직후, 완료 확정 직후 중단·재시도, 실행 시작 30분 이상 지연과 중복 완료를 검증한다. 완료된 주문당 연결된 실행이 정확히 하나 유지되며 중복 제출·중복 완료가 주문/실행 효과를 중복 생성하지 않는다.
- 모바일/데스크톱의 로그인·플랜·checkout·진행·결과·보관함과 관리자 기존 주문/모의 감사 화면을 Aside CLI로 확인한다. 빈 결과·조회 실패·권한 부족 화면도 확인한다.
- Dev 검사에서 Apify·Vertex·RapidAPI·Instagram·운영 메일/Discord/Amplitude·R2·운영 worker 호출은 0회다. production에서 더미 모드/결제 완료를 활성화하려는 검사도 실패한다.
- raw row·사용자 UUID·credential 없이 안전한 검사 결과와 후보 provenance만 남긴다. 새 코드/설정은 PR·관련 검사·구현자와 다른 agent 리뷰를 거치고, 승인한 검증 후보만 main에 병합한 뒤 main/origin/main을 동기화한다.

## 구현 전 남은 확인과 재개 조건

설계 승인 후 schema 초기화 자료의 실제 parity·민감값 검토, Supabase 새 프로젝트의 무료 생성 가능 여부, Dev 카카오 provider 설정 권한, `dev` subdomain DNS 추가 권한을 확인한다. 부재한 자료나 권한을 production credentials 자동 복사로 우회하지 않는다. Groble 공식 sandbox가 확인되지 않으면 승인된 모의 결제 기본안으로 진행한다.

전체 V2 worker 환경, 실제 계정 수집/분석 성공, 실제 카드/결제사 운영 검증, Vertex 실제 품질·절감 승격은 이 1차 환경의 완료 조건이 아니다. 각각 별도 증거와 필요 시 별도 예산을 요구한다.
