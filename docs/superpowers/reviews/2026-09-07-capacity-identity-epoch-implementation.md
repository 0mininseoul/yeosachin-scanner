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
| Actual ordinary-adapter replay | `automatic-analysis-capacity-infra.test.ts` runs the mapped shell entry points against the real supervisor/IPC adapter, including the provider-free test-only storage switch; the earlier acceptance run passed all 319 tests, while the latest bounded rerun is recorded below. Production selection remains authenticated GCS. |
| Genuine child authority | `exclusion-ipc.test.ts` covers role/generic precedence, queue/task-caller identity, Cloud Run service/IAM, project/queue IAM, scheduler, maintenance, retention, queue-absent maintenance, shared-SA overlap, and disjoint selectors. |
| Shared reservation lifecycle | `coordinator.test.ts` renews the journal and shared reservation across all seven operation intervals; resume and activation-precondition failures also prove the common reservation is released. |
| Partial renewal cleanup | `exclusion.test.ts` injects a failure on a later member and proves every owned member is deleted while preserving generation fencing. |
| Launcher reader/lifecycle | `exclusion-launcher.test.ts` proves one dispatcher serves child proxy traffic and release, turns a supervisor `FATAL` authority-loss event into detached child-group termination, and waits for a detached descendant group. |
| Low descriptors/direct Node import | `exclusion-shell-mapping.test.ts` checks all seven shell mappings, argv preservation, fixed FDs 4/5, and `node --import tsx` without `npx`. |
| Native/final mutation fence | Existing live vertical and platform tests cover deferred token minting, final adapter dispatch guards, durable abort/takeover, and provider-free postconditions. |
| Crash/recovery and no activation | Existing `live-vertical.integration.test.ts`, coordinator, journal, bridge, and integration suites cover retained mutations, takeover, recovery, abort, and `VERIFIED` without activation. |

## Verification evidence

Focused epoch verification passed:

```text
npm run test:identity-epoch -- --reporter=dot
22 test files, 259 tests passed
npx tsc --noEmit
passed
```

The complete actual-adapter replay passed independently in the earlier
acceptance run:

```text
npx vitest run scripts/automatic-analysis-capacity-infra.test.ts --reporter=dot
1 test file, 319 tests passed, 1150.12s
```

The correction pass reran it with an explicit wall-clock watchdog and
process-group TERM/KILL cleanup:

```text
bash -c 'set -o pipefail; replay_log=$(mktemp -t identity-adapter-replay.XXXXXX); start_epoch=$(date +%s); gtimeout --foreground --signal=TERM --kill-after=10s 120s npx vitest run scripts/automatic-analysis-capacity-infra.test.ts --bail=1 --reporter=verbose >"$replay_log" 2>&1; replay_code=$?; end_epoch=$(date +%s); elapsed=$((end_epoch-start_epoch)); remaining=$(pgrep -P $$ | tr "\n" " "); printf "ADAPTER_REPLAY_RESULT code=%s elapsed_seconds=%s remaining_children=%s log=%s\n" "$replay_code" "$elapsed" "${remaining:-none}" "$replay_log"; tail -n 100 "$replay_log"; exit 0'
ADAPTER_REPLAY_RESULT code=1 elapsed_seconds=24 remaining_children=none
319 tests ran: 318 passed; one unrelated external GitHub CI probe failed against the baseline commit
```

No child processes remained after the bounded replay; the external failure is
not caused by the identity-epoch changes and is not rewritten in unrelated
tests.

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
exited successfully with 27 warnings and no errors, and `git diff --check` passed.
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
infrastructure file passed 319/319 in the earlier unbounded acceptance run;
the latest bounded rerun is recorded above with one unrelated external CI
failure. This full repository command is therefore not claimed as passing,
while the focused identity-epoch and standalone actual-adapter gates are green.

## Reviewer-escalation correction pass

The correction pass added bounded post-commit fence/expiry checks and
generation-scoped cleanup for journal and shared-reservation renewals, full
Cloud Tasks/Scheduler wire drift checks, old-build identity/location coverage,
strict selector grammars shared with the supervisor shell, and canonical
Cloud Run metadata/traffic validation before stage writes. The protected
bootstrap now preflights all authenticated control-plane token boundaries,
constructs host-bound PostgREST from inherited descriptor credentials, and
requires injected independent Scheduler pause provenance rather than trusting
the mutable Scheduler `updateTime` field.

