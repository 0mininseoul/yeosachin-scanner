# 유료 분석 E2E 복구와 결과 관측 설계

- 상태: 2026-08-10 사용자 승인
- 기준일: 2026-08-10
- 범위: Apify Basic/Standard fresh E2E, 결제 전 demo preview, 결과 이미지, 공유 관측, 결과 Session Replay
- 비범위: 자동 완료 이메일, selfhosted_auth production 전환, 맞팔 알리미 구현, 랜딩 고정 카피 변경

## 1. 검증 범위

이 E2E는 **서명된 유료 admission 이후 분석 이행 경로**를 검증한다. 실제 Groble 결제 생성부터 시작하는 결제사 E2E는 아니다.

- Groble 결제 경계: 첫 외부 결제 원장과 webhook/reconciliation 계약 테스트로 검증
- 이번 fresh E2E: 새 preflight → test entitlement → Apify/AI → completed result → owner/admin 조회
- 익명 public UX: 별도 browser test로 대상 입력 → ready preflight → demo preview → 플랜 → 결제 직전 로그인까지 검증

실제 내부 Groble 주문을 추가로 만들거나 환불하는 테스트는 하지 않는다.

## 2. 목표

1. Basic과 Standard를 각각 fresh collection부터 completed 결과까지 한 번 완주한다.
2. 첫 결제 복구에서 고친 snapshot·게시물 canonicalization·coverage 불변식을 신규 run으로 재검증한다.
3. target과 표시 후보 이미지를 provider CDN이 아닌 내부 R2 경로로 보존한다.
4. owner와 관리자 계정이 같은 immutable result revision을 읽게 한다.
5. 공유 시도·복사·OS handoff·확인된 Kakao 전송을 의미에 맞게 Amplitude와 Axiom에 남긴다.
6. Replay에서 결과 카드와 이미지는 보이되 인증·결제·자유 입력은 계속 가린다.
7. ready preflight와 플랜 사이에 완전히 합성된 demo preview를 제공한다.

## 3. 소스와 Orca worktree

기준 시점의 source는 다음과 같다.

- canonical main: `.worktrees/final-main-20260725`, `origin/main@7f899b7c`
- 첫 결제 복구: `codex/first-payment-recovery-20260808@979e5a67`
- `origin/main`은 현재 복구 commit의 ancestor다.

사용자 승인 뒤 구현 시작 시 이 값들을 신뢰하지 않고 다시 확인한다.

1. canonical main worktree에서 `git fetch origin` 후 `git pull --ff-only origin main`을 먼저 실행한다.
2. 복구 branch와 새 `origin/main`의 ancestry와 diff를 확인한다. diverged면 임의 rebase하지 않고 통합 기준을 다시 보고한다.
3. Orca CLI로 복구 commit을 보존하는 `codex/account-ledger-20260810` worktree를 만든다. 첫 작업은 [계정 원장 설계](./2026-08-10-account-ledger-paid-status-design.md)다.
4. account-ledger가 검증·commit된 뒤 그 commit을 부모로 Orca CLI에서 `codex/revenue-e2e-20260810` worktree를 만든다.
5. 성별 routing, result image, demo, share, Replay는 두 번째 worktree 소유다. account migration 번호와 merge 순서는 항상 먼저다.
6. 수동 `/tmp` worktree, prunable worktree와 기존 사용자 소유 worktree를 재사용·정리하지 않는다.

각 worktree의 변경 파일과 책임을 분리하며, 현재 전략 worktree에는 구현 코드나 migration을 섞지 않는다.

## 4. 첫 결제에서 확정된 불변식

첫 결제는 결제·seller reference·webhook까지 정상이었고 selfhosted fresh admission에서 막혔다. 결과는 결제 건에 보존된 Apify dataset을 concierge로 재생해 완료했다.

복구 코드와 migration에는 다음이 반영돼 있다.

