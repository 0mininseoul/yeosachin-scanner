# Coordinated capacity identity epoch roll-forward design

Status: approved implementation baseline

Date: 2026-09-07

Base: exact `origin/main` checkout at the start of this design task

## Objective

Define an implementation-ready, fail-closed migration for the preflight and
paid workload identity planes when the current live preflight identity set
overlaps identities intended for the other role. The migration creates one
coordinated identity epoch, proves the complete authentication chain before
activation, and preserves the ordinary per-role apply contract.

This is a design document only. It authorizes no production, cloud, provider,
queue, scheduler, IAM, Vercel, Supabase, payment, or user-data mutation. The
implementation plan must use test-only identities and fake providers for all
automated verification. The final real canary remains a user-run operation and
is deliberately not performed by this work.

## 1. Problem statement and boundaries

The current live preflight service has a prior task/runtime identity set whose
members overlap identities that the desired cross-role configuration assigns to
the paid plane. The existing exceptional path rotates only preflight and
requires the desired workload identities to be pairwise disjoint before any
mutation. A sequential preflight-only rotation therefore cannot satisfy its
own guard: rotating one role first either leaves a cross-role alias in place or
requires temporarily weakening the separation invariant.

The safe current behavior is fail-closed. The guard rejects the attempted
rotation before provider work, billable work, user work, or ambiguous IAM
repair. The migration must preserve that safety while providing one reviewed
way to move both roles to a new identity epoch. It must not turn a paid
exception into a general-purpose override, and it must not make the ordinary
per-role apply path less strict.

The scope is the coordinated transition of the two workload roles, their
authentication contracts, their queues and recovery schedulers, their staged
revisions, producer fingerprints, and the public readiness admission signal.
It does not redesign workload processing, provider budgets, payment state,
retention policy, or application business logic.

## 2. Options and decision

### Option A: coordinated dual-role epoch transition (chosen)

Create one generation-bound epoch for both roles. Capture exact old and
desired manifests, close producer and provider admission, pause both work
planes, stage both revisions without traffic, align producer fingerprints,
align desired OIDC and IAM with compare-and-swap etags, promote the captured
revisions, remove retired grants only after both planes are exact, verify a
provider-free system, and activate only after the public readiness contract
proves admission enabled.

Advantages:

- The pairwise-disjoint invariant is evaluated over the complete desired set,
  so the collision is solved without an intermediate invalid state.
- One lock, one journal, one epoch, and one activation fence make crash
  recovery and audit reconstruction deterministic.
- Queue and scheduler quiescence prevents a task created by an old producer
  from racing identity changes.
- Ordinary per-role checks remain authoritative outside the explicitly scoped
  coordinator capability.

Costs:

- Both roles must be quiesced together, so the migration has a larger
  maintenance window than a normal role deployment.
- The operator must prepare complete evidence for both roles, including two
  queues, two recovery schedulers, both producer fingerprints, and both
  revision chains.
- A partial IAM mutation cannot be automatically guessed back to the old
  state; recovery must remain closed and complete the reviewed epoch or begin
  a new reviewed epoch.

### Option B: globally weaken identity separation

Permit the old preflight identity to alias a desired paid slot, or allow
ordinary apply to bypass the pairwise-disjoint check during a rollout.

Rejected. This would erase the boundary the guard is intended to protect,
make a valid token ambiguous between roles, widen the blast radius of a
configuration error, and cause ordinary deployments to inherit a migration
exception. It also makes rollback unsafe because the old and desired role
graphs would no longer have a single unambiguous owner.

### Option C: stay closed

Keep the current fail-closed state and do not rotate identities.

This is safe in the short term and remains the fallback when any precondition
is missing. It does not restore the desired preflight-plus-paid capacity,
cannot resolve the existing collision, and leaves the paid identity migration
unavailable indefinitely. It is the correct outcome for an aborted or failed
epoch, but not the desired completed transition.

The decision is Option A, with Option C as the mandatory failure behavior.

## 3. Identity model and invariants

The design uses abstract role-slot names. Concrete service-account identities,
project identifiers, queue resource names, scheduler names, URLs, manifests,
and credentials are protected release inputs and never appear in this file,
the journal, or ordinary logs.

The complete workload identity slot set is exactly:

| Role | Slot | Purpose |
| --- | --- | --- |
| `preflight` | `task-caller` | OIDC caller presented by the preflight queue to its receiver |
| `preflight` | `enqueuer` | producer identity allowed to create preflight tasks |
| `preflight` | `runtime` | attached identity of the preflight worker runtime |
| `preflight` | `maintenance` | recovery-scheduler OIDC identity for the preflight plane |
| `paid` | `task-caller` | OIDC caller presented by the paid queue to its receiver |
| `paid` | `enqueuer` | producer identity allowed to create paid tasks |
| `paid` | `runtime` | attached identity of the paid worker runtime |
| `paid` | `maintenance` | recovery-scheduler OIDC identity for the paid plane |

The build identity is a separate non-workload slot named `build`. It is
validated against the same project boundary and must be distinct from every
one of the eight workload identities.

The following invariants are hard gates for every transition and postcondition:

1. The eight desired workload identities, one for each slot in the table,
   are pairwise distinct.
2. The desired build identity is distinct from all eight desired workload
   identities.
3. An identity that is unchanged across the epoch is allowed only when it
   remains in the exact same role and slot and has no alias in any other role
   or slot. Equality in a different slot is a failure, even when the identity
   is otherwise trusted.
4. Any identity that was shared by old slots, or any identity retired by the
   desired manifest, is absent from every desired slot. Retired identities
   are not silently reassigned.
5. No old service account is deleted as part of this rollout. Old accounts
   remain available for reviewed post-rollout cleanup, which is out of scope.
6. Every identity belongs to the exact intended project. Malformed,
   cross-project, wildcard, user-managed-key, or otherwise unparseable
   identity input fails closed.
7. Provider admission and producer admission are false for all preparation and
   migration states. Aggregate readiness is never used as a substitute for
   the explicit provider-admission signal.
8. Both queues and both recovery schedulers remain paused and empty while
   identity and revision mutations are in progress. Retention remains
   enabled.