Focused RED/GREEN commands (all output is fixed-code/non-secret):

```text
RED     npx vitest run scripts/capacity-identity-epoch/journal.test.ts --reporter=dot
        renewal committed after expiry (expected rejection, received lease)
GREEN   npx vitest run scripts/capacity-identity-epoch/journal.test.ts --reporter=dot
        1 file, 16 tests passed
RED     npx vitest run scripts/capacity-identity-epoch/exclusion.test.ts --reporter=dot
        shared reservation renewal committed after expiry (expected rejection, received lease)
GREEN   npx vitest run scripts/capacity-identity-epoch/exclusion.test.ts --reporter=dot
        1 file, 10 tests passed
GREEN   npx vitest run scripts/capacity-identity-epoch/cloud-build.test.ts scripts/capacity-identity-epoch/platform.test.ts --reporter=dot
        regional old-build lookup and full Tasks/Scheduler contract suites passed
GREEN   npx vitest run scripts/capacity-identity-epoch/exclusion-launcher.test.ts --reporter=dot
        forged release, launcher authority loss, TERM/KILL timeout, and descendant join passed
```

The explicit diagnostic absence check remains:

```text
rg -n "DEBUG_ZERO_WORK|DEBUG_(WINDOW|SNAPSHOT|EVENT)|console\\.(log|error|debug)|ledger_watermarks|journalLeaseMs" scripts/capacity-identity-epoch scripts/run-capacity-identity-epoch.ts
no matches
```

## Live evidence and protected bootstrap correction

The live graph now uses the reviewed primary-source contract: Cloud Build
provenance for source/build, exact durable Supabase forbidden-event ledgers for
provider/billing/receiver evidence, Cloud Tasks queue logging for task audit, and
authenticated malformed receiver probes. Provider/billing/receiver evidence is
not derived from Cloud Run request URLs, so the two expected 400 probes do not
create false forbidden work; the fixture transport records a structured ledger
event when one is explicitly injected, and the exact verification result is
`ZERO_WORK_INCOMPLETE`.

PostgREST reads use the fixed packet-bound table/column selectors, exact-count
pagination, bounded time predicates, and the authenticated origin `Date`
header as the source observation time. No synthetic watermark table or
`ledger_watermarks` path exists; an empty page without a trustworthy current
server `Date`, a stale `Date`, an incomplete page, or a server-capped count
fails closed. Cloud Logging task-audit coverage remains gated on independently
observed queue logging configuration, full sinks/exclusions pagination, bucket
retention, and a real TaskActivityLog `receiveTimestamp` observed after the
frozen window; the implementation does not query or accept a custom watermark
marker. If the reviewed production source cannot provide that bounded-lag
receive timestamp without manufacturing work, the result is
`EVIDENCE_UNAVAILABLE` rather than `VERIFIED`.

The real CLI path now constructs a host-bound authenticated PostgREST transport
from the private inherited bootstrap descriptor's service-role Bearer and
required `apikey` (credentials stay in memory and are never put in journal
objects or output). A descriptor with reviewed live evidence but absent or
invalid private auth still fails during protected bootstrap construction before
GCS reservation, journal, or provider access; the focused regression asserts
zero requests/writes. Provider-free tests may inject an authenticated transport,
but the default descriptor path is exercised through a fake underlying fetch
transport and reaches `VERIFIED`.

The following focused red-green transcripts are retained with fixed, non-secret
failure descriptions:

