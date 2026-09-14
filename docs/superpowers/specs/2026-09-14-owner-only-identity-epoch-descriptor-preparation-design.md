# Owner-only identity epoch descriptor preparation design

Status: 승인 방향의 문서화, 구현 전 최종 검토 대상

Date: 2026-09-14

Extends:
`docs/superpowers/specs/2026-09-07-coordinated-capacity-identity-epoch-roll-forward-design.md`

## 1. 목적

기존 coordinated capacity identity epoch 구현은 안전하게 fail-closed 하지만,
완전한 packet과 live bootstrap descriptor를 운영자가 미리 작성해 inherited FD로
전달해야 한다. 현재 운영자는 이 보호 입력을 직접 구성하지 않으며, 저장소도 값을
발견하거나 추정하지 않도록 의도적으로 닫혀 있다. 그 결과 구현과 공개 readiness가
준비되어도 production `VERIFIED`까지 실행할 수 없다.

이 설계는 현재 로그인된 owner의 Vercel, Google Cloud, Supabase 제어면에서 필요한
값을 메모리 안에서만 관측하고, 승인된 결정 규칙으로 정확한 descriptor 두 개를
구성한 다음, 익명 inherited FD로 기존 실행기에 연결하는 최소 운영 경로를 추가한다.

완료 경계는 production `VERIFIED`와 독립 read-only verifier의 `VERIFIED_OK`이다.
활성화, gate 재개방, queue/scheduler 재개, 실제 사용자 작업, provider 작업,
`0_min._.00` 카나리는 수행하지 않는다.

## 2. 변경하지 않는 것

- 기존 packet schema, coordinator state machine, live adapters, verifier 의미를
  완화하지 않는다.
- 앱 runtime이나 관리자 대시보드에 descriptor 생성 기능을 넣지 않는다.
- dotenv 파일을 source하거나 production env를 파일로 pull하지 않는다.
- credential, token, service-account identity, project/resource 이름, URL, manifest,
  사용자 식별자를 argv, stdout/stderr, git, journal, 보고서, 일반 임시 파일에
  기록하지 않는다.
- 기존 계정을 삭제하지 않고 user-managed key를 만들거나 회전하지 않는다.
- 프로젝트 전체의 광범위한 IAM role을 추가하지 않는다.
- 결제, Supabase schema/data, Instagram scraper, provider budget, 랜딩 카피,
  CI/CD 동작을 변경하지 않는다.

## 3. 검토한 선택지

### A. owner-only 준비기와 inherited-FD 브리지 (채택)

로컬 owner 세션에서만 실행되는 단일 진입점을 둔다. 준비기는 authenticated
control plane을 직접 관측하고 고정 정책으로 proposal을 만든다. 승인된 proposal과
재관측 결과가 정확히 일치할 때만 필요한 준비 mutation과 기존 coordinator 실행을
허용한다. 보호 값은 부모 프로세스 메모리에만 있고 자식 실행기에는 익명 파이프로
전달한다.

장점은 수기 JSON 조립 오류와 값 유출 가능성을 줄이고, 동일한 절차를 재실행할 수
있으며, 기존 coordinator와 verifier를 그대로 권위 있는 실행 경계로 유지한다는
것이다. 비용은 제어면 discovery와 proposal 검증 코드가 추가된다는 점이다.

### B. 운영자가 descriptor JSON을 수기로 작성

코드 변경은 가장 작지만, 현재 운영자가 모든 보호 필드와 canonical digest를 직접
맞춰야 한다. 누락, 오래된 값, 잘못된 slot 매핑, 파일 또는 shell history 유출
가능성이 크므로 채택하지 않는다.

### C. 현재 fail-closed 상태 유지

production mutation 위험은 없지만 승인된 `VERIFIED` 목표를 달성하지 못한다.
관측이나 검증이 불완전할 때의 fallback으로만 유지한다.

## 4. 운영 진입점

새 진입점은 production 앱과 분리된 owner-only Node CLI 하나다. 개념적인 명령은
다음 네 단계이며 실제 명령 이름은 구현 계획에서 저장소 관례에 맞게 고정한다.

1. `prepare inspect`: read-only 관측으로 준비 proposal digest와 안전한 개수만 출력
2. `prepare apply --approved-digest`: 같은 proposal을 재관측하고 필요한 최소 준비
   mutation만 수행
3. `epoch inspect`: quiescence가 성숙한 상태에서 완전한 packet/bootstrap proposal을
   두 번 독립 관측하고 digest 일치를 증명
