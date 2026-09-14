# Owner-only identity epoch descriptor preparation implementation plan

> 실행 방식: 이 계획은 현재 프로젝트의 격리 worktree에서 fresh visible Orca Codex
> `gpt-5.6-luna`, effort `max` 구현자가 수행하고, 별도의 동일 모델 reviewer가 검토한다.

**Goal:** owner의 기존 인증 세션에서 production control-plane 값을 메모리로만
관측해 coordinated identity epoch packet/bootstrap을 만들고, 필요한 최소 준비
mutation 뒤 기존 실행기를 inherited FD로 연결하여 production `VERIFIED_OK`에서
종료한다.

**Architecture:** 앱 runtime과 분리된 owner-only CLI가 provider REST transport와
순수 proposal builder를 조합한다. read-only inspect가 canonical proposal digest를
발행하고, apply는 같은 상태를 재관측해 digest가 일치할 때만 keyless 계정 생성과
recovery scheduler pause를 수행한다. quiescence 이후 epoch apply는 packet/bootstrap을
디스크에 저장하지 않고 세 개의 기존 child process에 익명 pipe로 전달한다.

**Tech stack:** Node.js 24, TypeScript, 기존 capacity identity epoch modules, native
`fetch`, `google-auth-library`, Vercel CLI owner credential store, Vitest.

---

## Task 1: pure identity/proposal policy

**Files:**

- Create: `scripts/capacity-identity-epoch/owner-preparation.ts`
- Create: `scripts/capacity-identity-epoch/owner-preparation.test.ts`

**Implementation:**

1. 고정 role/slot 순서와 deterministic account-ID mapping을 정의한다. 실제 project나
   identity 값은 상수 또는 fixture 밖에 넣지 않는다.
2. `selectDesiredIdentityGraph(observation)`을 구현한다. exact same-slot, singleton,
   enabled, keyless, build-distinct, conflict-free인 기존 계정만 재사용한다.
3. 재사용 불가 slot은 deterministic desired identity로 채우고, 기존 충돌 계정은
   `IDENTITY_CONFLICT`로 거부한다. missing 계정 목록에는 존재하지 않는 계정만 둔다.
4. 준비 action을 account creation과 recovery scheduler pause로만 제한하고 retention,
   queue resume, IAM, gate, key action을 타입 수준 allowlist로 막는다.
5. canonical projection과 digest 함수는 raw 값을 반환할 수 있지만 safe summary는
   digest와 역할별 count/boolean만 노출한다.

**Focused verification:**

```bash
npx vitest run scripts/capacity-identity-epoch/owner-preparation.test.ts
```

필수 사례는 same-slot 재사용, cross-slot/shared/keyed/disabled/build 충돌 거부,
deterministic missing 계산, broad action 부재다.

## Task 2: owner credential and protected transport boundary

**Files:**

- Create: `scripts/capacity-identity-epoch/owner-auth.ts`
- Create: `scripts/capacity-identity-epoch/owner-auth.test.ts`
- Reuse: `scripts/capacity-identity-epoch/platform.ts`

**Implementation:**

1. 현재 OS uid가 소유하고 group/other write가 금지된 linked Vercel metadata와 Vercel
   CLI credential store만 허용한다. repo dotenv와 current process env에서 credential을
   읽지 않는다.
2. Google access token은 `gcloud auth print-access-token`의 private captured pipe로만
   받는다. child stdout/stderr 원문을 상위 output으로 전달하지 않는다.
3. Vercel/Google/Supabase용 authenticated transport를 메모리 credential provider로
   생성한다. request URL과 Authorization은 log/error에 포함하지 않는다.
4. 모든 public error를 고정 code로 변환하고 secret scrubber를 출력 최종 경계에 둔다.
5. owner uid/permission, login 부재, credential parse 오류는 mutation 전에
   `OWNER_AUTH_UNAVAILABLE`로 실패시킨다.

**Focused verification:**

```bash
npx vitest run scripts/capacity-identity-epoch/owner-auth.test.ts
```

fixture credential과 protected selector가 argv/env/stdout/stderr/error에 나타나지 않는지
검증한다.

## Task 3: exact production discovery

**Files:**

- Create: `scripts/capacity-identity-epoch/owner-discovery.ts`
- Create: `scripts/capacity-identity-epoch/owner-discovery.test.ts`
- Reuse: `scripts/capacity-identity-epoch/contracts.ts`
- Reuse: `scripts/capacity-identity-epoch/live-evidence.ts`

