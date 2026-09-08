# Coordinated capacity identity-epoch local acceptance

Date: 2026-09-08 (Asia/Seoul)

This is a non-secret local acceptance record for the coordinated identity-epoch
candidate. It contains fixture names and safe status only; it intentionally does
not contain credentials, cookies, user/order identifiers, protected resource
values, provider payloads, or production observations.

## Scope and boundaries

- Tasks 5-11 are covered by provider-free unit, actual-adapter, subprocess, and
  live-vertical fixture tests in `scripts/capacity-identity-epoch`.
- The candidate does not run a production observation, mutation, activation,
  deployment, canary, paid provider, Supabase operation, or credential-bearing
  command.
- Landing-page copy was not changed.

## Acceptance map

| Gate | Local evidence |
| --- | --- |
| Journal sequence advancement after an awaited credential | `gcs.test.ts` drives `GcsJournalStorage` against an in-memory GCS transport, advances the same-owner sequence while the first token is blocked, expects `JOURNAL_INVALID`, and proves only the winning journal POST exists. |
| Actual selector union | `exclusion-supervisor.test.ts` starts the actual supervisor adapter twice: parent-only role-deployer rejects the nested maintenance selector; the derived parent+nested resource union returns `ADOPTED`. |
| Actual ordinary-adapter replay | `automatic-analysis-capacity-infra.test.ts` runs the mapped shell entry points against the real supervisor/IPC adapter, including the provider-free test-only storage switch; all 319 tests pass. Production selection remains authenticated GCS. |
| Genuine child authority | `exclusion-ipc.test.ts` covers role/generic precedence, queue/task-caller identity, Cloud Run service/IAM, project/queue IAM, scheduler, maintenance, retention, queue-absent maintenance, shared-SA overlap, and disjoint selectors. |
| Shared reservation lifecycle | `coordinator.test.ts` renews the journal and shared reservation across all seven operation intervals; resume and activation-precondition failures also prove the common reservation is released. |
| Partial renewal cleanup | `exclusion.test.ts` injects a failure on a later member and proves every owned member is deleted while preserving generation fencing. |
| Launcher reader/lifecycle | `exclusion-launcher.test.ts` proves one dispatcher serves child proxy traffic and release, then waits for a detached descendant group. |
| Low descriptors/direct Node import | `exclusion-shell-mapping.test.ts` checks all seven shell mappings, argv preservation, fixed FDs 4/5, and `node --import tsx` without `npx`. |
| Native/final mutation fence | Existing live vertical and platform tests cover deferred token minting, final adapter dispatch guards, durable abort/takeover, and provider-free postconditions. |
| Crash/recovery and no activation | Existing `live-vertical.integration.test.ts`, coordinator, journal, bridge, and integration suites cover retained mutations, takeover, recovery, abort, and `VERIFIED` without activation. |

## Verification evidence

Focused epoch verification passed:

```text
npm run test:identity-epoch -- --reporter=dot
20 test files, 210 tests passed
npx tsc --noEmit
passed
```

The complete actual-adapter replay also passed independently:

```text
npx vitest run scripts/automatic-analysis-capacity-infra.test.ts --reporter=dot
1 test file, 319 tests passed, 1503.99s
```

The red-green correction behind this replay was bounded to the ordinary
subprocess bridge: the shell wrapper now removes its two selector arguments
before forwarding child argv, and the supervisor serializes only the adopted
child resource members (and only its applicable legacy leases) instead of
returning the parent union evidence. The provider-free storage switch is
accepted only when both Vitest and its explicit test-storage marker are set;
the production supervisor still constructs authenticated GCS storage.

The focused selector, supervisor, launcher, GCS, exclusion, lease-capability,
and coordinator runs were also repeated independently while implementing the
red-green-refactor changes. Shell scripts pass `bash -n` checks, `npm run lint`
exited successfully with 26 existing warnings, and `git diff --check` passed.
The default `npm run build` correctly failed closed because this worktree has no
Supabase environment; a second build with synthetic process-only Supabase
placeholders completed successfully and did not read `.env.local`.

`npm audit --audit-level=high` exited with two moderate advisories and no high
or critical advisory (`@humanfs/node` and `fflate`); no audit fix was applied.
The repository-wide `npm test -- --reporter=dot` reached its final summary after
3273.02s: 794 passed tests, 30 failed tests, and 2 skipped tests across 805
files (9 failed suites). The failures were unrelated PGlite hook/test timeouts,
two historical-terminalizer assertions, and automatic-infra subprocess
timeouts under full-suite parallel resource contention; the same automatic
infrastructure file passes 319/319 when run independently above. This full
repository command is therefore not claimed as passing, while the focused
identity-epoch and standalone actual-adapter gates are green.

## Remaining limitations

- No provider-backed or production evidence was collected in this worktree.
- The local supervisor fixture uses in-memory reservation/raw-lock storage;
  production GCS authentication and provider IAM remain outside this acceptance.
- External review, merge, deploy, activation, and any real canary remain
  intentionally out of scope.
