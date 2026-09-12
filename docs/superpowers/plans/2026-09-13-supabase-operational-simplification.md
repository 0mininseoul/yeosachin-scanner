# Supabase 운영 단순화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** exact-22 terminal count를 약속하지 않고, 현재 legacy V2 runtime과 operator contract를 보존하면서 inactive canonical shadow의 table, RPC, flag, mirror/shadow-read, backfill 표면을 줄인다. 첫 bounded production-safe wave는 evidence gate를 통과한 9개 W1A table을 대상으로 하며, `payment_events`, `analysis_jobs`, `analysis_events`, `analysis_provider_runs`, `maintenance_jobs`는 별도 보존 경계로 둔다.

**Architecture:** legacy V2 분석/결제/fulfillment/notification/account 경로를 현재 authoritative source로 유지한다. inactive canonical shadow는 family 단위로 code reference를 먼저 닫은 뒤 명시적 allowlist migration으로 retire하고, `maintenance_jobs`는 historical/recovery sink으로, 기존 admin projection/RPC는 operator-facing contract로 유지한다. canonical `analysis_jobs/events`는 nonzero transitional evidence로 archive/checksum 이후 별도 판단한다.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Supabase PostgreSQL, Supabase CLI 2.102.0, existing legacy V2 RPC/projection contracts, repository evidence and read-only catalog tooling.

---

## 현재 결정과 작업 경계

이 계획은 `origin/main` `2cd1312f`와 2026-09-13 coordinator aggregate inventory를 기준으로 한다. 현재 dispatch에서 수행하는 것은 두 개의 설계 문서 작성, 문서 미완성 표기 검사, `git diff --check`, commit뿐이다. 다음 작업은 하지 않는다.

- production/remote Supabase 접속, migration apply, table/function drop, `supabase db push`
- canonical read/write flag 활성화, real canary, traffic cutover
- `payment_pending` 또는 payment/order 상태 mutation
- active V2 table의 canonical backfill 또는 canonical authoritative 전환
- application/SQL implementation, 새 테스트 추가, `app/page.tsx` copy 및 protected file 변경

최신 aggregate는 public base table 160개와 exact-count zero-row table 61개를 보여주지만 `pg_stat.stats_reset = NULL`이다. 따라서 숫자는 현재 snapshot으로만 기록하고, inactivity·quiescence·최종 table 수를 추론하지 않는다. exact-22의 기존 13개 조사 집합은 W1A allowlist가 아니다.

## 결정된 분류와 wave 경계

### Active runtime 유지

다음과 같은 source와 active runtime은 canonical shadow로 옮기지 않는다.

- root/product: `users`, `landing_leads`, `result_feedback`, `earlybird_waitlist`, `earlybird_orders`, `analysis_requests`, `analysis_results`, `analysis_preflights`
- V2 runtime: `analysis_pipeline_jobs`, `analysis_progress_state`, `analysis_progress_events` 및 현재 v2 relationship/candidate/media/cost/provider source
- provider and cache: `analysis_provider_runs`, `ai_analysis_cache`, `analysis_anonymous_profile_cache`
- operator projection: analysis observability, order audit, score audit, landing-lead admin projection/RPC

`analysis_provider_runs`는 현재 aggregate가 0이어도 `lib/services/analysis/provider-run.ts`가 admission/charge를 직접 참조하므로 보존한다.

### W1A 첫 bounded production-safe wave

W1A의 table allowlist는 다음 9개로 제한한다.

| family | table | code closure 범위 | first wave 상태 |
| --- | --- | --- | --- |
| analysis | `analysis_artifacts` | artifact write, family read/shadow, 전용 RPC/backfill | 대상 |
| analysis | `analysis_audit_bundles` | audit bundle write, result audit shadow-read, 전용 RPC/backfill | 대상 |
| analysis | `analysis_cache` | canonical cache write/read, 전용 RPC/backfill | 대상 |
| analysis | `analysis_costs` | cost/audit mirror, late-cost helper, 전용 RPC/backfill | 대상 |
| commerce | `account_lifecycle` | account mirror, account family flag/backfill; deletion source와 maintenance path는 유지 | 대상 |
| commerce | `fulfillment_jobs` | fulfillment dual-write/family helper; legacy fulfillment은 유지 | 대상 |
| commerce | `notification_outbox` | 세 notification mirror/shadow-read hook과 family helper; legacy delivery는 유지 | 대상 |
| commerce | `system_configuration` | config family flag/RPC/helper; 현재 authoritative config source는 유지 | 대상 |
| commerce | `system_leases` | canonical lease family flag/RPC/helper; active provider/admission lease는 유지 | 대상 |