```text
RED  npx vitest run scripts/capacity-identity-epoch/live-evidence.test.ts -t 'binds provider' --reporter=verbose
     1 failed: the legacy receiver-log selector was accepted (expected false, received true)
GREEN npx vitest run scripts/capacity-identity-epoch/live-evidence.test.ts -t 'binds provider' --reporter=verbose
      1 passed

RED  npx vitest run scripts/capacity-identity-epoch/live-evidence.test.ts -t 'zero-row|without a trustworthy|predates the requested|follows exact-count' --reporter=verbose
     4 focused contracts failed before the PostgREST Date/exact-count correction
GREEN npx vitest run scripts/capacity-identity-epoch/live-evidence.test.ts -t 'zero-row|without a trustworthy|predates the requested|follows exact-count' --reporter=dot
      focused contracts passed

RED  npx vitest run scripts/capacity-identity-epoch/cloud-build.test.ts --reporter=verbose
     3 focused contracts failed before the regional request, pagination, ambiguity, and provenance checks were implemented
GREEN npx vitest run scripts/capacity-identity-epoch/cloud-build.test.ts --reporter=dot
      3 passed

RED  npx vitest run scripts/capacity-identity-epoch/live-vertical.integration.test.ts -t 'private Supabase auth path' --reporter=dot
     1 failed: bootstrap resolved instead of rejecting without private Supabase auth
GREEN npx vitest run scripts/capacity-identity-epoch/live-vertical.integration.test.ts -t 'private Supabase auth path|host-bound Supabase' --reporter=dot
      focused auth/no-mutation and descriptor-auth paths passed

GREEN npx vitest run scripts/capacity-identity-epoch/live-vertical.integration.test.ts -t 'default production graph|structured receiver-work' --reporter=dot
      default graph reached VERIFIED; structured forbidden event rejected with ZERO_WORK_INCOMPLETE

RED  npx vitest run scripts/capacity-identity-epoch/live-vertical.integration.test.ts -t 'default production graph' --reporter=verbose
     1 failed before the default collector graph and host-bound evidence transport were wired
GREEN npx vitest run scripts/capacity-identity-epoch/live-vertical.integration.test.ts -t 'default production graph' --reporter=dot
      1 passed with missingEvidence=[] and VERIFIED

CHECK rg -n -e 'DEBUG_ZERO_WORK' -e 'DEBUG_(WINDOW|SNAPSHOT|EVENT)' -e 'console\\.(log|error|debug)' scripts/capacity-identity-epoch scripts/run-capacity-identity-epoch.ts
      no matches
CHECK rg -n 'ledger_watermarks|watermarkTable|readSupabaseWatermark' scripts/capacity-identity-epoch scripts/run-capacity-identity-epoch.ts
      no matches
```

## Provider selector grammar parity correction

Cloud Tasks queue IDs and Cloud Scheduler job IDs now use their distinct
provider grammars in TypeScript, the exclusion bridge, and ordinary shell
validators. Queue IDs accept uppercase letters and hyphens only, from 1 to
100 characters; Scheduler job IDs accept uppercase letters, digits, hyphens,
and underscores, from 1 to 500 characters.

```text
RED  npx vitest run scripts/capacity-identity-epoch/exclusion-ipc.test.ts -t 'distinct Cloud Tasks queue' --reporter=dot
     1 failed: Queue_Name was accepted (expected ADAPTER_REQUEST_INVALID)
RED  npx vitest run scripts/capacity-identity-epoch/exclusion-shell-mapping.test.ts -t 'provider grammar' --reporter=dot
     1 failed: ordinary shell queue validator did not contain the provider pattern
GREEN npx vitest run scripts/capacity-identity-epoch/exclusion-ipc.test.ts scripts/capacity-identity-epoch/exclusion-shell-mapping.test.ts -t 'distinct Cloud Tasks queue|provider grammar' --reporter=dot
      2 files, 2 focused tests passed; 101-character queue and 501-character Scheduler job rejected
```

The protected Cloud Run body validator also binds metadata generation and
resourceVersion to the reviewed old observation and binds the candidate
revision name to the packet-derived desired revision before any PUT.

```text
RED  npx vitest run scripts/capacity-identity-epoch/live-vertical.integration.test.ts -t 'metadata or revision drift' --reporter=dot
     1 failed: resourceVersion drift was accepted
GREEN npx vitest run scripts/capacity-identity-epoch/live-vertical.integration.test.ts -t 'metadata or revision drift' --reporter=dot
      1 focused test passed
```

## Remaining limitations

- No provider-backed or production evidence was collected in this worktree.
- Production execution remains fail-closed unless the private inherited
  bootstrap descriptor supplies the reviewed Supabase service-role Bearer and
  `apikey`; no environment discovery, credential rotation, or alternate
  credential system is used.
- The local supervisor fixture uses in-memory reservation/raw-lock storage;
  production GCS authentication and provider IAM remain outside this acceptance.
- External review, merge, deploy, activation, and any real canary remain
  intentionally out of scope.