9. No provider, billable, or user work occurs before the pre-activation
   verification completes. A malformed authenticated probe is allowed only
   when it returns a reviewed 4xx before provider admission.
10. Each mutation is preceded by a fresh generation and etag proof and is
    followed by a read-back postcondition. A stale owner or stale observation
    cannot mutate the next epoch.

## 4. Exact manifests and protected release packet

The coordinator accepts exactly two complete role-slot manifests: an old
manifest describing the observed live contract and a desired manifest
describing the complete next epoch. Both are required even when a slot is
unchanged. The manifests are exact protected inputs; an absent, blank,
synthetic, partial, or caller-asserted replacement is invalid.

Each manifest contains the following records, with concrete values supplied
through the protected operator channel rather than copied into source,
documentation, the journal, or logs:

| Record | Required content |
| --- | --- |
| `roleSlots` | Exactly the eight role-slot keys above, each mapped to one exact identity and its owning project. |
| `build` | One exact build identity and its owning project. |
| `source` | Exact old and desired source SHAs and immutable platform revision identifiers for each role. |
| `producer` | Exact producer configuration fingerprint version and digest for each role, plus the exact Git-backed Vercel source SHA selected as producer evidence. |
| `queues` | The exact protected resource identity for each role, its project/location binding, observed generation, etag, and PAUSED/empty proof. |
| `recoverySchedulers` | The exact protected resource identity for each role, paused state, pause epoch, location, and last-attempt evidence. |
| `retention` | The retention scheduler/resource proof and enabled state. |
| `iam` | The expected role-scoped OIDC, invoker, enqueuer, runtime, maintenance, and actAs bindings for both planes, represented by protected values and their canonical digest. |
| `readiness` | Readiness schema version 3, public origin binding, both producer fingerprints, and the admission state proof. |

The old manifest and desired manifest have the same fixed shape. Their
`roleSlots` arrays contain exactly these eight ordered keys and no optional
slot: `preflight.task-caller`, `preflight.enqueuer`,
`preflight.runtime`, `preflight.maintenance`, `paid.task-caller`,
`paid.enqueuer`, `paid.runtime`, and `paid.maintenance`. Each entry has one
exact identity, one owning-project assertion, and one canonical slot digest.
The old manifest additionally carries the observed live generation/etag and
serving revision for each resource; the desired manifest carries the reviewed
target generation-independent contract and the captured immutable revision
plan. Both carry a single build record and the complete source, producer,
queue, scheduler, retention, IAM, and readiness records above. A manifest
with a missing slot, duplicate slot, additional slot, unresolved identity,
or unresolved project is rejected before `PREPARED`.

The old manifest is observed, not inferred from environment configuration.
The desired manifest is reviewed before the epoch starts and must be resolved
to concrete values at runtime. Project validation checks both manifests and
rejects a value that merely has a valid shape but belongs to another project.

The release packet records the canonical digest of each complete manifest and
the digest of the protected packet as a whole. The journal records only those
digests, slot-key names, state markers, and allowlisted proof markers. An
implementation must never print or persist the actual identity, URL, queue,
scheduler, project, task body, manifest, or credential value.

### 4.1 Manifest comparison rules

The coordinator canonicalizes role-slot keys in the fixed table order and
compares exact strings only inside the protected execution boundary. It then
proves:

- all eight desired identities are distinct;
- the desired build identity differs from all eight;
- each unchanged old-to-desired equality is at the same single slot;
- each old shared identity and each retired identity is absent from the whole
  desired set;
- all old and desired identities are in the intended project;
- old observed source/revision and desired source/revision are exact captured
  values, never a mutable `latest` selector; and
- both old and desired producer fingerprints are bound to the corresponding
  Git-backed source SHA and role.

The proof emits only a boolean result, an allowlisted failure code, and a
non-secret digest. The actual values remain protected.

## 5. Preconditions and evidence proofs

The coordinator cannot enter `PREPARED` until every proof below succeeds in
one bounded read-only admission pass. A later mutation boundary revalidates
the relevant generation and etag immediately before mutation; the initial
proof is not a lease over cloud state.

### 5.1 Capability and source proof

- The caller presents the reviewed coordinator capability for the two-role
  epoch. The capability binds the epoch identifier, role set, desired-manifest
  digest, and one lock namespace. It cannot be minted by a normal role
  deploy command and cannot be represented by a boolean environment flag.
- Ordinary per-role `check`, `apply`, bootstrap, and expansion behavior remains
  unchanged. The existing preflight-only exceptional flag remains valid only
  for the already reviewed preflight path. A paid invocation of that flag is
  rejected before any observation or mutation. Paid exceptional rotation is
  accepted only through this exact coordinated capability.
- The old source SHA and immutable serving revision for each role are read
  from the platform and compared to the old protected manifest. The desired
  source SHA and captured immutable staged revision are compared to the
  desired protected manifest. Any mismatch fails closed.
- The producer proof includes the exact Git-backed Vercel SHA selected for the
  serving producer and the exact producer configuration fingerprint for each
  role. A project environment listing, a mutable alias, or a next-deploy
  environment value is not active-producer evidence.

### 5.2 Identity and project proof

- Resolve all eight old and all eight desired role-slot values from the
  protected manifests and validate them against the provider's strict
  identity grammar.
- Resolve the old and desired build identities and validate the same project
  boundary.
- Compare identities as normalized provider resource identities, not display
  labels. Reject case, project, domain, or resource-kind drift.
- Prove the seven set conditions in section 4.1, including the current live
  shared-identity collision. No identity is deleted by this proof.

### 5.3 Queue and scheduler quiescence proof

For each abstract role plane, observe the exact protected queue resource and
prove all of the following without creating, deleting, retrying, acknowledging,
or replaying a task:

- queue state is `PAUSED`;
- the complete queue listing is empty, not merely a zero approximate count;
- the queue's project, location, generation, and etag match the protected
  resource proof; and
- the queue target, audience, and caller contract match the old manifest.

Observe the exact recovery scheduler for each role and prove:

- state is `PAUSED`;
- the pause epoch is a strict, non-future epoch older than the configured
  request-timeout-plus-grace quiescence window;
- no attempt occurred inside that window; and
- the job target, location, and OIDC contract match the old manifest.