모든 W1A table은 fresh exact count가 0이어야 하고, 동시에 active caller·enabled flag·dependency·operator requirement가 없어야 한다. 0행만 확인해도 충분하지 않다.

### W1B 및 보존 wave

- `payment_events`는 payment-sensitive W1B hold다. payment webhook/order ledger와의 독립 증거가 없으면 code/table을 변경하지 않는다. 이 계획은 `payment_pending`을 쓰거나 보정하지 않는다.
- `analysis_jobs` 19행과 `analysis_events` 81행은 먼저 consistent snapshot archive, full-row checksum, PK/reference manifest를 만든다. archive/checksum gate 전에는 drop하지 않는다.
- `analysis_provider_runs`는 direct source caller가 없어졌다는 별도 증거 전에는 보존한다.
- `maintenance_jobs`와 `supabase/operations/20260911_restore_*`, `supabase/operations/20260912_restore_*`는 historical/recovery 계약이므로 W1A에서 변경하지 않는다.

## 파일별 implementation work packages

각 단계는 이전 단계의 산출물이 검토되고 나서 다음 단계로 진행한다. 아래 파일 목록은 후속 implementation의 정확한 change surface이며, 현재 dispatch에서 실제로 수정하지 않는다.

### Phase 0: source와 evidence 계약 고정

- [ ] `git status --short --branch`, `git rev-parse HEAD`, `git rev-parse origin/main`으로 시작 SHA와 dirty worktree를 기록한다. `app/page.tsx`, `.playwright-mcp/`, `supabase/migrations/20260719190000_reconcile_stuck_groble_earlybird_order.sql` 및 기타 protected path가 변경되지 않았음을 확인한다.
- [ ] 최신 aggregate evidence를 operational inventory에 기록한다: public base tables 160, zero-row tables 61, `stats_reset = NULL`, W1A candidate row counts, `analysis_jobs/events` 19/81, active root/V2 row counts. 이 숫자를 terminal target으로 사용하지 않는다.
- [ ] `lib/services/analysis/canonical-analysis-read.ts`, `lib/services/analysis/canonical-analysis-store.ts`, `lib/services/analysis/v2-worker.ts`, `lib/services/analysis/v2-progress-reporter.ts`, `lib/services/analysis/provider-cost-reconciliation.ts`, `lib/services/analysis/v2-result-store.ts`의 table/RPC/flag reference를 family별로 매핑한다.
- [ ] `lib/services/operations/canonical-operations-store.ts`, `lib/services/commerce/canonical-commerce-store.ts`, `lib/services/identity/account-deletion.ts`, `lib/services/identity/account-deletion-canonical-adapter.ts`에서 W1A family와 maintenance-only path를 분리한다. 공용 `canonicalJsonHash`/`canonicalEvidenceHash`가 maintenance/recovery에 남으면 해당 helper를 제거하지 않는다.
- [ ] 다음 caller의 legacy path와 canonical hook을 각각 기록한다: `app/api/webhooks/groble/route.ts`, `lib/services/earlybird/fulfillment-store.ts`, `lib/services/earlybird/payment-discord.ts`, `lib/services/identity/kakao-signup-discord.ts`, `lib/services/sentry-discord-alert.ts`, `lib/services/identity/account-principal-store.ts`, `lib/services/identity/account-deletion.ts`.
- [ ] `app/api/internal/earlybird-payment-discord-outbox/route.ts`, `app/api/internal/kakao-signup-discord-outbox/route.ts`, `app/api/internal/sentry-discord-alert-outbox/route.ts`, `app/api/admin/analysis-observability/route.ts`, `app/api/admin/order-audit/route.ts`, `app/api/admin/analysis-audit/route.ts`, `app/api/admin/landing-leads/route.ts`가 W1A table을 필수로 읽지 않음을 확인한다.
- [ ] `supabase/migrations/20260909095740_add_analysis_canonical_tables.sql`, `supabase/migrations/20260909095932_add_commerce_operation_canonical_tables.sql`, `supabase/migrations/20260911100000_grant_wave1_backfill_projection_select.sql`, `supabase/migrations/20260911123000_add_analysis_canonical_backfill_apply.sql`에서 object/routine dependency manifest를 만든다. 적용된 migration 파일 자체는 삭제하거나 수정하지 않는다.

**Phase 0 완료 조건:** W1A table마다 source caller 없음, disabled flag 상태, legacy fallback, dependency closure, admin independence, archive requirement가 한 manifest에 있고, 하나라도 불명확한 family는 W1A에서 제거된다.

### Phase 1: 분석 shadow code를 jobs/events 경계까지 축소

