# Preflight and administrator console final gap audit

Date: 2026-09-11 (Asia/Seoul)

Scope: the merged `origin/main` implementation of the preflight production-error
workstream and the `/admin/analysis-audit` operator console. This audit is
provider-free and sanitized: it does not contain production credentials,
cookies, user/order/request IDs, raw provider data, or environment values.

## Executive disposition

The two implementation workstreams are complete on `origin/main`; no missing
application code or regression test was found, so this audit changes no
preflight/admin source or test file. The remaining items are activation-only
evidence: a fresh post-fix natural preflight retry/cohort observation, any
owner decision on the historical IAM act-as concern, and a real account canary.
Those items were intentionally not attempted under this audit's safety boundary.

| Workstream | Merged implementation | Read-only evidence | Final disposition |
| --- | --- | --- | --- |
| Preflight production error | PR #548 and its preflight/runtime predecessors are in main | Sanitized incident, OIDC recovery, stale-invoker cleanup, config guards, worker-route tests, and capacity-infra tests | **Complete for code and safe preflight evidence; live activation proof remains excluded** |
| Administrator dashboard | PR #546 console, PR #552 hardening, and landing-lead follow-ups are in main | Cookie/session allowlist, bounded private projections, no-store requests, synthetic UI state/accessibility tests, build/type/lint | **Complete for implementation and bounded verification** |

## Main ancestry and merged history

The audit worktree started clean at the exact fetched main tip:

```text
HEAD       956dd485259c7e1dd5b0ecbea09f24fd90aafb2a
origin/main 956dd485259c7e1dd5b0ecbea09f24fd90aafb2a
merge-base 956dd485259c7e1dd5b0ecbea09f24fd90aafb2a
ahead/behind 0 0
```

Both target workstreams are ancestors of this exact main tip. The first-parent
history contains:

```text
1482c453 Integrate bounded preflight UX and production control-plane guards (#548)
10f3c3e5 fix(admin): harden operations console verification (#552)
```

The relevant implementation trail is:

- `7a14c611` — merged preflight production-stall remediation.
- `69410975` — merged production operations console and API integration.
- `1482c453` — merged bounded preflight UX, OIDC/config guards, and sanitized diagnostics.
- `10f3c3e5` — merged console responsive, accessibility, recovery, navigation, and inventory hardening.
- `12336991`, `51b356c7`, and their follow-ups — merged landing-lead projection and reload/recovery compatibility used by the console.

`git merge-base --is-ancestor` returned success for both `1482c453` and
`10f3c3e5`; no relevant work exists only on an unmerged feature branch.

## Preflight production-error evidence

### Historical production finding and remediation

The sanitized [B-lite fallback production investigation](../investigations/blite-fallback-production-20260905.md)
identifies the prior failure as target/version skew: the producer emitted the
current role-bearing task payload while the configured receiver was an older
worker that rejected the payload before preflight processing. It records the
dedicated receiver remediation and explicitly leaves post-fix natural retry or
canary verification pending. The [OIDC recovery report](../investigations/preflight-oidc-production-recovery-20260906.md)
records a provider-free malformed task check on the corrected receiver: the
request reached the application as a safe 400/`INVALID_REQUEST`, with zero
401s in the observed window, and no provider or owner work was invoked. Its
remaining `DONE_WITH_CONCERNS` item is the separately classified task-identity
act-as marker, not an application-code failure. The [stale-invoker cleanup
report](../investigations/preflight-stale-iam-cleanup-20260906.md) records the
post-cleanup private invoker and queue invariants.

These reports are existing evidence in main, not new production actions taken
by this audit. They establish a safe control-plane recovery boundary but do not
substitute for a new natural user retry after deployment.

### Current code/config contract

The current implementation provides the following production-safe boundaries:

- [`preflight-tasks.ts`](../../lib/services/analysis/preflight-tasks.ts) requires enabled, validated HTTPS configuration, the exact `/api/analysis/preflight/worker` path, an audience at the same origin, and a valid task service-account identity. Task creation uses a deterministic task name, an explicit OIDC audience/identity, and a bounded retry classification; error metadata is reduced to fixed codes and bounded names.
- [`worker/route.ts`](../../app/api/analysis/preflight/worker/route.ts) validates configuration and workload role before authorization or body processing, verifies the OIDC token against the configured audience and service-account email, strictly parses the bounded payload, and rejects invalid callers/bodies before domain work. Failure logs retain only category, retryability, HTTP status, bounded attempt, and the sanitized persistence operation/code when available.
- [`capacity/readiness/route.ts`](../../app/api/analysis/capacity/readiness/route.ts) is a dynamic, read-only `GET`; it creates no client, reads no user, touches no queue/provider, and returns `no-store`. Its readiness payload contains configuration fingerprints and booleans rather than task identities, credentials, or payloads.
- [`automatic-analysis-capacity-infra.test.ts`](../../scripts/automatic-analysis-capacity-infra.test.ts) covers exact preflight target/audience/identity wiring, producer-fingerprint drift, queue ordering, maintenance scheduler checks, staged/post-promotion provenance, and fail-closed behavior. The targeted run below passed all selected preflight cases.

