# 2026-10-03 W03 사용자·관리자 경로와 W07 용량 검증

기준일: 2026-10-03, Asia/Seoul. 현재 Codex continuation checkout의 소스와 상위 세션이 전달한 당일 native 읽기 전용 관측을 구분해 기록한다. 이 문서 담당자는 코드·테스트를 추가하거나 수정하지 않았고, 실제 분석·결제·provider 작업과 관리자 로그인도 실행하지 않았다.

## 판정

| 작업 | 판정 | 재개에 필요한 근거 |
| --- | --- | --- |
| W03 | **현재 경로·비인증 경계 검증 완료, 실제 사용자·운영자 성공 근거 대기** | 사용자가 실제 계정 분석을 완료한 결과와 allowlisted 운영자가 직접 로그인해 현행 데이터를 조회한 결과 |
| W07 | **현재 추가 확장 불필요, initial 32/8 유지·변경 없음** | 보존 행 기준 신규 수요 0. 오래된 pending 3건은 모두 failed parent에 연결돼 활성 실행 대기와 구분. 실제 사용자 실행·초기 실사용 측정 후 재평가 |

사용자는 **9월 16일 이후 실제 계정 분석과 관리자 확인을 아직 실행하지 않았다**고 상위 세션에 답했다. 따라서 “사용자가 이미 성공시켰을 것”이라는 가정은 하지 않는다. 실제 operator 인증 성공을 관측한 근거도 없다.

## W03: 현재 경로의 의미

### 익명 `/analyze` 200은 정상 동작

`proxy.ts:104` 부근은 `/analyze`에서 익명 사용자의 profile-only preflight와 제한된 플랜·가격 snapshot 열람을 허용한다고 명시한다. 실제 보호 경로 배열은 `/progress`, `/result`, `/earlybird`다. `/api`는 proxy를 통과해 각 API의 인증·소유권 경계를 적용한다.

따라서 2026-10-03 상위 세션이 native HTTP로 확인한 `GET /analyze → 200`은 인증 우회 오류가 아니다. 페이지 200은 preflight POST, 결제, provider 실행 또는 결과 조회 성공을 증명하지 않는다.

실제 UI 실행 경로는 다음과 같다.

1. `app/analyze/page.tsx`가 입력·사전 점검 화면을 제공한다.
2. `hooks/useAnalysisV2Preflight.ts`의 `startPreflight()`가 검증한 입력을 `POST /api/analysis/preflight`로 제출한다. 페이지 GET과 별도이며 제출부터 실제 수집 작업이 발생할 수 있다.
3. 준비된 snapshot과 선택한 플랜으로 checkout을 시도할 때 비로그인 사용자는 로그인 화면을 거친다. 이후 checkout 및 분석 admission은 서버의 소유권·idempotency 경계를 따른다.
4. 진행과 결과는 `/progress/[requestId]`, `/result/[requestId]`의 owner 경로에서 확인한다. 문서에는 실제 request/user 식별자를 기록하지 않는다.

현행 실행 진입점은 preflight → admission → V2 tasks/worker다. 기존 `/api/analysis/run` 또는 `/step`을 기본 수동 테스트 진입점으로 사용하지 않는다.

### 관리자 경계

상위 세션이 2026-10-03 native GET으로 관측한 결과:

| 경로 | 비인증 응답 | 확인한 범위 |
| --- | --- | --- |
| `/admin/analysis-audit` | 307, `/login`으로 이동 | 비인증 page 차단 |
| `/api/admin/analysis-audit` | 401, `Cache-Control: private, no-store` | 비인증 API 차단 및 비공개 cache 정책 |
| `/api/admin/order-audit` | 401, `Cache-Control: private, no-store` | 비인증 API 차단 및 비공개 cache 정책 |
| `/api/admin/landing-leads` | 401, `Cache-Control: private, no-store` | 비인증 API 차단 및 비공개 cache 정책 |

이 표는 상위 세션 관측을 인계받은 것으로, 담당자가 중복 요청하지 않았다. 인증 쿠키나 응답의 원시 행은 전달받거나 저장하지 않았다.

로컬 코드도 관측과 일치한다. `app/admin/analysis-audit/page.tsx`는 server `getUser()` 실패/부재를 `/login`으로 보내고, allowlist에 없는 인증 사용자는 `/`로 보낸다. 각 admin API는 인증 뒤 operator decision을 확인하며 비허용은 403, 인증/권한 판정 서비스의 불확실성은 503으로 닫는다. 데이터 loader는 이 판정 뒤에 호출되고, 모든 JSON 분기는 `private, no-store`를 사용한다.