4. `epoch apply --approved-digest --through VERIFIED`: 같은 proposal을 다시 관측한 뒤
   기존 check, apply, verifier를 inherited FD로 실행

각 mutation 명령은 바로 앞 inspect 결과의 정확한 digest를 요구한다. digest는
보호 값을 역산할 수 없는 canonical SHA-256이며 argv에 허용되는 유일한 proposal
값이다. 관측이 달라지면 `PROPOSAL_STALE`로 중단한다.

준비기에는 activation, resume, gate-open, canary 하위 명령을 만들지 않는다.
`epoch apply`는 내부적으로도 `--through VERIFIED`를 고정하며 다른 상태를 입력받지
않는다.

## 5. 신뢰 경계와 입력 발견

### 5.1 로컬 owner 권한

준비기는 현재 OS user가 소유한 기존 Vercel CLI 인증 저장소, Google Cloud ADC/CLI
인증 저장소, linked Vercel project metadata를 읽기 전용으로 사용한다. 인증 토큰은
메모리에서만 provider API 요청에 사용한다. CLI child process가 필요한 경우
stdout/stderr는 부모의 private pipe로 캡처하고 그대로 전달하거나 출력하지 않는다.

Supabase zero-work ledger 조회에는 Vercel production env에서 메모리로 얻은 기존
service-role credential만 사용한다. Supabase CLI가 연결되어 있더라도 프로젝트나
credential의 대체 추론 경로로 사용하지 않는다. Vercel, GCP, Supabase scope가 packet
전체에서 하나의 정확한 운영 경계로 일치하지 않으면 중단한다.

### 5.2 허용된 discovery

discovery는 다음 고정 source만 사용한다.

- linked Vercel project의 production deployment, alias, production env와 공개
  readiness 응답
- Google Cloud Run service/revision, Cloud Build provenance, Cloud Tasks queue/task,
  Cloud Scheduler job, IAM policy, service account와 key metadata
- packet에 고정된 Supabase ledger 세 개와 Cloud Tasks TaskActivityLog
- 기존 GCS epoch journal과 lock namespace

이름 substring 검색이나 후보 중 첫 번째 선택은 inventory 진단에만 사용할 수 있고
descriptor 값 선택에는 사용할 수 없다. 실제 resource는 production config의 정확한
selector에서 출발해 양방향으로 일치해야 한다. 한 source가 빠지거나 둘 이상의
resource로 해석되면 fail-closed 한다.

### 5.3 출력 제한

정상 출력은 고정 code, proposal digest, source SHA, 역할별 재사용/생성/정지 개수,
검증 boolean만 허용한다. 오류는 allowlisted code 하나만 출력한다. child process의
원문 오류나 API body는 메모리 내 분류 후 폐기한다.

## 6. old manifest 구성

old manifest는 env에서 추정하지 않고 live resource를 관측해 구성한다.

- 각 role의 실제 serving Cloud Run revision, source SHA, image와 build provenance,
  runtime identity, env/secret reference/settings
- 각 producer의 production source SHA, config fingerprint와 두 public admission gate
- 두 queue의 완전한 configuration, target identity/audience/URL, PAUSED 상태와
  pagination이 끝난 empty task listing
- 두 recovery scheduler의 완전한 configuration, target identity/audience/URI,
  PAUSED 상태, 실제 pause 시각과 마지막 attempt
- retention scheduler의 enabled 상태와 configuration
- resource별 IAM policy, etag, exact bindings
- exact-v3 readiness 응답

모든 mutable observation은 proposal 생성과 실행 직전에 다시 읽는다. packet 생성
시각보다 오래된 snapshot이나 부분 pagination은 사용할 수 없다.

## 7. desired manifest 구성

desired manifest는 현재 서비스 동작을 유지하면서 identity 충돌만 해소하도록 만든다.

- source SHA는 승인된 exact Git/Vercel source와 일치해야 한다.
- 두 role의 digest-pinned image는 같은 source SHA와 정확한 Cloud Build provenance를
  가진 기존 artifact만 재사용한다. 그런 artifact가 없으면 준비기가 임의로 build를
  시작하지 않고 `SOURCE_INVALID`로 중단한다.
- runtime env, secret version reference, resource limit, scaling, timeout, target,
  queue/scheduler 설정은 identity 변경에 필요한 필드를 제외하고 old live 값과 정확히
  같다.
- 두 public admission gate는 false, staged revision은 no-traffic, private worker
  provider admission은 승인된 기존 contract 값으로 유지한다.