Retention is independently observed and must remain enabled. A retention
proof does not authorize a recovery scheduler to resume and does not replace
the two recovery pause proofs.

If either queue is non-empty, either recovery scheduler is not provably
quiescent, or retention is disabled, the coordinator remains closed. It may
wait for an operator-managed safe drain, but it must not purge, replay, or
silently discard work to manufacture an empty proof.

### 5.4 Readiness v3 and producer admission proof

The public readiness DTO is upgraded to a strict, PII-free schema version 3
before this epoch is attempted. The exact consumer contract is:

```text
schemaVersion: 3
ready: boolean
providerAdmissionEnabled: boolean
preflightProducerConfigFingerprintVersion: string | null
preflightProducerConfigFingerprint: lower-case SHA-256 hex digest | null
preflightProducerConfigReady: boolean
paidProducerConfigFingerprintVersion: string | null
paidProducerConfigFingerprint: lower-case SHA-256 hex digest | null
paidProducerConfigReady: boolean
```

The field names above are the complete public readiness key set for this
contract. The DTO contains no identity strings, project identifiers, queue or
scheduler names, URLs, task bodies, user IDs, provider IDs, run IDs, raw error
messages, or log fragments. Fingerprints are computed by the serving runtime
from its own canonical role configuration; callers cannot submit a tuple or
identity to make the proof pass.

`ready` is the aggregate readiness result used by existing consumers. It may
be false for any aggregate reason and must never be interpreted as proof that
provider admission is enabled. `providerAdmissionEnabled` is an independent
boolean admission fact consumed explicitly by the coordinator and release
checker. During `PREPARED` through `VERIFIED` it must be false. At activation,
the coordinator must publicly observe it as true before resuming recovery
schedulers or queues.

The preflight and paid fingerprint versions and digests must each match the
desired protected producer manifest and the exact Git-backed Vercel source
SHA. Missing, malformed, duplicate, or mismatched fields fail closed. The
readiness client, release checker, and tests must reject unknown keys and must
test `ready` and `providerAdmissionEnabled` independently.

### 5.5 Provider-free probe proof

After authentication succeeds, send only reviewed malformed-body probes to the
private role receivers. Each receiver must return its documented 4xx response
before task creation, provider admission, billing, or user-work creation.
The probe contract is provider-free, bounded, and non-retrying. A 2xx, 5xx,
unexpected 4xx, provider ledger row, billable operation, task, or user-work
row fails verification. The probe does not contain a real target, account,
provider run, or user identifier.

## 6. Architecture

### 6.1 Top-level coordinator

The implementation adds one top-level coordinator for the two-role epoch. It
owns the state machine in section 7 and is the only component allowed to use
the paid exceptional rotation capability. Per-role deploy commands remain
available and continue to execute their ordinary guards; they cannot join an
active epoch or mutate an epoch-owned resource while the coordinator lock is
held.

The coordinator has four boundaries:

1. **Protected input boundary**: loads exact manifests, capability, and
   release packet metadata; computes non-secret canonical digests; never emits
   protected values.
2. **Observation boundary**: reads platform, queue, scheduler, IAM, revision,
   Vercel, readiness, and ledger facts; returns typed facts plus generation and
   etag tokens.
3. **Mutation boundary**: acquires or renews the single lock, revalidates the
   expected generation/etag immediately before a mutation, performs one
   idempotent mutation, and reads the postcondition before advancing.
4. **Activation boundary**: proves the public admission bit, resumes both
   recovery schedulers and both queues, and records activation only after all
   four resources are in the expected state.

No boundary accepts a caller-supplied identity, URL, task body, provider run,
or user identifier as proof. Every external value is compared to the
protected manifest or to an independently observed public/runtime fingerprint.

### 6.2 Single generation-bound deploy lock

The coordinator acquires one private deploy lock bound to:

- the epoch identifier and desired-manifest digest;
- both role keys;
- the current resource-generation digest;
- an owner token digest;
- a monotonically increasing fencing token; and
- a bounded expiry and renewal deadline.

All epoch mutations carry the fencing token and expected generation/etag. A
stale owner, expired lease, mismatched capability, or different manifest
digest is rejected. A per-role lock cannot substitute for this lock because it
would permit the two roles to observe different epochs.

### 6.3 Durable private epoch journal

The journal is private, durable, append-only for transitions, and accessible
only to the coordinator and authorized operators. It stores no secret or
operational payload. It stores only non-secret hashes, state markers, bounded
timestamps, allowlisted reason codes, and proof outcomes. See section 8 for
the schema and recovery rules.

The journal is not the source of truth for cloud state. It is a resume ledger.
Every resume reads the current resource and readiness state again, then
decides whether the recorded transition remains valid.

## 7. State machine

The coordinator may advance only in the order shown below. A state is entered
after its entry evidence is durable. A state may be retried idempotently when
the same epoch, lock fence, manifest digest, resource generations, and etags
still hold. Any unrecognized evidence or external drift fails closed.

### `PREPARED`

**Entry evidence**

- The coordinator capability is valid and binds both roles and the desired
  manifest digest.
- The old and desired manifests are complete and exact, with all eight slots,
  build identity, source/revision records, producer fingerprints, queue and
  scheduler records, retention proof, IAM expectations, and readiness v3
  contract.
- Identity/project, pairwise-disjoint, build-distinct, unchanged-slot, and
  retired/shared-identity proofs pass.
- Exact old source SHAs/revisions, Vercel Git-backed SHA, both producer
  fingerprints, queue PAUSED/empty proofs, both aged scheduler pause proofs,
  retention enabled, and readiness v3 admission false are observed.
- The single lock is acquired and the initial generation/etag digest is
  recorded.

**Allowed mutations**

None. This state is read-only admission and journal initialization. No
deployment, IAM, queue, scheduler, provider, or readiness mutation is allowed.

**Completion evidence**

The journal records the canonical old/desired manifest digests, source and
resource proof digests, lock fence, and `PREPARED` marker. The public
readiness proof still shows `providerAdmissionEnabled: false`.

**Retry and idempotency**

Repeating preparation with the same epoch and digest returns the existing
prepared record after revalidating all proofs. A missing or changed proof
starts no mutation; the coordinator remains closed and emits one bounded
reason code.