**미검증:** allowlisted 운영자가 실제 로그인해서 콘솔을 열고, 현재 주문·분석·landing lead 데이터를 정상 조회하는지. 비인증 401은 이 성공 경계를 증명하지 않는다. 기존 콘솔을 재구축할 근거도 없다.

### 당일 웹 readiness 근거

상위 세션의 [W02 웹 receipt](./2026-10-03-w02-web.safe.json)를 확인했다.

- 03:38 KST: Vercel native deployment는 `READY`, `production`, source SHA `55483734b03f30e44d670892a4835d41fdb7e92b`; project/name 일치.
- root main Supabase 연결은 production URL과 일치하며 URL 읽기 성공·유일성을 확인했다. URL 값은 receipt에 없다.
- 03:39 KST: 공개 readiness HTTP 200, `ready=true`, 같은 source SHA. 분석 admission과 earlybird webhook auto-admission은 모두 활성, preflight/paid producer config ready다.

이 관측은 실제 요청의 end-to-end 성공 또는 관리자 인증 성공을 대신하지 않는다. 과거 9월 16일 receipt를 10월 3일 관측으로 옮겨 적지 않았다.

## 사용자가 직접 확인할 경로와 관측사항

### 실제 계정 분석 1회

1. [분석 입력 화면](https://yeosachin.com/analyze)을 열고 사용자가 확인할 실제 대상 계정을 직접 입력한다. 시작 시각과 화면 단계만 기록한다.
2. 사전 점검 결과에 대상·플랜·가격·상태가 일관되게 표시되는지 확인한다. 오류가 나면 같은 분석을 연속 생성하지 않고 해당 단계의 오류 문구·시각을 남긴다.
3. 로그인·플랜 선택·checkout을 사용자가 진행한다. 실제 결제·분석 실행 여부도 사용자가 결정한다. 로그인 전후 대상/선택이 유지되는지, 이미 진행 중인 주문이 중복 생성되지 않는지 확인한다.
4. 진행 화면에서 대기 → 실행 → 완료 또는 명확한 실패 상태로 전환하는지 확인하고, 결과 화면의 핵심 요약·계정 목록이 해당 대상과 일치하는지 확인한다. 결과 재방문과 보관함 이동도 확인한다.
5. 공유할 결과는 시작/완료 시각, 성공 여부, 실패 단계·오류 코드, 화면 상태로 한정한다. 계정·사용자 식별자, 쿠키, checkout token, 원시 결과 payload는 문서나 채팅에 붙이지 않는다. 구체적인 요청 추적이 필요하면 기존 보호된 운영 콘솔 안에서 수행한다.

현재 제출·checkout·provider 실행은 에이전트가 수행하지 않았다. synthetic 운영자 데모가 성공하더라도 실제 계정 성공으로 판정하지 않는다.

### 관리자 확인 1회

1. allowlisted 운영자 본인이 [관리자 콘솔](https://yeosachin.com/admin/analysis-audit)에 로그인한다.
2. 콘솔이 표시되고 현재 주문 목록·선택한 주문 상세·분석 감사·landing lead 조회가 정상인지 확인한다. 로딩·빈 결과·권한 오류·조회 실패를 구분한다.
3. 기존 내역을 읽는 것으로 시작한다. provider 잔액 새로고침, 계정 상태 토글 등 원격 변경 또는 provider 요청을 만들 수 있는 동작은 이번 단순 조회 성공의 필수 조건이 아니다.
4. 성공 여부, 관측 시각, 실패한 화면/조회 종류와 오류 코드만 보고한다. 실제 raw row와 사용자 ID를 공유하지 않는다.

### 실패 시 재개 조건

| 관측 | 필요한 후속 확인 |
| --- | --- |
| page가 열리지 않음 또는 readiness 불일치 | 당일 source SHA·deployment·readiness를 다시 비교 |
| preflight 실패 | 해당 시각의 안전한 오류 분류, queue/recovery 및 provider admission 상태 |
| checkout 이후 장기 대기·실패 | 결제·주문·admission 상태의 독립 증거를 보호된 운영 경로에서 확인. 추정으로 `payment_pending` 변경 금지 |
| 결과 누락·불일치 | 해당 분석의 완료·checkpoint·result projection 증거를 제한된 범위로 확인 |
| allowlisted 관리자에 401/403/503 | 로그인 세션, allowlist 판정, 인증 서비스 오류를 구분. 비밀값/사용자 ID 출력 없이 검사 |

문제가 확인될 때만 해당 caller와 기존 검사 범위의 최소 수정을 진행한다. 사용자가 아직 실행하지 않은 상태는 기능 고장 증거가 아니다.

## W07: 구현된 용량과 실제 수요의 구분

`scripts/capacity-extension-load-harness.ts`의 기본 합성 workload는 **preflight 400건 + paid 200건**이다. 실제 Cloud Tasks payload builder와 admission/lease wrapper를 사용하지만 transport·DB·Apify·Gemini는 로컬 deterministic fake다. 실행은 명시적 `fakeProviderMode: 'load'`로 제한된다.

| 경계 | initial | expanded | 소스 |
| --- | ---: | ---: | --- |
| preflight worker 최대 instance | 32 | 64 | `scripts/deploy-analysis-capacity-workers.sh` |
| paid worker 최대 instance | 8 | 16 | 같은 deploy script |
| preflight queue dispatch/s 및 concurrent dispatch | 32 / 32 | 64 / 64 | `scripts/configure-analysis-capacity-queues.sh` |
| paid queue dispatch/s 및 concurrent dispatch | 8 / 8 | 16 / 16 | 같은 queue script |
| provider 동시성 검증 상한: preflight / paid / Gemini | 32 / 8 / 8 | 32 / 8 / 8 | deterministic harness 계약 |
| relationship provider/budget active 상한 | 4 | 4 | deterministic harness 계약 |

배포 script의 instance concurrency는 1이다. expanded 선택에는 `ANALYSIS_CAPACITY_EXPANSION_CANARY=true`를 요구하고, deploy/queue script는 legacy producer freeze·old task drain·target block 등 단계 전제를 검사한다. 이번에는 script의 apply/check를 실행하거나 queue·worker·canary flag를 바꾸지 않았다.

합성 harness의 성공 계약은 600건 accepted/terminalized, lost 0, 중복 terminal effect 0, 각 역할의 capacity pending 관측, lease recovery/fence rotation, queue eventual drain이다. DB contention 근거도 명시적으로 `deterministic-serial-fake`다. 따라서 “현재 실서비스에서 실제 provider 600건을 처리했고 DB 동시성 성능까지 검증했다”는 주장은 할 수 없다.

기존 initial/expanded 구현이 있으므로 신규 확장 코드를 만들 이유는 확인되지 않았다. 단순 request 수 또는 오래된 합성 PASS를 근거로 provider 상한을 높이지 않는다. 아래 W02 runtime 관측과 후속 W05 안전한 집계를 연결해 수요·대기·실패와 비교해야 한다. 실제 확장 필요성은 지속되는 대기/지연, admission 거부·retry, provider limit 또는 DB/lease 병목이 현재 상한 때문에 발생한다는 근거와 함께 판단한다. 새로운 수치 기준을 임의로 만들지 않는다.

### 10월 3일 native runtime 관측

상위 세션이 제공한 [W02 runtime receipt](./2026-10-03-w02-runtime.safe.json)의 03:38 KST 관측은 양쪽 role의 stage가 `INITIAL`, expansion canary가 false임을 확인한다.

| 항목 | preflight | paid |
| --- | ---: | ---: |
| ready revision traffic | 100% | 100% |
| revision max instances | 32 | 8 |
| service max instances | 32 | 10 |
| container concurrency | 1 | 1 |
| queue 상태 | RUNNING | RUNNING |
| queue concurrent dispatch / dispatch per second | 32 / 32 | 8 / 8 |
| recovery scheduler | ENABLED | ENABLED |

paid의 service-level 10과 revision-level 8을 구분한다. 현재 queue 동시성도 8이므로 “paid 10건 또는 16건 동시 운영”으로 해석하지 않는다. legacy queue 2개는 PAUSED, retention scheduler는 ENABLED다.

두 worker source는 승인 `b44f718042dfd14909dd5a358f3a92fb44aec76e`, image digest도 승인값과 일치한다. regional build 후속 조회는 SUCCESS이나 이번에 source archive 바이트를 새로 검증하지는 않았다. 자세한 provenance/annotation 차이는 [W02 runtime 보고서](./2026-10-03-w02-runtime.ko.md)의 판단 범위를 따른다. queue receipt의 `nativeTaskCount`는 null이므로 이것으로 “현재 대기 0”을 주장하지 않는다.

오늘 구성은 initial과 일치하며 이미 expanded로 운영 중이라고 주장할 근거는 없다. 아래 수요 집계를 고려해 초기 설정을 유지하고, 수요·지연·병목 근거 없는 확장 변경은 만들지 않는다.

### 04:01~04:02 KST 보존 행 기준 수요 집계

상위 세션이 전달한 W05 담당자의 2026-10-03 04:01:03 KST 원격 읽기 전용 집계와 04:02:30 KST parent/dispatch 추가 집계다. [W05·W06 보고서](./2026-10-03-w05-w06-provenance.ko.md)의 최종 metadata 근거에 연결하며, 이 문서 담당자는 DB를 직접 조회하거나 원시 행을 읽지 않았다.

| 범위 | 관측 |
| --- | ---: |
| 2026-09-16 08:08 KST 이후 생성된 보존 `analysis_requests` | 0 |
| 같은 기간 생성된 보존 preflight | 0 |
| 같은 기간 생성된 보존 `pipeline_jobs` | 0 |
| 전체 보존 request 중 nonterminal | 0 |
| pending `pipeline_jobs` | 3, 가장 이른 생성일 2026-08-12; 모두 parent request `failed`, dispatch `pending` |
| 만료된 processing lease | 0 |

이는 **조회 시점에 존재하는 보존 행의 집계**다. retention으로 이미 제거된 내역, 저장되기 전 실패, 별도 event/log 범위까지 포함한 모든 과거 traffic의 부재를 증명하지 않는다. queue task count와도 같은 지표가 아니다.

pending 3건은 모두 parent `analysis_request.status='failed'`, `dispatch_state='pending'`이다. 가장 이른 생성 시각은 8월 12일 09:56 KST, 마지막 갱신 시각은 같은 날 11:44 KST다. 시간 조건만 보면 due 3건이지만 parent가 terminal이므로 활성 분석의 실행 대기 또는 최근 신규 수요로 합산하지 않는다. 자동 정리·재시도·삭제·상태 수정은 하지 않았다.

현재 관측에는 initial 32/8을 늘려야 한다는 수요 또는 상한 병목 근거가 없다. **현재 추가 확장 불필요, initial 32/8 유지·변경 없음**으로 판정한다. 이는 실제 provider 용량 성공의 증명이 아니며, 사용자의 실제 분석 1회 및 초기 실사용의 수요·지연·실패 측정 뒤 확장 필요성을 재평가한다.

## 기존 검사와 조사 범위

상위 세션은 2026-10-03 다음 기존 검사 **6파일·82검사 PASS**를 전달했다. 보고서 담당자는 같은 검사를 중복 실행하지 않았다.

| 기존 검사 | 수 |
| --- | ---: |
| `tests/analysis/preflight/entry-policy.test.ts` | 40 |
| `tests/analysis/results/presentation-policy.test.ts` | 18 |
| `tests/operations/console-model.test.ts` | 4 |
| `tests/operations/routes/api/admin/order-audit/route.test.ts` | 11 |
| `tests/operations/routes/admin/analysis-audit/operator-console-interaction.test.tsx` | 4 |
| `tests/infra/tools/capacity-extension-load-harness.test.ts` | 5 |

로컬 조사에는 `rg`, `sed`, Git status 및 위 source/receipt 읽기만 사용했다. protected route·checkout caller·admin 인증 분기·capacity script/harness 계약을 확인했다. 전체 테스트, 새 테스트 작성, 실제 load/provider 호출, 운영자 impersonation, DB 원시 조회, 인프라 변경은 수행하지 않았다.

관련 통합 근거: [후속 상태판](../operations/2026-10-03-continuation-status.ko.md), [W00·W04 근거](./2026-10-03-w00-w04-evidence.ko.md), [W05·W06 provenance](./2026-10-03-w05-w06-provenance.ko.md). W03의 실제 사용자·운영자 성공 결과는 근거 대기이며, W07은 현재 추가 확장이 불필요하다. 오래된 terminal-parent pending 행은 보존하고, 실제 사용자 실행·초기 실사용 측정 뒤 재평가한다.