- [ ] `lib/services/analysis/canonical-analysis-store.ts`에서 `analysis_artifacts`, `analysis_costs`, `analysis_cache`, `analysis_audit_bundles`의 write schema/method/flag를 제거한다. `analysis_jobs`와 `analysis_events`가 아직 보존 대상이므로 job/event recording contract와 필요한 공용 validation은 유지한다.
- [ ] `lib/services/analysis/canonical-analysis-read.ts`에서 W1A audit/cache/artifact/cost family의 read/shadow helper를 제거한다. jobs/events 또는 보존 대상 helper와 공용 fallback 로직을 혼동하지 않는다.
- [ ] `lib/services/analysis/v2-result-store.ts`에서 `canonicalReadStore.shadowRead({ family: 'audit' })` hook을 제거하고 legacy result/audit source를 그대로 유지한다.
- [ ] `lib/services/analysis/provider-cost-reconciliation.ts`에서 canonical cost/audit mirror 호출을 제거하고 legacy settlement/ledger를 authoritative로 유지한다. provider admission/charge와 `analysis_provider_runs`는 변경하지 않는다.
- [ ] `lib/services/analysis/v2-worker.ts`와 `lib/services/analysis/v2-progress-reporter.ts`에서는 retained jobs/events 기록만 유지하고 W1A artifact/cost/audit/cache mirror를 호출하는 경로가 남지 않았는지 확인한다.
- [ ] `scripts/backfill-analysis-canonical.ts`와 관련 existing verify entry point를 W1A family에 대해 retired 상태로 바꾼다. 이미 적용된 migration을 되돌리거나, active jobs/events를 새 table로 복사하는 fallback을 추가하지 않는다.

**Phase 1 완료 조건:** 분석 결과/progress/provider cost의 legacy path가 동일하고, W1A 분석 family에 대한 import, table name, RPC name, flag name, shadow hook가 source에 남지 않는다. jobs/events는 archive wave 전까지 호출 계약이 보존된다.

### Phase 2: commerce shadow code를 maintenance 경계까지 축소

- [ ] `lib/services/operations/canonical-operations-store.ts`에서 W1A인 fulfillment, notification, account, config, lease의 family schema/flag/shadow helper를 제거한다. `maintenance` family의 enqueue/claim/finish/reconcile와 recovery adapter는 유지한다. `payment` family는 W1B hold이므로 이 단계에서 제거하지 않는다.
- [ ] `lib/services/commerce/canonical-commerce-store.ts`에서 W1A mirror 전용 parser/RPC 호출을 제거한다. `canonicalJsonHash`/`canonicalEvidenceHash`처럼 payment 또는 maintenance recovery가 공유하는 utility는 caller가 모두 사라졌다는 증거 전에는 유지한다.
- [ ] `lib/services/earlybird/fulfillment-store.ts`에서 fulfillment canonical dual-write/fallback만 제거하고 legacy fulfillment/order RPC를 유지한다.
- [ ] `lib/services/earlybird/payment-discord.ts`, `lib/services/identity/kakao-signup-discord.ts`, `lib/services/sentry-discord-alert.ts`에서 notification canonical mirror만 제거한다. legacy outbox enqueue/delivery의 idempotency와 retry는 변경하지 않는다.
- [ ] `lib/services/identity/account-principal-store.ts`에서 account lifecycle mirror만 제거한다. principal read/write와 user identity source는 유지한다.
- [ ] `lib/services/identity/account-deletion.ts`에서 account lifecycle canonical mirror만 제거한다. deletion source, `maintenance_jobs` archive, recovery contract는 유지한다. `lib/services/identity/account-deletion-canonical-adapter.ts`가 maintenance-only이면 남긴다.
- [ ] 세 internal outbox route에서 `shadowReadCanonicalNotificationOutbox`와 notification read flag만 제거하고, legacy outbox list/claim/delivery를 유지한다.
- [ ] `scripts/backfill-commerce-operations-canonical.ts`와 `scripts/backfill-account-deletion-canonical.ts`를 W1A family가 다시 실행되지 않도록 정리한다. maintenance archive operation은 유지한다.

**Phase 2 완료 조건:** fulfillment/notification/account/config/lease W1A family의 application reference가 없어지고, legacy webhook, order, notification, identity deletion 및 maintenance recovery path가 독립적으로 남는다. payment mirror와 `payment_events` hold는 변경하지 않는다.

### Phase 3: exact-22 contract를 operational policy로 변경