**Fail-closed behavior**

Any missing manifest, identity collision, project mismatch, queue task,
unaged pause, disabled retention, source drift, Vercel/fingerprint mismatch,
readiness schema mismatch, or lock race stops before `STAGED`.

### `STAGED`

**Entry evidence**

`PREPARED` is complete, provider and producer admission remain false, and the
two role deployment inputs resolve to the desired source SHAs and immutable
revision plan. The readiness v3 deployment, if required by the release, is
already serving with admission false and its exact public schema is observed.

**Allowed mutations**

- Build or deploy one exact no-traffic revision for each role using the
  desired runtime/build manifests and pinned inputs.
- Bind the desired role, gate, and non-secret fingerprint configuration to
  those revisions.
- Perform no traffic promotion, queue resume, scheduler resume, IAM grant
  removal, provider call, or user-work mutation.

Each deployment mutation is preceded by a fresh service generation/etag proof
and exact source/build proof. The revision selector is the captured immutable
revision, never a mutable latest selector.

**Completion evidence**

- Both exact desired revisions exist and receive no traffic.
- Each revision reports the desired role and admission gates false.
- Each staged revision's source SHA, runtime manifest digest, build manifest
  digest, and non-secret fingerprint digest match the protected packet.
- The public readiness v3 endpoint remains PII-free and reports admission
  false.

**Retry and idempotency**

If the captured revision already exists with the exact digest and no traffic,
the coordinator reuses it. A same-name or same-source revision with any
different manifest, role, or gate is not adopted. A failed build can be
retried only with the same protected inputs; an ambiguous platform result is
resolved by read-back, not by submitting a second uncontrolled deployment.

**Fail-closed behavior**

Any traffic, latest selector, source drift, gate-on revision, producer
admission, or generation race leaves both roles closed. The coordinator does
not promote a partial pair.

### `PRODUCERS_CLOSED_ALIGNED`

**Entry evidence**

Both staged revisions are exact and no-traffic. Public readiness v3 reports
`providerAdmissionEnabled: false`. Both producer planes are bound to the
desired Git-backed source SHA and desired role fingerprints, but no producer
may create work.

**Allowed mutations**

- Close or reassert the Vercel producer/provider admission gate.
- Deploy or select the reviewed producer revision that emits both desired
  producer fingerprints while keeping admission false.
- Update only the protected, reviewed non-secret producer fingerprint
  configuration required to match the desired manifests.

Do not create a task, send a probe task, enable provider admission, rotate IAM,
promote a worker, resume a scheduler, or run a paid provider.

**Completion evidence**

- The selected READY producer deployment reports the exact Git-backed source
  SHA required by the packet.
- Preflight and paid fingerprint version/digest pairs match their desired
  manifests exactly.
- Public readiness v3 is the same strict key set, remains PII-free, and
  reports admission false.
- A read-only producer and queue check sees no newly created task.

**Retry and idempotency**

Re-reading an already aligned producer is a no-op. A failed producer deploy
is recovered by selecting the exact captured deployment or retrying the same
reviewed source, never by following a mutable alias. If the public source SHA,
fingerprint, or schema changes, return to the last safe closed state and
require a fresh proof.

**Fail-closed behavior**

Any missing fingerprint, aggregate/admission ambiguity, public schema drift,
unexpected producer source, or task creation leaves admission false and blocks
the next state.

### `QUEUES_ALIGNED`

**Entry evidence**

`PRODUCERS_CLOSED_ALIGNED` is complete. Both exact queue resources are
observed PAUSED and empty; both exact recovery schedulers are PAUSED with
aged pause epochs; retention is enabled; and no recovery attempt occurred in
the quiescence window.

**Allowed mutations**

- Reassert PAUSED on either queue or recovery scheduler when the observed
  resource is still the expected generation and etag.
- Refresh a bounded read-only empty and quiescence proof.

Do not purge tasks, acknowledge tasks, enqueue synthetic tasks, resume a
scheduler, resume a queue, disable retention, or mutate work payloads. If a
queue is non-empty, wait only for an operator-managed safe drain or abort.

**Completion evidence**

The complete queue listings are empty and both queues remain PAUSED. Both
recovery schedulers remain PAUSED with pause epochs older than the configured
window. Retention remains enabled. The postcondition records fresh generation
and etag digests.

**Retry and idempotency**

Repeated pause operations are no-ops when the resource is already PAUSED.
Empty and scheduler-age proofs are re-read on every retry. A changed
generation, recent scheduler attempt, or new task invalidates the proof and
requires revalidation from `PRODUCERS_CLOSED_ALIGNED`.

**Fail-closed behavior**

The coordinator cannot rotate IAM or deploy traffic while either queue or
recovery scheduler is not provably quiescent. It does not manufacture
emptiness by deletion.

### `INVOKERS_ROTATED`

**Entry evidence**

Both producers are closed and aligned, both queues/schedulers are paused and
empty/quiescent, retention is enabled, and both staged revisions are exact.
The current IAM etags and policy generations are freshly observed.

**Allowed mutations**

Using compare-and-swap etags and one lock fence:

1. Add the desired role-scoped OIDC, enqueuer, runtime, maintenance, and
   required actAs bindings for both role planes. Retain old invoker and
   enqueuer grants temporarily; they are not yet retired in this state.
2. Read back each policy and prove that the desired bindings are exact, scoped
   to the intended project/resource, and cannot cross roles.

Every IAM mutation is one bounded CAS operation with an immediate read-back.
Unrelated bindings are not replaced. No traffic, queue, scheduler, provider,
or admission mutation is allowed in this state.

**Completion evidence**

- Both role IAM policies contain the exact desired grants. Old
  invoker/enqueuer grants may still be present until both exact revisions are
  promoted; their removal is a later postcondition of `SERVICES_PROMOTED`.
- Desired task caller, enqueuer, runtime, and maintenance identities are
  bound only to their exact role/slot resources.
- IAM etag/policy-generation postconditions match the expected new state.
- Public admission remains false and both work planes remain paused.

**Retry and idempotency**

