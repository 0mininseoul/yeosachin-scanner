# Owner-only production evidence collection amendment

Status: narrow amendment to the approved owner-only identity-epoch descriptor
preparation design; it is a planning boundary, not an activation authorization.

Date: 2026-09-14

Applies to:
`docs/superpowers/specs/2026-09-14-owner-only-identity-epoch-descriptor-preparation-design.md`

## Decision

The remaining production work is a prospective, owner-only evidence collection
window. It may use only the existing selectors and resources already enumerated
by the approved design. It must produce a fresh, bounded observation and may
reach the existing coordinator `VERIFIED` state plus the independent
`VERIFIED_OK` read-back, but it must terminate there.

This amendment does not add a resource-discovery fallback, a historical replay,
or a new evidence store. It does not authorize activation, reopening either
public admission gate, resuming a queue or scheduler, provider/user work, or a
real `0_min._.00` canary.

For the narrow unblock described below, this amendment supersedes only the
base design’s prohibition on logging-configuration mutation. The exception is
limited to the exact existing-resource selector bindings and the exact two
already-PAUSED queues; it does not broaden the base design’s mutation or
activation authority.

## Current blockers are not retrospective evidence

The current owner-only production preparation attempt is blocked with
`EVIDENCE_UNAVAILABLE`: the exact production resource bindings needed by the
packet are not available, and the existing paused-queue logging observation is
not at full sampling. This is an honest execution blocker, not evidence that
the queues were empty, that no work occurred, or that any past observation can
be reused.

The next run must start a new read-only observation after the exact bindings
and coverage prerequisites are independently confirmed. Existing reports,
including the post-W1A Supabase audit and migration-provenance reconciliation,
are planning context only; they do not satisfy the production zero-work gate.
No retrospective count, checksum, queue snapshot, log excerpt, or report may
be copied into a new production packet as if it were observed in the new
window.

## Existing-resource boundary

The collector is restricted to the following resources and selectors from the
approved design. Values, names, URLs, IDs, credentials, and raw manifests stay
inside the owner process and are never placed in this document or an Orca
message.

| Plane | Existing source | Permitted observation |
| --- | --- | --- |
| Vercel | The linked canonical project’s production deployment, alias, production environment metadata, and public readiness endpoint | Source/deployment linkage, allowlisted gate values, source fingerprint, and exact readiness booleans |
| Google Cloud | The exact Cloud Run services/revisions and build provenance selected by production configuration | Serving/staged revision, source/build identity, image provenance, runtime settings, and secret references |
| Google Cloud Tasks | The two packet-fixed production queues and their complete task listings | Queue identity/configuration, PAUSED state, pagination completion, and empty listing at fresh observation time |
| Google Cloud Scheduler | The packet-fixed recovery schedulers and the existing retention scheduler | Exact configuration, enabled/paused state, pause provenance, last-attempt coverage, and retention enabled state |
| Google IAM | Policies, service accounts, and key metadata attached to the selected resources | Pairwise role identity, keyless state, enabled state, and exact resource-scoped bindings |
| Supabase | The three fixed zero-work ledger selectors already required by the packet | Aggregate counts/checksums and coverage metadata only; no schema/data mutation |
| Cloud logging | The existing queue-scoped TaskActivityLog stream for the two packet-fixed queues | Sampling ratio, full baseline-to-verification interval, permissions, ingestion-lag coverage, and complete pagination |
| GCS | The existing epoch journal and lock namespace | Journal/lock state and fence continuity; no new bucket, object namespace, or sink |

Substring inventory and “first candidate” selection remain diagnostic only. A
descriptor value is valid only when the exact production selector resolves to
one resource and the resource points back to the same selector/project/scope.
Missing, duplicate, mixed-scope, or partially paginated results fail closed.

## Prospective collection protocol

### 1. Owner and source boundary

Run from a clean reviewed implementation/operations worktree while resolving
the linked Supabase project reference only through the canonical owner worktree
and the pinned authenticated CLI path required by the base design. Do not source
`.env` files, inspect unrelated worktrees, search Git history for credentials,
or accept a project/resource value from argv as an override.

The owner-only entry point must emit only the existing safe summary fields:
fixed status code, proposal/discovery digest, source fingerprint, bounded
reuse/create/pause counts, and validation booleans. Provider bodies, raw SQL,
tokens, cookies, service-account identity, UUIDs, URLs, and child stderr are
discarded or retained only in protected memory.