- [ ] `lib/services/operations/supabase-22-evidence.ts`의 `SUPABASE_22_CANONICAL_TABLES`와 exact routine 목록을 active runtime, transitional canonical, recovery, retirement candidate policy로 분리한다. 숫자 22를 invariant로 남기지 않는다.
- [ ] `scripts/generate-supabase-22-retirement-inventory.ts`의 `SUPABASE_22_EXPECTED_TABLE_COUNT = 187`, `EXPECTED_LEGACY_COUNT = 165`, exact canonical set 비교를 제거한다. current catalog를 읽어 class, allowlist, deferred reason, dependency evidence를 출력하도록 바꾼다.
- [ ] `scripts/verify-supabase-22-catalog.ts`를 terminal count verifier가 아니라 policy verifier로 바꾼다. W1A table absent, active/runtime and recovery survivors present, jobs/events preserved, no unexpected object deletion을 검증한다.
- [ ] 기존 `lib/services/operations/supabase-22-evidence.test.ts`, `scripts/verify-supabase-22-catalog.test.ts`, `scripts/generate-supabase-22-retirement-inventory.test.ts`, `scripts/verify-supabase-22-archive-restore.test.ts`, `lib/services/operations/canonical-operations-store.test.ts`, `lib/services/commerce/canonical-commerce-store.test.ts`를 새 policy에 맞게 갱신한다. 새 테스트 파일은 만들지 않는다.
- [ ] 기존 exact-22 문서와 보고서는 historical baseline으로 보존하고, 새 문서와 inventory output이 160 snapshot 또는 22 terminal count를 future guarantee로 표현하지 않는지 확인한다.

**Phase 3 완료 조건:** catalog/inventory가 fresh source와 policy class를 출력하고, active runtime, transitional jobs/events, recovery maintenance를 W1A retirement와 혼동하지 않는다.

### Phase 4: preserve/archive와 explicit contraction migration 준비

- [ ] `analysis_jobs`와 `analysis_events`를 consistent snapshot으로 full-row archive한다. row-level checksum, PK uniqueness, column/type manifest, FK/reference manifest, source SHA, migration history를 함께 저장한다. archive는 새 Supabase table을 만들지 않고 승인된 encrypted evidence artifact로 보관한다.
- [ ] W1A 대상 9개에 대해 exact row count가 0인지, 모든 direct caller/RPC/flag/dependency가 닫혔는지 재검증한다. `analysis_provider_runs`, `analysis_jobs/events`, `maintenance_jobs`, `payment_events`가 allowlist에 들어가지 않았는지 확인한다.
- [ ] 후속 migration 파일을 `supabase/migrations/20260913120000_retire_inactive_canonical_shadow.sql`로 추가한다. 이 migration은 W1A 9개만 명시적으로 다루고, `CASCADE`를 사용하지 않으며, dependency/precondition 실패 시 중단한다.
- [ ] migration의 routine 정리는 dependency manifest에 있는 W1A 전용 routine만 대상으로 한다. 예시는 `append_analysis_canonical_artifact`, `append_analysis_canonical_cost`, `upsert_analysis_canonical_cache`, `append_analysis_canonical_audit`, `append_analysis_canonical_late_cost_audit`, `upsert_fulfillment_job_v1`, `enqueue_notification_v1`, `claim_notification_outbox_v1`, `finish_notification_outbox_v1`, `reconcile_stale_notification_outbox_v1`, `append_account_lifecycle_v1`, `record_system_configuration_v1`, `acquire_system_lease_v1`이며, 실제 drop 목록은 preflight catalog와 dependency 결과로 확정한다. jobs/events, payment, maintenance shared routine은 건드리지 않는다.
- [ ] rollback artifact를 `supabase/operations/20260913_restore_inactive_canonical_shadow.sql`에 명시한다. table definition, column/default, PK/index, RLS/policy, trigger, ACL, W1A 전용 routine을 archive manifest와 비교해 격리 DB에서만 검증할 수 있게 한다.
- [ ] `supabase/migrations/20260909095740_add_analysis_canonical_tables.sql`과 `supabase/migrations/20260909095932_add_commerce_operation_canonical_tables.sql`은 immutable history로 남긴다. 후속 migration이 old file을 overwrite하거나 기존 migration history를 재작성하지 않는다.

**Phase 4 완료 조건:** W1A exact allowlist, archive manifest, restore operation, no-CASCADE routine list가 reviewer가 확인할 수 있고, payment/active/recovery/transitional object가 명시적으로 제외된다.

### Phase 5: bounded apply와 post evidence