If the desired additions are already exact, the operation is a no-op. If
desired grants were added partially, re-read the policy and complete only the
missing reviewed additions with the new etag. Old-grant removal is not part of
this state. If a CAS fails, do not retry with the stale etag; re-observe and
either prove the desired additions or stop.

**Fail-closed behavior**

There is no automatic IAM rollback. A partial policy is not treated as safe
for activation. Keep admission false, queues/schedulers paused, and the
staged revisions no-traffic; record the bounded failure and require a resumed
epoch or a new reviewed epoch after operator inspection. Restoring the old
policy blindly could reintroduce the identity collision or grant an ambiguous
role.

### `SERVICES_PROMOTED`

**Entry evidence**

`INVOKERS_ROTATED` is complete, both desired IAM policies are exact, the
queues and schedulers are still paused, provider admission is false, and each
staged revision is bound to an immutable desired source SHA and revision ID.
Retired old invoker/enqueuer grants may still exist at entry; retaining them
until both role revisions are exact prevents an invocation gap during the
promotion boundary.

**Allowed mutations**

- Promote exactly the captured staged revision for preflight.
- Promote exactly the captured staged revision for paid.
- After both promotions have been read back as exact, remove only the old
  invoker/enqueuer grants retired by the desired manifest, using fresh IAM
  etags and a separate read-back for each policy. Old service accounts are
  never deleted.

Promotions and grant removals are separate mutations but share the epoch lock
and activation fence. The removal step is not permitted until both promoted
revisions, source SHAs, runtime identities, producer fingerprints, and
desired IAM additions are exact. No `latest`, mutable alias, cross-role
revision, queue resume, scheduler resume, or provider call is allowed.

**Completion evidence**

- Both role services serve the captured desired revisions with exact traffic
  and source SHA proofs.
- Runtime identities, task caller configuration, role gates, and non-secret
  fingerprints match the desired manifests.
- Retired old invoker/enqueuer grants are absent only after both exact
  promotion postconditions and the removal CAS postconditions succeed.
- No old revision receives traffic unexpectedly.
- Public readiness remains schema v3 and admission false.

**Retry and idempotency**

Promoting an already exact captured revision is a no-op. If one role is
promoted and the other is not, the coordinator verifies the first exact
postcondition and promotes only the missing captured revision. After both
promotions are exact, an already-complete old-grant removal is a no-op; a
partial removal is completed only with fresh IAM etags. An ambiguous traffic
result is resolved by read-only observation; the coordinator never promotes
the latest revision to compensate.

**Fail-closed behavior**

Any revision, traffic, source, runtime identity, or fingerprint mismatch or
failed post-promotion grant removal blocks verification and activation. Keep
all work closed; do not switch back to a guessed old revision or guessed old
IAM policy.

### `VERIFIED`

**Entry evidence**

Both exact revisions are serving, desired IAM is exact, old grants retired as
specified, producer fingerprints match, and admission is still false. The
queues are PAUSED and empty, recovery schedulers are PAUSED and aged, and
retention is enabled.

**Allowed mutations**

None except read-only checks and the bounded provider-free authenticated
malformed-body probes described in section 5.5. The probes must run after
auth, return the reviewed 4xx, and create no task, provider-run, billable,
user-work, or ledger side effect.

**Completion evidence**

- Repeated public readiness reads show schema v3, both exact fingerprints,
  and `providerAdmissionEnabled: false`.
- Exact serving revisions, source SHAs, runtime identities, receiver IAM,
  queue IAM, enqueuer IAM, maintenance IAM, and build separation all match.
- Queue and scheduler proofs remain paused/empty/quiescent and retention is
  enabled.
- Logs and ledgers show zero provider calls, billable operations, user-work
  creations, and task creations during preparation and migration.
- The journal contains a verification digest covering every invariant.

**Retry and idempotency**

Verification is fully repeatable. A probe or read that has any ambiguous
result is not retried against a provider; repeat the same read-only proof or
abort. A resource generation or etag change invalidates verification and
returns the epoch to closed revalidation.

**Fail-closed behavior**

No activation occurs on a partial, stale, aggregate-only, or ambiguous proof.
The public admission bit remains false and all queues/schedulers remain
paused.

### `ACTIVATED`

**Entry evidence**

`VERIFIED` is complete, the lock is current, the activation fence is fresh,
and both queues/schedulers are still paused. Retention is still enabled.

**Allowed mutations, in exact order**

1. Publish or select the reviewed producer state that enables admission.
2. Read the public readiness endpoint and prove the exact schema v3 with
   `providerAdmissionEnabled: true`, both desired fingerprints, and the exact
   Git-backed source SHA evidence.
3. Revalidate both queue and scheduler generations immediately before each
   resume.
4. Resume both recovery schedulers and both queues. Resume all four resources
   under the epoch lock; no single role is activated in isolation.
5. Read back all four resource states and record activation only after both
   roles are active, retention remains enabled, and desired IAM/revisions are
   still exact.

**Completion evidence**

The public proof is admission true, both recovery schedulers are enabled, both
queues are enabled, retention is enabled, and both roles serve the exact
desired revisions with exact IAM. The journal records activation only after
the complete postcondition, not when the first resume call returns.

**Retry and idempotency**

If admission is already true and every resource is already active with the
same epoch proof, activation is a no-op. If admission becomes true but any
resume fails or the postcondition is incomplete, immediately close admission,
pause any resource that was resumed, and verify both queues/schedulers are
paused before retrying. Do not treat a partially active epoch as complete.

**Fail-closed behavior**

Activation never resumes a single role on a stale or unverified proof. A
partial activation is converted back to closed admission and paused work; IAM
and revisions remain at the exact desired state rather than being restored by
an unsafe automatic rollback.

## 8. Safe ordering and partial-failure rules

The ordering is a safety property, not an operator preference:

1. Deploy readiness schema v3 with admission false and verify the strict
   PII-free DTO.
2. Acquire the single epoch lock and complete all `PREPARED` proofs.
3. Stage both role revisions with no traffic and gates false.
4. Keep Vercel/provider admission false while aligning both producer
   fingerprints to the desired Git-backed source SHA.
5. Pause and prove both recovery schedulers and both queues are empty. Keep
   retention enabled.