**Implementation:**

1. linked Vercel project에서 exact production deployment, alias, production env와
   exact-v3 readiness를 fully paged API로 읽는다. env key는 기존 preflight/paid
   allowlist만 허용한다.
2. env selector로 exact Cloud Run services/revisions, Cloud Build provenance, Tasks
   queues/tasks, recovery/retention schedulers, IAM policies, service accounts/keys를
   direct REST로 읽는다. substring 후보 선택은 금지한다.
3. 세 Supabase ledger와 exact two-queue TaskActivityLog selector를 기존 validator가
   요구하는 고정 shape로 만든다. ledger/table/log coverage가 없으면 만들지 않고
   `EVIDENCE_UNAVAILABLE`로 중단한다.
4. old observation graph와 desired invariant input을 별도 객체로 반환한다. 모든 list는
   pagination complete를 요구하고 duplicate/ambiguous/mixed-project는 거부한다.
5. source SHA, build provenance, digest-pinned image가 정확히 연결되지 않으면 build나
   deploy를 시작하지 않고 `SOURCE_INVALID`로 중단한다.

**Focused verification:**

```bash
npx vitest run scripts/capacity-identity-epoch/owner-discovery.test.ts
```

fake paginated transports로 incomplete page, mixed project, ambiguous selector, missing
ledger, source/build mismatch를 검증한다.

## Task 4: preparation inspect/apply

**Files:**

- Create: `scripts/prepare-capacity-identity-epoch.ts`
- Create: `scripts/capacity-identity-epoch/owner-preparation-operator.ts`
- Create: `scripts/capacity-identity-epoch/owner-preparation-operator.test.ts`
- Modify: `package.json`

**Implementation:**

1. strict parser로 `prepare inspect`, `prepare apply --approved-digest DIGEST`,
   `epoch inspect`, `epoch apply --approved-digest DIGEST --through VERIFIED`만 허용한다.
2. prepare inspect는 discovery와 pure policy를 실행하고 고정 safe summary만 출력한다.
3. prepare apply는 fresh discovery 후 approved digest를 비교한다. missing keyless account
   생성과 enabled recovery scheduler pause만 direct REST mutation으로 수행하며 각
   mutation 뒤 read-back한다.
4. account key 생성, deletion, project IAM, retention/queue/gate 변경 요청은 구현하지
   않는다. partial failure는 닫힌 상태를 유지하고 fixed code로 종료한다.
5. scheduler pause는 Audit Logging provenance와 last-attempt를 상관 검증한다.
   grace 미충족은 `QUIESCENCE_PENDING`으로 종료하고 긴 sleep을 하지 않는다.
6. package script `capacity:identity-epoch:prepare`만 추가한다. CI workflow는 변경하지
   않는다.

**Focused verification:**

```bash
npx vitest run scripts/capacity-identity-epoch/owner-preparation-operator.test.ts
```

inspect가 mutation하지 않는지, stale digest가 첫 mutation 전에 멈추는지, exact
account/pause action과 crash fail-closed를 검증한다.

## Task 5: packet/bootstrap assembly

**Files:**

- Create: `scripts/capacity-identity-epoch/owner-descriptors.ts`
- Create: `scripts/capacity-identity-epoch/owner-descriptors.test.ts`
- Reuse: `scripts/capacity-identity-epoch/packet.ts`
- Reuse: `scripts/capacity-identity-epoch/bootstrap.ts`

**Implementation:**

1. live old observations와 pure desired graph에서 `ProtectedPacketInput`을 구성하고
   `createProtectedPacket`으로 canonical packet을 만든다.
2. desired runtime은 old settings/env/secret references를 보존하고 identity와 epoch
   annotation만 변경한다. Cloud Run service body는 기존 `validateServiceBodies`가
   허용하는 exact shape로 구성한다.
3. providerScope, readiness, queue/scheduler/IAM/retention, zero-work sources를 packet과
   bootstrap 양쪽에 독립 포함하고 기존 digest binding을 통과시킨다.
4. bootstrap credential은 owner auth provider의 in-memory 값만 참조한다. descriptor를
   stringify한 뒤에도 file/env/log 저장 API로 전달하지 않는다.