- [ ] owner가 승인한 별도 change window와 linked Supabase CLI workdir에서만 preflight를 실행한다. dirty/mixed worktree에 `supabase db push --include-all`을 실행하지 않고, 선택 migration만 격리 workdir에서 dry-run으로 확인한다. 현재 dispatch에서는 이 단계를 실행하지 않는다.
- [ ] preflight에서 table row/checksum, PK/FK, RLS/policy, ACL, trigger, publication/sequence/partition, `pg_depend`, function body, flag config, source reference, admin route independence를 다시 수집한다.
- [ ] application code change를 먼저 배포하여 W1A read/write/shadow caller가 사라진 상태를 확인한다. legacy analysis, progress, result, fulfillment, notification, identity deletion, admin route smoke가 통과하기 전에는 schema를 줄이지 않는다.
- [ ] `20260913120000_retire_inactive_canonical_shadow.sql`은 W1A exact allowlist만 적용한다. payment webhook/order path와 `payment_pending`은 read-only 관찰도 별도 evidence로 남기되 mutation하지 않는다.
- [ ] post catalog에서 W1A table/routine/flag가 사라졌는지, active runtime/`analysis_provider_runs`/jobs/events/`maintenance_jobs`/payment objects가 보존되었는지 확인한다. migration history에 기대한 단일 entry만 있는지 확인한다.
- [ ] analysis start/progress/result, webhook finalization, fulfillment, 세 notification outbox delivery, account deletion/recovery, admin observability/order/score audit contract를 smoke한다. 결과와 row checksum을 preflight manifest와 비교한다.

**Phase 5 완료 조건:** W1A만 제거되고 legacy service/operator contract가 유지되며, unexpected object/status/table/flag mutation이 없다. 하나라도 실패하면 apply를 중단하고 rollback/restore 판단으로 이동한다.

## Evidence checklist

### Pre evidence

- source SHA와 migration history
- fresh public catalog와 object class
- W1A exact row count, PK digest, column/default/index/FK/trigger/policy/RLS/ACL/`pg_depend`
- W1A 전용 function/RPC body와 application caller inventory
- `ANALYSIS_CANONICAL_*`, `COMMERCE_CANONICAL_*` 실제 read/write flag 값 및 config source
- `analysis_jobs/events` full-row archive와 19/81 snapshot checksum 비교
- active runtime counts와 source caller 증거; `analysis_provider_runs` zero-row여도 active로 판정한 근거
- `maintenance_jobs`와 recovery operation 보존 증거
- admin route/projection independence
- payment/order/user deletion evidence 및 `payment_pending` mutation 없음 확인

### Post evidence

- W1A table와 W1A-only routine/flag/dependency 부재
- active root/V2/provider/cache tables와 `maintenance_jobs`, `analysis_jobs/events` 보존
- legacy result, progress, provider settlement, fulfillment, notification, identity deletion, admin read contract smoke
- migration history의 단일 expected entry와 no unexpected DDL/DML
- pre/post catalog digest 및 retained table checksum
- `payment_pending` status row 변경 없음
- rollback archive/restore operation의 isolated verification 결과

## Rollback

1. preflight나 code verification이 실패하면 migration을 적용하지 않고 해당 family를 deferred set으로 되돌린다.
2. code-only 문제면 이전 application commit으로 돌아가되, schema를 이미 줄였다면 먼저 `supabase/operations/20260913_restore_inactive_canonical_shadow.sql`을 격리 DB에서 archive checksum과 검증한다.
3. production restore는 owner 승인 후에만 수행한다. restore 대상은 W1A archive manifest의 exact objects이고, broad `CASCADE`, uncertain replay, payment status mutation을 사용하지 않는다.
4. restore가 성공한 뒤 application commit을 되돌리고 legacy path를 재검증한다. `maintenance_jobs`, active legacy source, jobs/events archive는 rollback 중에도 덮어쓰거나 삭제하지 않는다.
5. migration apply가 멈추면 재시도하지 않고 remote migration history와 catalog를 먼저 검증한다. 상태가 불명확한 family는 deferred로 두고 별도 incident evidence를 남긴다.

## 완료 기준과 현재 handoff

후속 구현 branch가 완료되었다고 말하려면 W1A allowlist와 모든 pre/post evidence가 존재하고, active runtime과 operator contract가 보존되며, exact-22 또는 terminal table count를 약속하지 않아야 한다. 현재 문서 작업의 완료 기준은 다음 두 파일만 변경하고 미완성 표기 검사 및 `git diff --check`를 통과하는 것이다.

- `docs/superpowers/specs/2026-09-13-supabase-operational-simplification-design.md`
- `docs/superpowers/plans/2026-09-13-supabase-operational-simplification.md`

현재 handoff에는 application/SQL implementation과 production mutation이 없으며, 두 문서의 commit SHA만 coordinator에게 보고한다.