1. 가장 큰 다른 시점 snapshot이 아니라 결제 lineage에 귀속된 정확한 관계 snapshot 선택
2. 최근 게시물을 최신순 최대 8개로 canonicalize
3. plan 상한 밖만 `not_screened`; profile fetch 실패는 screened의 `fetch_unavailable`

이 세 항목은 retained dataset replay에서 검증됐을 뿐 fresh 자동 E2E 성공 증거가 아니다.

## 5. E2E identity와 기존 test capability

| 플랜 | 전용 Auth identity | 대상 | 상세 상한 |
|---|---|---|---:|
| Basic | Basic E2E runner | `winglss1` | 100 |
| Standard | Standard E2E runner | `0_min._.00` | 200 |

두 identity는 `e2e_test / active`이며 자격 증명은 macOS Keychain에만 둔다. 관리자·외부 가입자·기존 내부 tester를 runner로 재사용하지 않는다.

새 결제 우회 방식을 만들지 않고 현재 `analysis-test-admission-v1`과 `analysis-test-entitlement-v1`을 사용한다.

- admission token: user, target, idempotency key, expiry, nonce에 HMAC 바인딩
- entitlement token: preflight, user, plan, expiry, nonce에 HMAC 바인딩
- 기본 TTL 10분, 최대 15분, clock skew 30초
- admission/entitlement HMAC domain 분리
- entitlement JTI SHA-256 hash의 DB one-time consumption
- issuer CLI의 exact `--confirm-paid-api-call` 요구
- DB consume 함수는 `SECURITY DEFINER`, 빈 search path, service-role only

추가할 guard는 다음 두 개다.

1. production에서 두 route 모두 `e2e_test / active` principal만 test capability를 사용할 수 있다.
2. Basic/Standard runner role과 token plan이 일치해야 한다.

test entitlement secret과 R2 object HMAC secret은 별도 키다. 이 작업 중 키를 rotate하지 않는다. token 원문·nonce·JTI·계정 식별자는 로그나 문서에 남기지 않는다.

## 6. fresh의 정확한 의미

한 E2E run은 다음을 모두 만족해야 fresh다.

- 새 authenticated preflight와 새 analysis request
- preflight 시작 이후 생성된 provider run/dataset
- 과거 relationship/profile checkpoint, provider dataset, result manifest, profile cache를 채택하지 않음
- request-local URL/image 중복 제거만 허용
- request의 `access_mode = test_entitlement`와 runner/plan/target lineage가 처음부터 끝까지 동일

retained dataset replay, recovery adoption, 과거 completed request 복사는 E2E 증거가 아니다. provider provenance가 위 조건을 증명하지 못하면 시작 비용과 무관하게 실패다.

실계정 대상은 실행 직전 다음을 만족해야 한다.

- 공개 계정
- 지정 plan의 followers/following capacity 안
- public mutual이 1명 이상
- username이 여전히 지정 identity를 가리킴

하나라도 아니면 다른 계정으로 임의 대체하지 않고 사용자에게 새 대상 승인을 받는다.

## 7. revision canary 방식

현재 Cloud Run 배포 계약은 process-local Gemini concurrency 때문에 traffic tag를 금지한다. 따라서 no-traffic revision에 E2E task를 직접 보내는 별도 URL을 만들지 않는다.

1. schema와 reader는 additive·backward-compatible하게 배포한다.
2. worker revision을 `--no-traffic`으로 stage해 source SHA, secret ref, readiness를 검증한다.
3. 새 기능 selector를 `test_entitlement`에만 열고 production request는 기존 policy를 쓰게 한 채 reviewed worker를 100% promote한다.
4. Scheduler와 Cloud Tasks가 promote된 단일 active revision의 canonical URL/audience를 가리키는지 확인한다.
5. Basic/Standard E2E 뒤에만 신규 production request selector를 연다.