- retention은 enabled로 유지한다.

### 7.1 동일 slot 재사용 규칙

기존 Google Cloud service account는 아래 조건을 모두 만족할 때만 재사용한다.

1. old graph 전체에서 정확히 한 번만 나타난다.
2. desired graph에서도 동일 role, 동일 slot에만 남는다.
3. build identity 및 다른 일곱 workload slot과 다르다.
4. intended project 소속이고 disabled 상태가 아니다.
5. user-managed key가 없다.
6. 관측된 IAM과 resource attachment에 다른 role/slot의 충돌이 없다.

하나라도 증명할 수 없으면 재사용하지 않는다. Apify 계정, Google 사용자 계정,
서비스의 로그인/익명 사용자 계정은 이 판단 대상이 아니다.

### 7.2 새 계정 규칙

재사용할 수 없는 slot에만 deterministic role-slot account ID를 계산한다. account ID는
보호 값이므로 출력하지 않는다. 이미 같은 ID의 계정이 존재하면 intended project,
keyless, enabled, conflict-free 조건을 모두 만족할 때만 채택한다. 그렇지 않으면
`IDENTITY_CONFLICT`로 중단하며 임의 suffix로 우회하지 않는다.

`prepare apply`는 계산된 missing 계정만 생성한다. key와 project-wide role은 만들지
않는다. 계정 생성은 additive이고 실패 시 생성된 미사용 계정을 삭제하지 않는다.
실제 resource-scoped IAM/actAs/invoker/enqueuer 변경은 기존 epoch coordinator만
수행한다.

## 8. quiescence 준비

현재 enabled인 recovery scheduler가 있으면 `prepare inspect`가 정확한 정지 대상
개수만 proposal에 포함한다. `prepare apply`는 두 public gate가 이미 닫혀 있고,
두 queue가 PAUSED이며 task listing이 완전하고 empty이고, retention scheduler와
대상 recovery scheduler가 명확히 분리된 경우에만 해당 recovery scheduler를
PAUSED로 바꾼다.

정지 직후에는 epoch를 시작하지 않는다. 준비기는 Cloud Audit Logging에서 정확한
pause mutation과 resource를 다시 상관 검증하고, 실제 pause 시각 및 last-attempt를
관측한다. 승인된 grace/window가 아직 지나지 않았으면 `QUIESCENCE_PENDING`으로
종료한다. 임의 시각을 만들거나 긴 sleep으로 프로세스를 붙잡지 않는다. 이후
`epoch inspect` 재실행이 성숙한 provenance를 확인한다.

준비 mutation 중 오류가 나면 gates, queues, schedulers는 닫힌 상태로 남긴다.
자동 resume이나 보상성 gate-open은 하지 않는다.

## 9. zero-work evidence

zero-work source는 기존 validator의 고정 selector만 사용한다.

- provider ledger: 고정 Supabase provider-cost ledger
- billing ledger: 고정 Supabase revenue/cost operation ledger
- receiver ledger: 고정 Supabase analysis-step event ledger
- task audit: 정확한 두 queue에 대한 Cloud Tasks TaskActivityLog

lookback은 scheduler pause와 마지막 attempt, queue observation, proposal 생성 시각을
모두 덮도록 계산하며 기존 상한과 ingestion-lag 규칙을 만족해야 한다. count가 0이어도
pagination, watermark, Date header, 로그 sink/bucket coverage 중 하나가 불완전하면
`EVIDENCE_UNAVAILABLE`이다. 테이블이나 로그가 없으면 새 schema/sink를 만들지 않고
중단한다.

## 10. 독립 proposal 검증

`epoch inspect`는 같은 protected 값의 원문을 공유하지 않는 두 read-only observation
pass를 순차 실행한다. 두 pass는 각각 provider에서 새로 읽고 canonical packet,
bootstrap, selector, identity graph digest를 계산한다. 다음 조건을 모두 만족할 때만
하나의 proposal digest를 출력한다.

- 두 pass의 packet/bootstrap/scope digest가 정확히 같다.
- old live graph와 desired policy projection이 각각 같다.
- pairwise identity, same-slot reuse, build separation, keyless 검증이 모두 true다.
- source/build/runtime, queue/scheduler/IAM, readiness, zero-work selector가 완전하다.
- 준비 mutation 외의 drift가 없다.

별도의 visible Orca reviewer는 구현 코드, 고정 정책, 안전 출력, 두 pass의 safe digest
일치 결과를 검토한다. 보호 원문을 Orca 메시지나 보고서에 전달하지 않는다.