### 2. Binding inspection

`prepare inspect` performs a fresh read-only discovery. It must prove exact
Vercel, Cloud Run, queue, scheduler, IAM, ledger, TaskActivityLog, journal, and
lock bindings before it can produce a proposal. If any binding is missing or
ambiguous, it returns `EVIDENCE_UNAVAILABLE` or the approved fixed discovery
error and stops before mutation.

The collector must not create a queue, scheduler, log sink, logging exclusion,
table, view, schema, migration, or synthetic task to make a source appear
available. The known blocker may be addressed only by the separate unblock gate
below; `prepare inspect` itself remains read-only.

### 2.1 Exact existing-resource unblock gate

The implementation plan adds a pre-epoch owner-only `prepare unblock` operation
inside the existing CLI boundary. It is not an activation, resume, canary, or
general configuration command. Its complete invocation is:

```text
node --import tsx scripts/prepare-capacity-identity-epoch.ts prepare unblock --approved-digest "$UNBLOCK_DIGEST"
```

`$UNBLOCK_DIGEST` is the safe digest emitted by the immediately preceding
`prepare inspect` and independently approved; it is not a protected descriptor.
The operation re-reads the live before-state and refuses a stale digest before
any mutation. Its mutation allowlist contains exactly two classes:

1. Bind each missing selector field to the one already-existing production
   resource proven by the approved exact selector/resource/project/scope
   agreement. No selector is chosen by substring, first match, guessed name,
   or fallback inventory.
2. Set `stackdriverLoggingConfig.samplingRatio` to `1.0` on exactly the two
   packet-fixed existing paused queues, and on no other queue or logging object.

Before the operation, the owner records only a safe before-state digest,
allowlisted field count, exact queue count (`2`), and the intended after-state
policy. A separate visible reviewer approves those facts and the rollback
digest. The operator then performs the mutation through the existing
authenticated control-plane transport, reads every selector and queue back,
and requires the after-state digest to match the reviewed policy with no extra
field drift.

If read-back fails, an unexpected field changes, either queue is not still the
exact paused queue, or the after-state digest differs, the operator restores
the recorded before-state bindings and sampling values. Rollback is bounded to
those exact fields; it does not create/delete a resource, change a sink/schema,
resume a queue, open a gate, or compensate another mutation. A rollback failure
is a terminal stop requiring owner review, not a reason to retry blindly.

After a successful read-back, discard the old evidence and begin a fresh
baseline-to-verification window. The new window must observe the updated exact
selectors and sampling ratio; no pre-mutation count, checksum, queue listing,
or log result is carried forward as evidence.

### 3. Explicit preparation mutation gate

Evidence inspection and preparation mutation are separate operations. A future
`prepare apply` is allowed only after an independently reviewed proposal digest
and an explicit coordinator decision. Its mutation allowlist remains exactly
the base design: create only missing keyless service accounts when all reuse
rules fail, and pause only the enabled recovery scheduler(s) when all closed
gate/PAUSED queue/empty listing/retention separation checks pass.

The preparation operation must not create keys, change IAM grants, change
retention, change queues, change gates, deploy, or resume anything. It must not
repeat or broaden the exact selector/sampling unblock mutation above. It must
read each permitted mutation back and correlate the scheduler
pause with existing audit provenance. A partial mutation is not compensated by
an automatic resume or gate-open. An unused keyless account remains for a later
separate review, as required by the base design.

After a scheduler pause, `QUIESCENCE_PENDING` is an expected stop. Wait outside
the process for the configured grace window; do not sleep in the collector or
resume the scheduler. Re-run a fresh `prepare inspect` and then `epoch inspect`.

### 4. Fresh zero-work window

`epoch inspect` performs two sequential read-only passes with new authenticated
clients and without sharing protected raw values. Both passes must cover the
same current baseline-to-verification window and independently read:

- the three fixed Supabase ledgers;
- the complete TaskActivityLog stream for both exact queues;
- queue pagination and observation timestamps;
- pause/last-attempt provenance and ingestion-lag coverage; and
- the receiver/retention/readiness facts required by the existing validator.