즉 revision은 production과 같지만 기능 cohort는 `access_mode`로 격리한다. 일반 request가 새 routing/result contract를 선택하면 gate 실패다.

Vercel UI 변경은 preview deployment에서 먼저 검증하고, server endpoint와 old UI가 양방향 호환되는 상태에서 production에 배포한다.

## 8. 실행 전 gate

다음이 모두 true일 때만 유료 provider 호출을 시작한다.

- profile, profilesBatch, followers, following, likers, comments selector가 `apify`
- `SELFHOSTED_AUTH_ENABLED=false`
- active Vercel/worker source SHA가 reviewed commit과 일치
- Cloud Run 단일 revision이 traffic tag 없이 100% serving
- Scheduler/Tasks URL·audience가 그 service와 일치
- 처리 중 외부 paid request, claimed/running job, active provider run, cleanup backlog가 모두 0
- Apify balance와 Actor quota가 두 run의 보수적 예약액 110% 이상
- [성별 routing 설계](./2026-08-10-gender-routing-cost-control-design.md)의 제한 판매 hard safety cap인 Basic 1,808원 / Standard 3,634원을 ledger가 예약 가능
- R2 bucket, result-image access key, object HMAC과 image endpoint 설정이 완전
- Sentry/Axiom baseline에서 이번 request와 혼동될 unresolved issue가 없음

비밀값과 사용자·target 식별자를 출력하지 않는다. aggregate pass/fail만 남긴다.

## 9. Core E2E 실행

signed test admission은 현재 authenticated user에 묶이므로 core E2E는 runner 로그인 상태에서 시작한다.

1. runner로 로그인
2. target-bound signed admission으로 새 test preflight 생성
3. ready/exclusion/plan eligibility 확인
4. plan-bound entitlement를 한 번 소비
5. request·durable jobs 생성
6. fresh Apify 관계·프로필·상호작용 수집
7. 1차 gender routing과 상세 상한
8. 2차 AI·interaction·risk·narrative
9. result image capture와 finalizer
10. runner 보관함과 owner result 조회
11. 관리자 계정으로 같은 request 조회
12. provider/AI 비용, retry, coverage, queue/lease/artifact 정산

Basic이 §10을 통과하고 cleanup이 끝난 뒤 Standard를 실행한다. 실패한 request를 재사용하지 않고, 비용 reconciliation이 terminal이 된 뒤 새 preflight/request로 재시도한다.

## 10. Core E2E pass/fail

한 플랜은 다음을 모두 만족해야 성공이다.

### lineage·coverage

- preflight, entitlement consumption, request, jobs, result가 같은 runner/plan/target
- provider run이 모두 terminal이고 actual/conservative cost가 정산
- fresh provider provenance가 §6과 일치
- 관계 snapshot이 request lineage와 일치
- profile checkpoint posts가 최신순 최대 8개
- `screened + not_screened = public_mutuals`
- `fetch/media/analysis_unavailable`는 screened의 unknown 원인이고 `not_screened`와 겹치지 않음
- 80/20 bucket·fill provenance와 상세/interaction cap이 정확

### 품질·비용

- 최종 unknown ratio 30% 이하
- blind audit와 not-screened holdout 기준 통과
- 전체 변동원가가 hard safety cap 이하이고 margin target 초과 여부가 명시됨
- `manual_review`나 `manual_partial`에 도달하지 않음

### 결과·운영

- request와 result 상태가 `completed`
- owner/admin의 `result_revision_id`, content hash, candidate 순서, image manifest ID가 동일
- queue, lease, provider run, temporary artifact가 terminal
- request 시작부터 cleanup 후 10분까지 같은 correlation의 Sentry error/fatal과 Axiom failure가 0

`manual_review`는 안전한 실패 처리는 맞지만 E2E 성공이 아니다. 원인을 고친 뒤 새 request를 실행한다.

## 11. 결과 이미지 저장 계약