## 11. inherited-FD 실행

`epoch apply` 부모 프로세스는 approved digest를 재관측 결과와 비교한 후 packet과
bootstrap JSON을 메모리에 유지한다. 다음 세 child process를 순차 실행한다.

1. 기존 `run-capacity-identity-epoch.ts check`
2. 기존 `run-capacity-identity-epoch.ts apply --through VERIFIED`
3. 기존 `verify-capacity-identity-epoch.ts`

각 child에는 Node `spawn`의 추가 `stdio: 'pipe'`로 새 익명 pipe 두 개를 만들고,
숫자 FD만 `--packet-fd`, `--bootstrap-fd`에 전달한다. 부모는 해당 pipe에 JSON을 한 번
쓰고 즉시 닫는다. 같은 canonical 객체를 각 단계에 새로 serialize하며 디스크,
named FIFO, dotenv, environment variable, shell substitution을 사용하지 않는다.

check가 성공해도 apply child는 기존 구현대로 같은 입력에 대해 read-only admission을
다시 수행한다. apply가 `VERIFIED` 전에 실패하면 verifier를 성공 처리하지 않는다.
apply가 성공한 뒤 verifier는 새 process와 새 authenticated clients로 journal, lock,
desired live graph, closed gates, paused/empty work planes, retention, zero-work를 다시
읽는다. 출력은 기존 `CHECK_OK`, transition fixed codes, `VERIFIED_OK`만 통과시킨다.

부모 프로세스가 죽으면 pipe와 child process group을 닫고 중단한다. 재실행은 journal
state와 live state를 관측해 기존 coordinator의 reconciliation 규칙을 따르며, 절대로
activation으로 진행하지 않는다.

## 12. 실패 코드와 복구

새 경로가 추가하는 오류는 최소한 다음 고정 code로 제한한다.

- `OWNER_AUTH_UNAVAILABLE`
- `DISCOVERY_AMBIGUOUS`
- `PROPOSAL_STALE`
- `IDENTITY_CONFLICT`
- `QUIESCENCE_PENDING`
- `PROTECTED_PIPE_FAILED`

기존 packet/coordinator/adapter 오류 code는 그대로 보존한다. 모든 실패는 보호 값을
출력하지 않고 gates/queues/schedulers를 닫힌 상태로 유지한다. 생성된 미사용 keyless
계정은 후속 별도 검토 전까지 남겨 두며 자동 삭제하지 않는다.

## 13. 최소 검증 범위

사용자 지침에 따라 기존 광범위 테스트나 전체 CI를 추가로 돌리지 않는다. 다만 이
경로는 production IAM과 보호 입력을 다루므로 다음 focused provider-free 검증은
필수다.

- exact same-slot만 재사용하고 shared/cross-slot/keyed/build identity를 거부
- missing 계정만 생성하며 key와 broad project role을 만들지 않음
- inspect/apply digest mismatch와 control-plane drift를 mutation 전에 거부
- enabled recovery scheduler만 정확히 pause하고 retention은 건드리지 않음
- 보호 문자열이 argv, env, output, error, report에 나타나지 않음
- 익명 pipe가 packet/bootstrap을 각 child에 정확히 한 번 전달
- child 실패와 crash가 activation/resume/canary로 이어지지 않음
- 최종 command가 production `VERIFIED_OK`에서 종료

검증 명령은 관련 test file과 `npx tsc --noEmit`로 제한한다. production execution 전
fresh visible Orca Codex `gpt-5.6-luna`, effort `max` 구현자와 별도 reviewer를 사용한다.

## 14. 완료 조건

다음이 모두 충족되면 이 후속 작업은 완료다.

1. 준비기 구현과 focused 검증이 독립 review를 통과한다.
2. `prepare inspect/apply`가 필요한 최소 keyless 계정 생성과 recovery scheduler
   pause만 수행하고, 독립 pause provenance가 grace를 충족한다.
3. `epoch inspect`의 두 독립 관측 digest가 일치하고 별도 reviewer가 승인한다.
4. inherited-FD `check`가 성공한다.
5. 기존 coordinator가 production에서 정확히 `VERIFIED`까지 성공한다.
6. 독립 verifier가 `VERIFIED_OK`를 반환한다.
7. 두 public gate, 두 queue, 두 recovery scheduler는 닫힌 상태이고 retention은
   enabled다.
8. activation, resume, provider/user work, 실제 `0_min._.00` 카나리는 수행되지 않는다.