6. Align desired OIDC and IAM with generation/etag compare-and-swap. Add
   desired bindings first and read them back; retain old invoker/enqueuer
   grants until both revisions are exact. Never delete old service accounts.
7. Promote only the captured exact revisions, then remove retired old
   invoker/enqueuer grants using fresh CAS etags after both planes are exact
   and before activation.
8. Run the complete verification, including authenticated malformed-body
   probes that return reviewed 4xx and zero-work ledger/log proofs.
9. Prove public readiness `providerAdmissionEnabled: true`.
10. Resume both recovery schedulers and both queues, rechecking their
    generations immediately before each mutation; retain the retention
    scheduler enabled.

Before activation, a failure leaves admission false, both queues paused, both
recovery schedulers paused, and no provider/user/billable work. A failure after
desired grants are added does not trigger an automatic IAM rollback. The
desired policy may be left in place while the system remains closed so an
operator can complete the same epoch after revalidation. This avoids restoring
an old policy whose identity aliases are precisely the reason the migration is
needed.

If a queue or scheduler resumes during a partial activation, immediately
close admission, pause every resumed resource, re-prove emptiness/quiescence,
and inspect the provider/billable/user-work ledgers. Any observed work stops
automatic recovery and requires operator review. The coordinator never cancels
an ambiguous provider run, changes payment status, deletes a task to hide a
side effect, or resumes the other role to compensate.

## 9. Crash recovery, fencing, and operator abort

### 9.1 Journal schema

The private journal has one epoch header and append-only transition records.
The logical schema is:

```text
epoch:
  epochIdDigest
  capabilityDigest
  oldManifestDigest
  desiredManifestDigest
  roleSetDigest
  state
  stateVersion
  lockFence
  ownerDigest
  lockExpiresAt
  activationFenceDigest
  sourceProofDigest
  producerProofDigest
  queueProofDigest
  schedulerProofDigest
  retentionProofDigest
  iamProofDigest
  readinessProofDigest
  lastReasonCode
  createdAt
  updatedAt

transition:
  epochIdDigest
  fromState
  toState
  stateVersion
  lockFence
  preconditionDigest
  mutationDigest
  postconditionDigest
  observedGenerationDigest
  observedEtagDigest
  resultCode
  recordedAt
```

All fields are non-secret hashes, state markers, allowlisted result codes, or
bounded timestamps. The journal does not store identities, credentials,
URLs, project names, queue/scheduler names, task bodies, deployment names,
raw logs, user IDs, provider IDs, run IDs, or manifest values. A digest must
be computed from a canonical protected value without making the value
recoverable in ordinary logs.

### 9.2 Lock ownership and expiry

The lock owner is the coordinator process bound to the capability and epoch;
the journal stores only its digest. Acquisition is compare-and-set on an
unowned or expired lock and returns a monotonic fencing token. Renewal is
bounded and must precede expiry. Every mutation verifies the live fence and
the expected resource generation/etag. An expired owner cannot renew or
mutate, even if its process later resumes.

An operator may not force-unlock a live owner by changing a marker in the
journal. After expiry, a new owner must re-read all cloud state and either
resume the exact epoch with a new fence or mark the epoch aborted and create a
new reviewed epoch.

### 9.3 Resume rules for every state

- **`PREPARED`**: reacquire the lock, re-read every precondition, and resume
  only if the old/desired packet digests and resource proofs still match.
- **`STAGED`**: verify each captured no-traffic revision. Restage only the
  missing exact revision with identical inputs; never adopt a different
  revision or latest alias.
- **`PRODUCERS_CLOSED_ALIGNED`**: re-read the public schema, admission bit,
  Git-backed SHA, and both fingerprints. Re-close admission if needed; stop
  on any producer drift.
- **`QUEUES_ALIGNED`**: re-read complete queue listings and aged scheduler
  pauses. Reassert pause only with current generation/etag; do not purge or
  replay work.
- **`INVOKERS_ROTATED`**: read both IAM policies. If desired additions are
  already exact, continue. If additions are partial, complete only the
  reviewed additions using a new etag. Retain old invoker/enqueuer grants
  until both revisions are exact; never restore the old policy automatically.
- **`SERVICES_PROMOTED`**: observe both serving revisions and promote only a
  missing captured revision. Once both are exact, remove retired
  invoker/enqueuer grants with fresh etags. If traffic or removal is
  ambiguous, keep admission closed and require an operator decision.
- **`VERIFIED`**: rerun all read-only proofs and provider-free probes; the
  journal marker alone cannot authorize activation.
- **`ACTIVATED`**: prove public admission and all four resumed resources. If
  activation is partial, close admission and pause all four, then record a
  bounded recovery result; no automatic IAM rollback.

### 9.4 Generation and etag races

Every mutation follows this sequence:

1. Read the exact resource and its current generation/etag.
2. Compare both to the last proof and the protected expected resource key.
3. Acquire or confirm the epoch lock fence immediately before the mutation.
4. Submit one CAS mutation with the fresh generation/etag and fence.
5. Read the resource back and verify the exact postcondition.
6. Append the transition record only after the postcondition succeeds.

A changed generation or etag returns a race result, not a retryable success.
The coordinator re-observes from the current state, bounded to a reviewed
number of attempts, and then stops closed. It never retries with stale tokens,
uses an unconditional overwrite, or assumes the caller's earlier snapshot is
still current.

### 9.5 Operator abort semantics

An operator abort is a durable marker bound to the epoch and lock fence. The
coordinator finishes only the minimum safe closure: set producer/provider
admission false, pause any resumed queue or scheduler, verify both queues are
paused and empty when possible, and keep retention enabled. It does not purge
tasks, delete service accounts, restore ambiguous IAM, mutate payment state,
or run a canary.

An abort before activation leaves staged revisions no-traffic and may leave
the exact desired IAM policy in place. A later attempt uses a new reviewed
epoch after fresh old-state and generation/etag proofs; it must not reuse an
aborted epoch's capability. An abort after partial activation follows the
same closure and additionally requires provider/billable/user-work ledger
review before any future activation.

## 10. TDD acceptance matrix