The current contract therefore fixes the previously evidenced application/config
failure without introducing a provider fallback, a second queue, or a
production activation path. No code change was justified by the final gap
review.

## Administrator dashboard access and privacy contract

The scoped dashboard is [`/admin/analysis-audit`](../../app/admin/analysis-audit/page.tsx)
and the four private projections it actually fetches: analysis/order audit,
order detail, Apify account inventory, and landing leads. The page is dynamic,
requires a verified Supabase session, and requires the server-only
`ANALYSIS_AUDIT_OPERATOR_USER_IDS` allowlist. The API routes repeat session and
allowlist authorization before using service-role reads, return stable 401/403/
503 categories, and set `private, no-store` responses.

The workbench requests use same-origin credentials, `cache: no-store`, and an
explicit private/no-store request header. The routes and schemas bound rows,
cursors, query/body sizes, and status values. The landing-lead route additionally
strips raw input, hashes, claim fields, internal IDs, IPs, and user-agent data;
the UI does not render provider/source payloads, images, prompts, or tokens.
Account exclusion and paid-secondary refresh controls are present as explicit
operator actions, but neither action was invoked in this audit, so no provider
read, charge, or production mutation occurred.

The existing [admin console verification report](../../reports/admin-console-verification-20260908/report.md)
records the synthetic rendered matrix: responsive table containment, detail
navigation/focus restoration, accessibility headings/contrast, loading/empty/
partial/error/recovery states, stale-cursor fencing, unavailable-inventory
handling, and landing-lead request races. Those checks are supplemented here
by a fresh merged-main route/UI suite and production build.

The older bearer-key routes such as `/api/admin/analysis-observability` and
`/api/admin/token-usage` are not fetched by this console and are not counted as
dashboard dependencies. Changing their separate legacy contract would be an
unrelated refactor; no such gap was found in the scoped dashboard.

## Verification performed

All checks below ran from the exact main tip above with synthetic fixtures or
mocked service boundaries. No `.env` file was sourced or printed.

| Check | Result |
| --- | --- |
| Preflight/route/config focused Vitest selection | 24 files, 380 tests passed |
| Admin route/UI/contract Vitest selection | 22 files, 136 tests passed |
| Targeted capacity-infra preflight cases | 16 passed, 304 skipped by name filter |
| Release-readiness shell contract | `PASS: analysis V2 release readiness script contract` |
| `npm run lint` | 0 errors, 27 warnings (the audit introduced no source changes) |
| `npx tsc --noEmit` | passed |
| Synthetic production build | passed; route table includes the preflight worker, readiness endpoint, and admin console/projections |
| `bash -n` on deployment/configuration/readiness scripts | passed |
| `git diff --check` | passed |

The unfiltered capacity-infrastructure file is intentionally not claimed as a
full-suite pass: a bounded run produced progress but no completion summary and
was stopped after approximately nine minutes. The relevant preflight cases were
then selected by name and passed; the focused suites above are the acceptance
evidence for this audit.

## Excluded activation-only work

The following were deliberately not performed and remain follow-up gates rather
than code gaps:

- no Vercel/Cloud Run deployment, promotion, queue activation, or IAM mutation;
- no post-fix natural user preflight retry or B-lite cohort activation check;
- no real account canary and no provider charge;
- no payment or `payment_pending` mutation;
- no protected credential, cookie, raw identity, request/order UUID, or provider payload read/output;
- no attempt to clear the historical task-identity act-as concern without an
  independently approved IAM operation.

The correct next step, if activation is later authorized, is a separately
approved read-only observation of the deployed source/config fingerprint and a
sanitized aggregate of the next eligible preflight, followed by any canary
decision. This report does not authorize that step.

## Final result

No minimal missing code or test was identified. The worktree contains only this
report as a new artifact; the frozen landing copy and all preflight/admin source
files remain unchanged from `origin/main`.