5. 두 fresh read-only pass에서 packet/bootstrap/scope/identity graph digest가 정확히
   같을 때만 epoch proposal을 발행한다.

**Focused verification:**

```bash
npx vitest run scripts/capacity-identity-epoch/owner-descriptors.test.ts scripts/capacity-identity-epoch.integration.test.ts
```

기존 packet/bootstrap validator와 source/runtime/IAM/zero-work digest binding을 실제로
통과시키고 한 필드 drift를 모두 거부하는지 검증한다.

## Task 6: anonymous inherited-FD bridge

**Files:**

- Create: `scripts/capacity-identity-epoch/owner-fd-bridge.ts`
- Create: `scripts/capacity-identity-epoch/owner-fd-bridge.test.ts`
- Modify: `scripts/prepare-capacity-identity-epoch.ts`

**Implementation:**

1. Node `spawn`에 추가 anonymous pipe 두 개를 만들고 숫자 FD만 child argv에 넣는다.
2. 부모가 canonical packet/bootstrap JSON을 pipe에 한 번 쓴 뒤 닫도록 구현한다.
3. check, apply `--through VERIFIED`, verifier를 새 child process로 순차 실행한다.
4. output allowlist를 적용해 fixed code 외 child output을 전달하지 않는다. child error,
   timeout, signal은 `PROTECTED_PIPE_FAILED` 또는 기존 fixed code로 축약한다.
5. apply 성공 뒤에만 verifier를 실행하며, `VERIFIED_OK`에서 부모도 성공 종료한다.
   activation/resume/canary executable은 호출 가능한 mapping에 포함하지 않는다.

**Focused verification:**

```bash
npx vitest run scripts/capacity-identity-epoch/owner-fd-bridge.test.ts
```

각 child가 descriptor를 정확히 한 번 받고, argv/env/file에 fixture 보호 값이 없으며,
중간 실패 시 다음 child나 activation이 실행되지 않는지 검증한다.

## Task 7: runbook and static verification

**Files:**

- Modify: `docs/analysis-v2-production-operations.md`
- Modify: `docs/superpowers/specs/2026-09-14-owner-only-identity-epoch-descriptor-preparation-design.md`
  only if implementation names differ, without changing approved behavior

**Implementation:**

1. owner-only four-stage command, safe output, retry boundary, `VERIFIED` stop condition을
   runbook에 기록한다.
2. 실제 값, 예시 identity/project/resource/URL, credential 입력 예시는 넣지 않는다.
3. 새 코드만 대상으로 leakage search와 TypeScript 검증을 수행한다.

**Verification:**

```bash
npx vitest run \
  scripts/capacity-identity-epoch/owner-preparation.test.ts \
  scripts/capacity-identity-epoch/owner-auth.test.ts \
  scripts/capacity-identity-epoch/owner-discovery.test.ts \
  scripts/capacity-identity-epoch/owner-preparation-operator.test.ts \
  scripts/capacity-identity-epoch/owner-descriptors.test.ts \
  scripts/capacity-identity-epoch/owner-fd-bridge.test.ts \
  scripts/capacity-identity-epoch.integration.test.ts
npx tsc --noEmit
git diff --check
```

전체 test suite, build, lint, deployment CI는 별도 장애가 드러나지 않는 한 실행하지
않는다.

## Task 8: independent review and production evidence gate

1. fresh visible Luna max reviewer가 diff, focused results, no-leakage 경계와 production
   mutation allowlist를 검토한다. finding이 있으면 구현자에게 수정시키고 재검토한다.
2. clean reviewed commit에서 `prepare inspect`를 실행하고 safe digest/count만 독립
   reviewer가 확인한다.
3. 승인 digest로 `prepare apply`를 실행한다. `QUIESCENCE_PENDING`이면 scheduler를
   재개하지 않고 필요한 시간이 지난 뒤 `epoch inspect`를 재실행한다.
4. 두-pass epoch proposal digest를 별도 reviewer가 승인한 뒤 `epoch apply
   --through VERIFIED`를 실행한다.
5. `CHECK_OK`, coordinator `VERIFIED`, 독립 `VERIFIED_OK` 및 closed gates/paused planes/
   enabled retention을 safe report에 기록한다.
6. activation, queue/scheduler resume, gate-open, provider/user work, 실제
   `0_min._.00` 카나리는 실행하지 않는다.