All tests use fake identities/domains, fake platform resources, and a fake
provider registry. No test may call a paid provider, invoke a real Instagram
canary, send a real task, or use production credentials. Every test asserts
that protected values are absent from output and journal fixtures.

| Area | Acceptance case | Required result |
| --- | --- | --- |
| Ordinary path | Normal per-role `check` and `apply` with unique identities | Existing guards and mutation ordering remain unchanged. |
| Ordinary path | Bootstrap and expansion paths | Existing gate and capacity behavior remains unchanged; no coordinator-only exception is inferred. |
| Capability | Paid exceptional flag without coordinator capability | Rejected before observation or mutation. |
| Capability | Existing preflight-only exceptional flag with paid role | Rejected exactly as today; the coordinator capability is not a boolean alias. |
| Collision | Current live preflight old task/runtime identity overlaps a desired cross-role slot | Sequential preflight-only path fails closed; coordinated dual-role fixture passes only after complete desired-set proof. |
| Collision | Old shared identity appears in two old slots and is absent from desired | Accepted when every other proof passes; no old account deletion. |
| Collision | Retired old identity appears in any desired slot | Rejected. |
| Identity | Desired eight workload identities are pairwise distinct | Accepted. |
| Identity | Any duplicate among the eight desired slots | Rejected before deployment or IAM mutation. |
| Identity | Desired build identity equals any workload identity | Rejected. |
| Identity | Unchanged identity remains in its exact single old/new slot | Accepted. |
| Identity | Unchanged identity aliases a different role or slot | Rejected. |
| Identity | Malformed identity, wrong resource kind, wildcard, or invalid project | Rejected before observation-dependent mutation. |
| Identity | Cross-project old, desired, build, task, runtime, enqueuer, or maintenance identity | Rejected. |
| Source | Old serving SHA/revision differs from the exact old manifest | Rejected. |
| Source | Desired staged revision differs from desired source SHA or is mutable latest | Rejected; captured immutable revision is required. |
| Producer | Missing or mismatched preflight fingerprint | Rejected. |
| Producer | Missing or mismatched paid fingerprint | Rejected. |
| Producer | Project environment metadata is present but active Git-backed SHA/fingerprint is absent | Rejected; metadata is not active evidence. |
| Readiness | Strict readiness v3 exact-key DTO with PII-free fields | Accepted only with the exact schema and no extra identity/URL/task/user fields. |
| Readiness | `ready=true`, `providerAdmissionEnabled=false` | Aggregate readiness does not activate; coordinator remains closed. |
| Readiness | `ready=false`, `providerAdmissionEnabled=true` | Rejected as an inconsistent activation proof. |
| Readiness | Admission false through `PREPARED` to `VERIFIED` | Required. |
| Readiness | Public admission true at activation with both fingerprints exact | Required before resume. |
| Queue | Wrong exact resource, generation, location, or etag | Rejected. |
| Queue | Either queue not PAUSED | Rejected and remains closed. |
| Queue | Either queue non-empty | Rejected; no purge, replay, or synthetic drain. |
| Scheduler | Either recovery scheduler not PAUSED | Rejected. |
| Scheduler | Pause epoch future, malformed, or younger than quiescence window | Rejected. |
| Retention | Retention disabled or target drifted | Rejected; retention is never disabled to complete migration. |
| IAM | Desired add grant CAS succeeds and read-back is exact | Continue. |
| IAM | IAM etag changes between proof and mutation | Re-observe and fail/retry with fresh etag; stale CAS is never reused. |
| IAM | Old grant removal occurs before both role planes are exact | Reject the coordinator implementation and fixture. |
| IAM | Old grant removal is ambiguous | Remain closed; no automatic IAM rollback. |
| Generation | Service/queue/scheduler generation changes before mutation | Fence the mutation, re-observe, and stop after bounded attempts. |
| State failure | Failure before `PREPARED` completion | No mutation and no admission. |
| State failure | Failure before/after each `STAGED` revision | Existing exact revision is reused only when no-traffic and digest-exact. |
| State failure | Failure before/after producer alignment | Admission remains false; no task is created. |
| State failure | Failure before/after queue alignment | Both queues/schedulers remain paused; no purge or replay. |
| State failure | Failure after each IAM add/remove mutation | Desired exactness is re-read; no guessed old-policy restore. |
| State failure | Failure after one service promotion | The promoted exact revision remains closed; missing role is promoted only from the captured revision. |
| State failure | Failure during verification/probe | Admission remains false; no provider or billable side effect. |
| State failure | Failure after admission true but before all resumes | Admission closes immediately, resumed resources pause, and activation is incomplete. |
| Resume | Crash at every state boundary | Journal resume revalidates current state and performs no duplicate unsafe mutation. |
| Resume | Same epoch and exact postcondition replay | No-op/idempotent completion. |
| Resume | Expired owner resumes | Old fence rejected; new owner must re-observe. |
| Probe | Authenticated malformed body for each role | Reviewed 4xx before provider/task/billing/user work. |
| Zero work | Full migration harness | Zero provider calls, billable operations, user-work rows, task creations, and real canary calls before activation. |
| Security | Journal and logs inspected for protected values | Only non-secret digests, slot names, markers, timestamps, and allowlisted codes are present. |

### 10.1 Readiness v3 consumer and test updates

The readiness v3 implementation and every consumer must be updated together:

- the public DTO schema test asserts the exact key set and rejects unknown
  keys;
- the runtime computes both role fingerprints from its own canonical config
  and emits null/false evidence on missing or malformed config;
- the release checker consumes `providerAdmissionEnabled` explicitly and
  never promotes based only on aggregate `ready`;
- coordinator tests require admission false for every pre-activation state
  and require a fresh public true proof before activation;
- false/false, true/false, false/true, and true/true combinations are tested
  with the documented aggregate semantics;
- no readiness fixture contains a raw identity, URL, task body, user ID,
  provider ID, or raw error; and
- the selected Git-backed source SHA and both fingerprint digests are matched
  through non-secret test values without exposing production values.

## 11. Rollout and rollback

### 11.1 Rollout

1. Open a reviewed PR for the implementation behind the coordinator
   capability. Require the PR checks to run all focused unit, contract,
   state-machine, journal, IAM-CAS, generation-race, readiness-v3, and
   fake-provider tests in CI; no production credentials or paid-provider
   network access is permitted in those checks.