provider CDN URL과 expiring R2 URL을 immutable result DTO에 저장하지 않는다.

1. finalizer가 deterministic object key로 target, final female, private-row 표시 이미지를 `staging` 상태로 R2에 쓴다.
2. upload와 HEAD 검증이 끝난 객체만 DB manifest에 등록한다.
3. 한 DB transaction에서 manifest를 `committed`로 바꾸고 result revision을 완료한다.
4. DB commit 실패 시 object는 orphan cleanup queue로 보내며 completed 결과를 만들지 않는다.
5. result DTO에는 안정된 same-origin opaque path만 포함한다. endpoint가 owner/admin/share context를 검사한 뒤 R2를 읽는다.

object store와 PostgreSQL을 하나의 원자 transaction이라고 표현하지 않는다. `staging → verified → committed` 상태와 deterministic key/idempotency로 crash를 복구한다.

이미지 gate:

- source image가 있었던 target은 반드시 capture 성공
- source image가 있었던 표시 candidate의 90% 이상 capture 성공
- 원래 source가 없던 row는 명시적 placeholder이며 실패 count에 넣지 않음
- 기준 미달, manifest 불일치, 전부 실패는 `manual_review`

owner/admin 결과 equality는 stable DTO와 result revision을 비교한다. viewer별 권한 검사나 응답 시각은 content hash에 포함하지 않는다.

## 12. 결제 전 demo preview

Core Basic/Standard가 모두 통과한 뒤 구현한다. 새 demo용 데이터를 만들지 않고 현재 published synthetic fixture의 `DEMO_FIXTURE_VERSION`, `loadPublishedDemoFixture()`와 local `/demo-avatars/*` 자산을 재사용한다.

### 12.1 프론트 계획 전 레퍼런스 관찰 gate

이 관찰은 현재 전략 worktree가 아니라 `revenue-e2e` Orca worktree에서 프론트 구현 계획을 작성하기 직전에 수행한다.

1. `browse`를 사용해 `https://vir-tually.love`의 첫 방문 화면부터 결제 직전 카카오 로그인까지 직접 진행한다.
2. Instagram 입력값은 `0_min._.00`을 사용하고, 중간 문항은 전체 흐름을 계속 볼 수 있는 답을 선택한다.
3. 빠른 화면 전환은 짧은 프레임 간격의 screenshot과 DOM snapshot으로 나눠 intro, 질문 전환, 진행 표시, suspense/loading, 결과 예고, CTA와 로그인 handoff를 기록한다.
4. 카카오 로그인이 필요하면 browser handoff로 사용자에게 넘기고 자격증명·세션 값은 캡처하거나 문서화하지 않는다.
5. 관찰 결과는 같은 worktree의 프론트 구현 계획에 `재사용할 패턴 / 이 제품에 맞게 바꿀 점 / 복제하지 않을 카피·브랜드·asset`으로 구분해 반영한다.
6. 모바일 우선 흐름과 reduced-motion·키보드·뒤로가기·새로고침 상태 복원까지 구현 acceptance criteria로 변환한다.

레퍼런스 관찰은 방향을 구체화하기 위한 선행 작업이며, 기존 디자인 시스템과 `app/page.tsx`의 확정 마케팅 카피를 대체하거나 외부 서비스의 카피·asset을 복제하는 근거가 아니다.

- 위치: ready preflight target card와 plan cards 사이
- 표시: `예시 결과` label, 상위 1~3명, risk hierarchy와 결과 구조
- 실제 target 이름·사진·count는 demo candidate에 섞지 않음
- 기존 result card와 design token을 재사용
- fixture payload에서 preview DTO를 만드는 pure projection을 둠
- fixture load 실패 시 preview만 숨기고 plan selection은 fail-open
- 펼치기 전후 scroll position을 보존
- 로그인은 기존처럼 결제 클릭 시점
- `demo_result_viewed`, `demo_result_expanded`, 이후 `plan_selected`를 같은 anonymous preflight lineage에 기록
- `app/page.tsx`의 확정 마케팅 카피는 수정하지 않음