TaskActivityLog is the task-creation source. Cloud Audit Logs alone are not a
zero-work proof. The two queue streams must show an independently observed
sampling ratio of `1.0`, complete pages, required permissions, and coverage of
the entire interval. Any missing sampling, queue scope, interval, permission,
page, watermark, Date header, or sink/bucket coverage is
`EVIDENCE_UNAVAILABLE`, including when all visible counts are zero.

No source is backfilled. The collector records only safe status and digests;
the raw observation is never written to a new sink, table, schema, ordinary
file, journal, environment variable, or report.

### 5. VERIFIED terminal boundary

Only after the two fresh proposal passes have the same packet/bootstrap/scope/
identity-graph digest may the coordinator approve `epoch apply` with the fixed
`--through VERIFIED` boundary. The inherited-FD bridge invokes the existing
check, existing coordinator through `VERIFIED`, and independent verifier in
that order. A successful run must end with coordinator `VERIFIED` and the
sanitized verifier result `VERIFIED_OK`.

`VERIFIED`/`VERIFIED_OK` is the terminal result of this amendment. It is not
permission to activate, resume, open, canary, or perform any provider or user
work. The packet must continue to show closed public gates, PAUSED queues and
recovery schedulers, and enabled retention.

## Decision gates and stop behavior

| Gate | Required observation | Stop if | Allowed recovery |
| --- | --- | --- | --- |
| Owner boundary | Authenticated owner sources, canonical worktree binding, pinned CLI, protected output boundary | Owner auth, scope, CLI version, or binding is unavailable | End with fixed owner/discovery code; retry only after a new read-only inspect |
| Exact resource binding | One-to-one selector/resource/project/scope match for every packet source | Missing, duplicate, mixed-scope, stale, or partial resource | End `EVIDENCE_UNAVAILABLE`/approved discovery error; do not guess or search a fallback |
| Queue evidence | Two exact queues, complete task pages, PAUSED state, TaskActivityLog sampling `1.0`, complete interval and lag coverage | Sampling is not full, a page/watermark is incomplete, or the queue selector is ambiguous | End `EVIDENCE_UNAVAILABLE` unless the separate reviewed unblock gate is being used; never create a synthetic task |
| Unblock mutation | Reviewed before-state digest, exact selector-binding allowlist, exactly two existing PAUSED queues, sampling after-state `1.0`, and rollback digest | Stale digest, non-PAUSED queue, extra field/resource change, failed read-back, or after-state drift | Roll back only the recorded selector/sampling fields; if rollback fails, stop for owner review |
| Supabase zero-work | All three fixed ledgers and existing validator coverage are readable in the fresh window | Missing table/permission/coverage or incomplete checksum | End `EVIDENCE_UNAVAILABLE`; do not create schema/sink/table or alter data |
| Preparation mutation | Approved digest, closed gates, PAUSED/empty queues, separated retention, independent review | Digest drift, failed read-back, unexpected mutation, or grace not mature | Leave gates/planes closed; no automatic compensation or resume |
| Two-pass proposal | Fresh packet/bootstrap/scope/identity graph digests match exactly | Any drift or mismatch | Discard protected values and restart from fresh inspect |
| VERIFIED read-back | Existing check/apply/verifier produce `VERIFIED` then `VERIFIED_OK` | Any pre-VERIFIED failure, drift, activation marker, or unsafe output | Stop; reconcile only through existing fail-closed rules, never activate |

## Explicit non-goals

- No retrospective evidence claim or reuse of prior production counts.
- No new schema, table, view, log sink, bucket, queue, scheduler, or migration.
- Logging changes are limited to the exact sampling-ratio change on the two
  existing paused queues; creating a logging sink/exclusion/resource or a
  synthetic task is forbidden.
- No selector binding outside the exact existing resources proven by the
  reviewed selector/resource/project/scope agreement.
- No Supabase migration repair, migration push, DDL, DML, or payment-state change.
- No Vercel/Cloud Run deploy, public gate opening, queue/scheduler resume, or
  provider/user work.
- No real `0_min._.00` canary and no landing-copy change.

## Audit context carried into the follow-up plans

The latest Supabase reports record 152 public base/partitioned tables after
W1A, six local-only and six remote-only migration versions, and exactly two
remote-only migration rows whose source remains unresolved. Those facts require
the separate Supabase contraction plan to remain fail-closed; they are not
production identity-epoch evidence and do not authorize a migration operation.
The contraction plan must preserve active/runtime/payment/operator contracts and
must not convert the old exact-22 target into a new arbitrary target.