2. Deploy readiness v3 with provider/producer admission false. Verify the
   public exact-key DTO, aggregate/admission separation, both fingerprints,
   and the selected Git-backed source SHA without exposing protected values.
3. Prepare the protected release packet containing exact old and desired
   role-slot manifests, exact source SHAs/revisions, exact queue/scheduler
   resources and generations/etags, aged pause proofs, retention proof,
   desired IAM, Vercel SHA, and both producer fingerprints.
4. Start the guarded coordinator. It must complete `PREPARED`, then move
   through the states in order while admission remains false.
5. At `VERIFIED`, review exact revisions, IAM, queue/scheduler state,
   readiness, fingerprints, source SHAs, and zero-work ledgers/logs.
6. Activate by proving public admission true, then resuming both recovery
   schedulers and both queues in the required order. Verify the complete
   postcondition and retention.
7. Keep the final real Instagram/provider canary unrun. A user/operator may
   perform it later under the separate canary procedure after reviewing this
   evidence.

### 11.2 Rollback and closure

Rollback means restoring safe closure, not restoring an ambiguous IAM graph:

- set producer/provider admission false;
- pause any resumed recovery scheduler and queue;
- re-prove both queues paused/empty where safe and keep retention enabled;
- preserve exact desired IAM and no-traffic/serving revision state unless a
  new reviewed epoch explicitly changes it;
- do not delete old service accounts or restore cross-role aliases;
- do not cancel ambiguous provider runs, alter payment state, purge tasks, or
  run the real canary; and
- record the bounded failure and operator decision in the private journal.

If a desired revision is defective, stage a corrected revision under a new
reviewed epoch with admission closed. If IAM is partial, inspect and complete
the exact desired policy or create a new reviewed epoch; never use an
unconditional rollback that could reintroduce the collision.

## 12. Security, observability, and operational checklist

### 12.1 Protected versus non-secret evidence

Protected values include service-account identities, project identifiers,
queue and scheduler resource names, target URLs, task bodies, credentials,
manifest values, provider credentials and IDs, user IDs, deployment names,
and raw logs. They are read only inside the protected release/observation
boundary and are never written to this document, source control, the journal,
or ordinary output.

Non-secret evidence may include abstract role/slot names, schema versions,
boolean proof outcomes, lower-case cryptographic digests, source SHA digests,
resource generation/etag digests, bounded timestamps, lock fences, state
markers, and allowlisted reason codes. Even a non-secret digest must not be
accompanied by the value it represents.

### 12.2 Observability

Emit structured, PII-free events for epoch creation, lock acquire/renew/lose,
state transitions, proof success/failure, generation/etag races, CAS outcomes,
activation closure, and operator abort. Fields are limited to epoch/manifest
digests, abstract role/slot, state, fence, result code, duration, and
non-secret proof digests.

Alert on any of the following:

- provider admission true before `VERIFIED` or without both fingerprints;
- a queue or recovery scheduler enabled while the epoch is not activated;
- provider, billable, user-work, or task activity while admission is false;
- IAM mutation without the active epoch fence or a fresh CAS etag;
- an old service account deletion request;
- journal state advancing without a postcondition digest; or
- readiness v3 emitting an unknown key or a protected value.

### 12.3 Operator checklist

Before starting:

- Confirm exact `origin/main` implementation baseline and CI revision.
- Confirm the protected old and desired manifests are complete for all eight
  slots plus build identity.
- Confirm pairwise desired distinctness, build distinctness, same-slot-only
  unchanged identities, and retirement of all shared/retired identities.
- Confirm exact old/desired source SHAs and immutable revisions.
- Confirm exact queue resources are PAUSED and empty, both recovery schedulers
  are PAUSED with aged pause epochs, and retention is enabled.
- Confirm the Vercel Git-backed SHA, both producer fingerprints, and readiness
  v3 admission false.
- Confirm the coordinator capability and single lock namespace are valid.

During migration:

- Keep admission false and do not send real or paid provider work.
- Recheck generation/etag immediately before every mutation.
- Confirm no traffic on staged revisions and no mutable latest selector.
- Confirm desired IAM is exact before removing old invoker/enqueuer grants.
- Confirm both queues/schedulers remain paused and empty/quiescent.
- Record only non-secret digests and allowlisted markers.

Before activation:

- Confirm exact source SHA/revision, producer fingerprints, IAM, queue,
  scheduler, retention, readiness, and zero-work proofs.
- Run only provider-free authenticated malformed-body probes and verify the
  reviewed 4xx responses.
- Confirm public readiness v3 proves `providerAdmissionEnabled: true` only
  at the activation boundary.
- Resume both recovery schedulers and both queues, checking generations first.
- Confirm the full activation postcondition and leave the real canary to the
  user/operator.

After failure or abort:

- Close admission and pause every resumed work resource.
- Preserve retention and inspect protected ledgers through the authorized
  operator path.
- Do not restore ambiguous IAM, delete service accounts, purge tasks, change
  payments, or run the real canary.
- Mark the epoch aborted or resumable with a bounded reason code and require
  a fresh reviewed epoch for any materially changed inputs.

## 13. Out of scope

- Docker volume deletion or unrelated local cleanup.
- Credential rotation, secret-version changes, or key lifecycle work.
- Unrelated Supabase schema, admin-dashboard, or user-data changes.
- Any real paid provider invocation or Instagram canary.
- Deleting old service accounts.
- Changing ordinary per-role apply behavior or weakening existing guards.
- Removing the existing preflight-only exceptional path.
- Replacing the workload provider budget, payment ledger, retention policy,
  or business-processing DAG.

## Self-review result

The document contains no implementation placeholders or unresolved markers.
State entry and
activation ordering are consistent: admission is false through `VERIFIED`,
desired IAM is exact before old grant removal, exact revisions are promoted
before verification, public admission is proven true before both work planes
resume, and retention remains enabled. Every mutation has a preceding proof
and a postcondition, generation/etag races are bounded and fail closed, and
the document supplies the manifests, capability, state machine, recovery,
testing, rollout, and closure contracts needed by a separate implementation
plan writer without exposing protected values.