순환을 피하기 위해 검증을 두 단계로 나눈다.

1. Core E2E 두 건은 demo 구현 전 실행한다.
2. demo 구현 후 anonymous browser flow는 새 ready preflight에서 로그인 화면 직전까지만 검증한다. entitlement를 소비하거나 두 분석을 다시 실행할 필요는 없다.

## 13. 공유 관측의 의미

버튼 클릭이나 URL 준비를 실제 공유 성공으로 세지 않는다. 채널별 확인 가능성이 다르므로 이벤트 이름을 분리한다.

| 사건 | Amplitude/Axiom 이벤트 | 의미 |
|---|---|---|
| 공유 UI 또는 Kakao SDK 호출 | `result_share_initiated` | 사용자가 공유 절차를 시작 |
| `clipboard.writeText` resolve | `result_share_copy_succeeded` | 링크 복사 성공; 상대 전달은 미확인 |
| `navigator.share` resolve | `result_share_handoff_completed` | OS share handoff 완료; 실제 전송은 플랫폼별로 미확인 |
| Kakao Share webhook 수신 | `result_shared_confirmed` | 선택한 채팅방으로 Kakao 메시지 전송 확인 |
| share token으로 외부 page open | `shared_result_opened` | 수신 또는 링크 재방문 결과 |

MDN에 따르면 `navigator.share()` resolve 시점은 플랫폼별로 다르므로 이를 recipient 전송 성공으로 부르지 않는다. Kakao JavaScript SDK도 서비스가 전송 성공을 직접 확인할 수 없고 Kakao Talk Share webhook을 사용하라고 명시한다.

### 13.1 client observation endpoint

initiated/copy/handoff 뒤 same-origin POST를 보낸다.

- Supabase session과 request owner/admin 권한 확인
- body allowlist: `request_id`, enum channel, enum outcome, random client nonce
- user ID, traffic class, share URL/token, Instagram 식별자와 결과 payload는 받지 않음
- 서버가 account 원장에서 `traffic_class` snapshot
- Origin/Sec-Fetch-Site 검사, nonce unique key와 10분 TTL로 멱등
- Axiom 실패는 사용자 공유 UX에 영향 없는 best-effort

취소·거절은 aggregate `result_share_cancelled` 또는 `result_share_failed`로 기록할 수 있지만 `result_shared_confirmed`로 올리지 않는다.

### 13.2 Kakao confirmation webhook

Kakao share 요청 시 `serverCallbackArgs`에는 DB에 저장된 opaque `share_attempt_id`만 넣는다. webhook은:

- Kakao가 보내는 admin-key Authorization을 timing-safe 검증
- `X-Kakao-Resource-ID`를 idempotency key로 저장
- 미리 만든 share attempt와 exact request/channel을 연결
- 확인되면 `result_shared_confirmed`를 Amplitude server event와 Axiom에 한 번 기록
- chat type/hash, admin key, callback 원문을 일반 로그에 남기지 않음

Kakao webhook 설정 전에는 Kakao를 `result_share_initiated`로만 기록한다.

Axiom 공통 allowlist는 `event`, `request_id`, `share_channel`, `share_outcome`, `traffic_class`, environment/route/status/correlation뿐이다.

근거:

- [MDN Web Share API](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share)
- [Kakao Talk Share JavaScript](https://developers.kakao.com/docs/en/kakaotalk-share/js-link)
- [Kakao Talk Share webhook](https://developers.kakao.com/docs/en/kakaotalk-share/callback)

## 14. Session Replay privacy allowlist

현재 큰 결과 카드의 `data-amp-block`을 컴포넌트 단위 allowlist로 좁힌다.

관측 허용:

- owner/share result의 target summary, 순위 카드, private row
- result profile image와 일반 설명·score·layout
- profile preview dialog의 결과 내용
- demo preview

계속 block/mask:

- 로그인·회원정보·결제 입력
- 이메일·전화번호·인증정보
- target 입력 field와 자유 입력
- query string, share token, cookie, raw 오류 원문
- 운영자 진단 필드

새 result child component는 기본 masked이며 allowlist test를 추가해야만 노출한다. 전역 capture level은 `light`로 유지하고 page-wide unmask selector는 만들지 않는다. production replay 한 건에서 allowlist 필드는 보이고 denylist 값은 DOM·network replay 양쪽에 없는지 확인한다.

## 15. 테스트 순서

### 자동

- test admission/entitlement의 E2E active·runner-plan guard와 replay 거절
- fresh provenance와 retained cache/adoption 거절
- snapshot/posts/coverage/routing/cost 불변식
- result-image staging/HEAD/commit/crash/orphan cleanup, provider URL 비노출
- owner/admin stable result equality와 share 권한
- 공유 사건별 Amplitude/Axiom event matrix, 취소·실패, nonce 멱등, Axiom fail-open
- Kakao webhook Authorization·resource id·attempt binding·중복·민감 필드 부재
- Replay allowlist/denylist DOM contract
- demo fixture projection·격리·`예시 결과`·fail-open·anonymous lineage

### 브라우저

- Basic/Standard runner의 completed 보관함과 result
- 관리자 계정의 같은 고객 result URL
- 새 탭·새 세션 result images
- clipboard 성공/거절, Web Share 지원/미지원/취소, Kakao dialog와 webhook canary
- anonymous target → ready → demo → plan → 로그인 직전
- Amplitude Replay 결과 가시성과 민감 입력 마스킹

## 16. 배포와 판매 gate

1. account-ledger migration/code를 먼저 배포·검증한다.
2. routing/image schema와 backward-compatible worker를 `test_entitlement` cohort로 배포한다.
3. Basic, cleanup, Standard, cleanup 순서로 Core E2E를 통과한다.
4. demo/share/Replay UI를 preview에서 검증한 뒤 production에 배포한다.
5. production 신규 request selector를 연다.
6. 다음 자연 발생 외부 결제 한 건을 request-scoped canary로 감시한다. 자연 주문이 없으면 인위적 Groble 주문을 만들지 않고 “payment-to-result fresh E2E”를 완료했다고 선언하지 않는다.

판매 중단과 재개 수량 기준은 [8월 운영 전략 §5.1](../../strategy/2026-08-08-revenue-first-operating-strategy.md#51-판매와-중단-기준)을 단일 정본으로 사용한다. 이 설계가 더 엄격하게 적용하는 기술 gate는 다음 두 가지뿐이다.

- E2E가 비용·품질·lineage gate 중 하나라도 실패하면 새 production selector를 열지 않는다.
- production selector 문제로 재고를 닫은 경우 수정 뒤 같은 plan의 새 signed E2E 한 건이 completed와 모든 gate를 통과해야 기술적으로 재개할 수 있다. 실제 재고 재개는 운영 전략의 backlog·SLA 조건도 함께 만족해야 한다.

## 17. rollback과 진행 중 요청

- 새 request의 routing selector만 끌 수 있으며 시작된 request는 저장된 policy로 끝낸다.
- 새 policy를 이해하지 못하는 worker로 rollback하지 않는다. backward-compatible reader revision까지만 허용한다.
- result image capture를 끈 상태에서 provider URL로 completed를 만들지 않는다. 해당 paid request는 manual review다.
- share endpoint, Kakao webhook, Replay allowlist, demo preview는 각각 독립 flag로 끌 수 있다.
- additive schema와 이미 committed된 result/R2 object/payment/provider-cost 원장은 삭제·재작성하지 않는다.
- selfhosted_auth나 더 비싼 과거 policy로 자동 fallback하지 않는다.
