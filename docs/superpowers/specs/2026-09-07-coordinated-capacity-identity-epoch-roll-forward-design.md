# Coordinated capacity identity epoch roll-forward design

Status: proposed for user review

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
revisions, producer fingerprints, and the additive public readiness admission
facts.
It does not redesign workload processing, provider budgets, payment state,
retention policy, or application business logic.

### Admission vocabulary

The migration keeps three independent gates distinct. They are observed and
mutated through different boundaries, and no one gate is inferred from
another:

| Boundary | Existing configuration | Public/readiness fact | Role in this migration |
| --- | --- | --- | --- |
| Vercel public preflight/intake | `ANALYSIS_V2_ADMISSION_ENABLED` | `analysisV2AdmissionEnabled` | Controls public preflight/intake admission. False through `VERIFIED`; activation sets only the separately reviewed desired value, normally true for the activated epoch. |
| Vercel paid webhook auto-admission | `EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED` | `earlybirdWebhookAutoAdmissionEnabled` | Controls whether paid webhook events can automatically enqueue paid work. False through `VERIFIED`; activation restores only its separately reviewed desired value. It is never inferred from the public preflight gate. |
| Cloud Run worker provider admission | `ANALYSIS_PROVIDER_ADMISSION_ENABLED` | Not exposed by the Vercel public DTO | Private worker gate checked by the worker before provider work. The exact `INITIAL` target manifests require it to be true. A staged no-traffic revision may therefore have it true while both Vercel gates, queues, and recovery schedulers are closed. |

The readiness endpoint runs in the Vercel/public runtime and cannot prove the
private Cloud Run worker gate. `ANALYSIS_PROVIDER_ADMISSION_ENABLED` is
therefore never represented by a public field named `providerAdmissionEnabled`
or any other field that suggests public observability. Signed/manual test paths
are not exercised by this migration. Zero-work protection before activation
comes from both Vercel work-producing gates being false, no-traffic revisions,
paused/empty queues, paused recovery schedulers, and provider-free malformed
body validation after authentication.

## 2. Options and decision

### Option A: coordinated dual-role epoch transition (chosen)

Create one generation-bound epoch for both roles. Capture exact old and
desired manifests, close both Vercel work-producing gates, pause both work
planes, stage both revisions without traffic while retaining the exact desired
private worker provider-admission setting, align producer fingerprints, align
desired OIDC and IAM with compare-and-swap etags, promote the captured
revisions, remove retired grants only after both planes are exact, verify the
closed public system, and activate only after the additive public readiness
contract proves the two Vercel admission facts.

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
7. From `PREPARED` through `VERIFIED`, the public readiness proof has
   `ready: true`, `analysisV2AdmissionEnabled: false`, and
   `earlybirdWebhookAutoAdmissionEnabled: false`, while preserving all v2
   freeze, SHA, route, and fingerprint evidence. The exact `INITIAL` desired
   worker manifests have `ANALYSIS_PROVIDER_ADMISSION_ENABLED: true`; that
   private gate is not a public readiness fact and may be true on staged
   no-traffic revisions.
8. Both queues and both recovery schedulers remain paused and empty while
   identity and revision mutations are in progress. Retention remains
   enabled.
9. No provider, billable, or user work occurs before the public activation
   boundary. Before that boundary, zero-work protection is the combination of
   both Vercel gates false, no-traffic revisions, paused/empty queues, paused
   recovery schedulers, and provider-free authenticated malformed-body probes
   that return reviewed 4xx responses before any provider call.
10. Each mutation is preceded by the applicable native CAS token, Cloud Run
    metadata observation barrier, or exact resource observation digest and is
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
| `source` | Exact old observed source SHA/revision for each role; desired source SHA, build/runtime inputs, and deterministic revision naming plan or suffix. The desired immutable revision ID is intentionally absent until `STAGED` creates it. |
| `producer` | Exact producer configuration fingerprint version and digest for each role, the exact Git-backed Vercel source SHA selected as producer evidence, and the two Vercel admission facts. |
| `queues` | The exact protected resource identity for each role, its project/location binding, the complete observed configuration digest, and the PAUSED/empty proof. Cloud Tasks has no invented etag/generation token. |
| `recoverySchedulers` | The exact protected resource identity for each role, complete observed configuration digest, paused state, pause epoch, location, and last-attempt evidence. Cloud Scheduler has no invented etag/generation token. |
| `retention` | The retention scheduler/resource proof and enabled state. |
| `iam` | The expected role-scoped OIDC, invoker, enqueuer, runtime, maintenance, and actAs bindings for both planes, represented by protected values and their canonical digest. |
| `readiness` | Readiness schema version 3, public origin binding, both producer fingerprints, and the admission state proof. |

The old manifest and desired manifest have the same fixed shape. Their
`roleSlots` arrays contain exactly these eight ordered keys and no optional
slot: `preflight.task-caller`, `preflight.enqueuer`,
`preflight.runtime`, `preflight.maintenance`, `paid.task-caller`,
`paid.enqueuer`, `paid.runtime`, and `paid.maintenance`. Each entry has one
exact identity, one owning-project assertion, and one canonical slot digest.
The old manifest additionally carries the observed live serving source SHA and
immutable revision for each role, plus the current resource-specific
concurrency observations. The desired manifest carries exact source,
build/runtime inputs, a deterministic revision naming plan or suffix, and the
target resource/configuration contracts; it does not claim an immutable
revision ID before `STAGED`. Both carry a single build record and the complete
source, producer, queue, scheduler, retention, IAM, and readiness records
above. A manifest
with a missing slot, duplicate slot, additional slot, unresolved identity,
or unresolved project is rejected before `PREPARED`.

The old manifest is observed, not inferred from environment configuration.
The desired manifest is reviewed before the epoch starts and must be resolved
to concrete values at runtime. Project validation checks both manifests and
rejects a value that merely has a valid shape but belongs to another project.

The release packet records the canonical digest of each complete manifest and
the digest of the protected packet as a whole. The journal records only those
digests, slot-key names, transition state/version markers, and allowlisted
proof markers. An implementation must never print or persist the actual
identity, URL, queue,
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
- old observed source/revision is exact, while desired source/build/runtime
  inputs and the deterministic revision naming plan are exact; the desired
  immutable revision ID is created and captured only by `STAGED`, never
  selected through a mutable `latest` alias; and
- both old and desired producer fingerprints are bound to the corresponding
  Git-backed source SHA and role.

The proof emits only a boolean result, an allowlisted failure code, and a
non-secret digest. The actual values remain protected.

## 5. Preconditions and evidence proofs

The coordinator cannot enter `PREPARED` until every proof below succeeds in
one bounded read-only admission pass. A later mutation boundary revalidates
the relevant native CAS token, Cloud Run metadata observation barrier, or
exact resource observation digest immediately before mutation; the initial
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
  source SHA, build/runtime inputs, and deterministic revision naming plan are
  compared to the desired protected manifest; no desired immutable revision
  is required until `STAGED` creates it. Any mismatch fails closed.
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
- the queue's project, location, and complete configuration observation digest
  match the protected resource proof; and
- the queue target, audience, and caller contract match the old manifest.

Observe the exact recovery scheduler for each role and prove:

- state is `PAUSED`;
- the pause epoch is a strict, non-future epoch older than the configured
  request-timeout-plus-grace quiescence window;
- no attempt occurred inside that window; and
- the job target, location, pause epoch, and OIDC contract match the old
  manifest and its complete observation digest.

Retention is independently observed and must remain enabled. A retention
proof does not authorize a recovery scheduler to resume and does not replace
the two recovery pause proofs.

If either queue is non-empty, either recovery scheduler is not provably
quiescent, or retention is disabled, the coordinator remains closed. It may
wait for an operator-managed safe drain, but it must not purge, replay, or
silently discard work to manufacture an empty proof.

### 5.4 Additive readiness v3 and producer admission proof

The public readiness DTO is an additive strict evolution of the current v2
contract. It is not a replacement or a shortened DTO. The current v2 literal
is `analysis-public-freeze-readiness-v2`; v3 uses the string literal
`analysis-public-freeze-readiness-v3` and preserves every v2 key, type, and
meaning while adding two PII-free Vercel admission facts.

```text
schemaVersion
ready
stage
freezeMode
publicFreezeEnabled
sourceSha
legacyTargetResource
preflightProducerConfigFingerprintVersion
preflightProducerConfigFingerprint
preflightProducerConfigReady
paidProducerConfigFingerprintVersion
paidProducerConfigFingerprint
paidProducerConfigReady
routes
```

Their current semantics remain unchanged in v3:

- `schemaVersion` is the exact string literal
  `analysis-public-freeze-readiness-v2` in v2 and the exact v3 literal above
  in v3; it is not a number.
- `stage` is `initial` or `expanded` when configured, otherwise `unknown`.
- `freezeMode` is `drain-and-block` when configured, otherwise `unknown`.
- `publicFreezeEnabled` is the boolean public-freeze setting owned by the
  Vercel runtime.
- `sourceSha` is the Vercel Git commit SHA only when it is a valid lower-case
  40-character hexadecimal SHA and agrees with any configured source SHA;
  otherwise it is `null`.
- `legacyTargetResource` is the trimmed legacy target resource string or
  `null`. It is preserved as evidence but is not independently treated as
  active runtime provenance.
- Each producer fingerprint version remains its exact current literal:
  `preflight-producer-config-v1` for preflight and
  `paid-producer-config-v1` for paid. Each fingerprint is either `null` or a
  lower-case 64-character
  SHA-256 hexadecimal digest computed by the serving runtime from its own
  canonical role tuple (normalized task identity, target, and audience). The
  corresponding `*Ready` boolean is true exactly when that role's tuple is
  valid and its digest is non-null, and false otherwise. The DTO never emits
  the tuple values.
- `ready` preserves the v2 aggregate formula exactly: known `stage`,
  `freezeMode == drain-and-block`, `publicFreezeEnabled == true`, the legacy
  producer gate is frozen, non-null `sourceSha`, and both producer `*Ready`
  booleans true. It does not include either new Vercel admission boolean and
  it does not claim the private worker gate.
- The readiness endpoint's HTTP status remains 200 exactly when `ready` is
  true and 503 otherwise. The two additive admission booleans do not change
  that aggregate status semantics.

The v2 `routes` object remains exactly this three-route object and shape:

```text
routes: {
  "/api/analysis/start": {
    gateState: "frozen" | "not_ready",
    expectedStatus: 410 | 503,
    gateBeforeRuntime: true
  },
  "/api/analysis/step": {
    gateState: "frozen" | "not_ready",
    expectedStatus: 410 | 503,
    gateBeforeRuntime: true
  },
  "/api/analysis/run": {
    gateState: "frozen" | "not_ready",
    expectedStatus: 410 | 503,
    gateBeforeRuntime: true
  }
}
```

`gateState` is `frozen` exactly when the legacy producer gate is frozen and
`not_ready` otherwise. Every route's `expectedStatus` is 410 when frozen and
503 otherwise; every route has `gateBeforeRuntime: true`. The route keys,
inner keys, allowed values, and gate-before-runtime semantics are not changed
by v3. Unknown, missing, duplicate, or extra keys fail strict validation.

The exact v3 key set is the complete v2 set above plus exactly these two
top-level boolean keys, added without removing or renaming any v2 key:

```text
analysisV2AdmissionEnabled: boolean
earlybirdWebhookAutoAdmissionEnabled: boolean
```

Serialization retains the current v2 key order and appends
`analysisV2AdmissionEnabled` followed by
`earlybirdWebhookAutoAdmissionEnabled`; strict consumers validate the exact
key set as well as the values.

`analysisV2AdmissionEnabled` is the PII-free public fact for
`ANALYSIS_V2_ADMISSION_ENABLED`, the Vercel public preflight/intake gate.
`earlybirdWebhookAutoAdmissionEnabled` is the independent PII-free fact for
`EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED`, the Vercel paid webhook
auto-admission gate. Neither field contains an identity, URL, project, user,
task, provider, payment, or raw error value. The public DTO must not expose
`ANALYSIS_PROVIDER_ADMISSION_ENABLED`; in particular it must not invent a
public field named `providerAdmissionEnabled`.

`ready` retains the v2 formula and remains independent of both new booleans.
Therefore `ready: true` is aggregate freeze/fingerprint evidence, not proof
that either Vercel work-producing gate is open. The v3 readiness consumer and
coordinator must read all three facts separately:

- Through `VERIFIED`, `ready: true`,
  `analysisV2AdmissionEnabled: false`, and
  `earlybirdWebhookAutoAdmissionEnabled: false` are required, together with
  the exact v2 SHA, fingerprint, freeze, and route evidence.
- The desired `INITIAL` private worker manifests require
  `ANALYSIS_PROVIDER_ADMISSION_ENABLED: true`. A staged desired revision may
  carry that value while no-traffic, both queues and recovery schedulers are
  paused, and both Vercel gates are false. This private fact is proved from
  the exact Cloud Run revision/runtime manifest, never from the public DTO.
- At activation, the public proof must show `ready: true` and
  `analysisV2AdmissionEnabled: true`. The public proof must also show
  `earlybirdWebhookAutoAdmissionEnabled` equal to its separately reviewed
  desired value before any resource resumes. The coordinator must not infer
  the paid webhook value from the public preflight value.

The readiness implementation, release checker, and coordinator tests must
reject unknown keys, preserve the entire v2 object, validate both new booleans
as strict booleans, and test aggregate `ready` independently from both
admission facts. Missing, malformed, duplicate, or mismatched fingerprints,
SHA, freeze evidence, route object, or admission facts fail closed.

### 5.5 Provider-free probe proof

After authentication succeeds, send only reviewed malformed-body probes to the
private role receivers. Each receiver must return its documented 4xx response
before task creation, provider admission, billing, or user-work creation. The
worker provider-admission gate may be true in the staged `INITIAL` revision,
but validation must reject the malformed body before that gate can admit a
provider operation. The probe contract is provider-free, bounded, and
non-retrying. A 2xx, 5xx, unexpected 4xx, provider ledger row, billable
operation, task, or user-work row fails verification. The probe does not
contain a real target, account, provider run, or user identifier.

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
   Vercel, readiness, and ledger facts; returns typed facts plus each
   resource's native CAS token, Cloud Run metadata observation, or exact
   observation digest.
3. **Mutation boundary**: acquires or renews the single lock, revalidates the
   applicable native CAS token, metadata observation barrier, or observation
   digest immediately before a mutation, performs one bounded idempotent
   mutation, and reads the postcondition before appending the transition.
4. **Activation boundary**: proves the public readiness aggregate and both
   independent Vercel admission facts, retains the private worker gate proven
   from the exact revision, resumes both recovery schedulers before either
   queue, and records activation only after all four resources are in the
   expected state.

No boundary accepts a caller-supplied identity, URL, task body, provider run,
or user identifier as proof. Every external value is compared to the
protected manifest or to an independently observed public/runtime fingerprint.

### 6.2 Single generation-bound deploy lock and journal storage

The concrete durable storage boundary is the existing private
`ANALYSIS_CAPACITY_DEPLOY_LOCK_BUCKET` GCS bucket. The bucket name and object
contents are protected and never appear in this document or ordinary logs.
The coordinator uses three distinct digest-derived object families inside
that bucket; none contains a secret or a recoverable manifest value.

1. **Immutable epoch header.** One header is created once under a logical key
   composed of `epoch-header/`, the epoch digest, the desired-manifest
   digest, and a `.json` suffix. Creation uses
   `ifGenerationMatch=0`. Its only fields are fixed epoch, capability,
   old-manifest, desired-manifest, role-set, and source-plan metadata digests
   plus `createdAt`. It has no current state, state version, lock owner,
   fencing value, lock expiry, `updatedAt`, or evolving proof digest. Any
   attempt to rewrite the header is rejected.
2. **Mutable epoch lock.** One lock object is keyed by the epoch/header
   digest under `epoch-lock/` with a `.lock` suffix. It contains the bound
   epoch/header digest, owner digest, fencing counter, and bounded expiry.
   Acquisition, renewal, and takeover change it only with an exact observed
   GCS object-generation precondition; initial creation uses
   `ifGenerationMatch=0`. The lock fences ownership and is not the state
   source of truth. A stale owner, expired lease without a new fence, or
   capability/header mismatch is rejected.
3. **Append-only transition objects.** Each transition is a separate object
   under `epoch-journal/`, the epoch digest, and a bounded contiguous sequence
   number, with a transition digest and `.json` suffix. It is created once
   with `ifGenerationMatch=0` and contains the state, version, proof, and
   result data for that transition. An owner cannot rewrite an earlier
   transition or advance a separate mutable state marker.

The current state is derived by reading the immutable header and the
transition objects, validating a contiguous sequence, exact `fromState` to
`toState` links, monotonically increasing versions, epoch binding, and the
active lock fence. A missing, duplicate, out-of-order, or invalid transition
blocks resume and activation. The lock only fences the writer; it never
authorizes a state by itself, and a per-role lock cannot substitute for this
single epoch lock because it would permit the two roles to observe different
epochs.

### 6.3 Durable private epoch journal

The journal is private, durable, append-only, and accessible only to the
coordinator and authorized operators. Its immutable header, mutable lock, and
append-only transition objects store only non-secret hashes, abstract role or
slot names, bounded timestamps, allowlisted reason codes, proof outcomes, and
state/version markers. The header is written once, the lock is changed only
through exact GCS generation preconditions, and each transition is appended
with `ifGenerationMatch=0` after its postcondition succeeds. There is no
mutable current-state field or `updatedAt` field in the header.

The journal is not the source of truth for cloud state. It is a resume ledger
whose current state is the validated contiguous transition sequence. Every
resume reads the current resource and readiness state again, then decides
whether the recorded transition remains valid under the active lock fence.

### 6.4 Resource concurrency controls

The coordinator never invents an etag or generation for a platform that does
not expose one. It uses the following resource-specific protocol:

| Resource | Concurrency token or observation control | Before mutation | Mutation and postcondition |
| --- | --- | --- | --- |
| IAM policy | Provider policy `etag` | Fresh policy read and exact etag comparison | CAS policy update with etag; exact policy read-back. Any CAS mismatch fails closed. |
| Cloud Run service/revision and traffic | Metadata `generation`/`resourceVersion` observation (not a request-level CAS token in this design) | Fresh service metadata read plus exact desired revision/traffic proof under the GCS epoch lock | Issue one bounded deploy or traffic operation only after the fresh metadata observation; do not assume the API request is conditionally bound to `resourceVersion`; read exact serving traffic, revision, source SHA, and runtime gate back. |
| GCS epoch header/lock/transitions | Object `generation` | Fresh object generation read for the lock; fixed key and absence proof for a new header/transition | Create immutable header/transition with `ifGenerationMatch=0`; rewrite the lock only with its exact observed generation; read object generation and content digest back. |
| Cloud Tasks queue | No native CAS token used by this design | Immediate complete configuration/task-list read and canonical observation digest under the epoch lock | One bounded pause/resume operation; immediate exact config/state/task-list read-back. Any digest drift fails closed. |
| Cloud Scheduler recovery job | No native CAS token used by this design | Immediate complete job/config/status read and canonical observation digest under the epoch lock | One bounded pause/resume operation; immediate exact status/config/pause-epoch read-back. Any digest drift fails closed. |
| Vercel producer deployment/gates | No cross-resource CAS token used by this design | Exact selected Git SHA, readiness v3 facts, and immutable deployment evidence read immediately before the operation | Deploy/select only the reviewed immutable source; read public readiness and source/fingerprint facts back. Any source or fact drift fails closed. |

For Cloud Tasks and Cloud Scheduler, a changed observation digest between the
pre-mutation read and post-read is a race even though no native etag exists.
The epoch lock fences cooperating actors, while the immediate exact read
detects external drift. No unconditional overwrite, guessed generation, or
invented etag is allowed.

## 7. State machine

The coordinator may advance only in the order shown below. A state is entered
after its entry evidence is durable in the contiguous transition sequence. A
state may be retried idempotently when the same epoch, lock fence, manifest
digest, native CAS tokens, metadata observation barriers, and resource
observation digests still hold. Any unrecognized evidence or external drift
fails closed.

### `PREPARED`

**Entry evidence**

- The coordinator capability is valid and binds both roles and the desired
  manifest digest.
- The old and desired manifests are complete and exact, with all eight slots,
  build identity, old observed revision records, desired source/build/runtime
  inputs and deterministic revision naming plan, producer fingerprints, queue
  and scheduler records, retention proof, IAM expectations, and readiness v3
  contract.
- Identity/project, pairwise-disjoint, build-distinct, unchanged-slot, and
  retired/shared-identity proofs pass.
- Exact old source SHAs/revisions, desired source/build/runtime inputs and
  deterministic revision naming plan, Vercel Git-backed SHA, both producer
  fingerprints, queue PAUSED/empty proofs, both aged scheduler pause proofs,
  retention enabled, readiness `ready: true`, and both Vercel admission facts
  false are observed. The desired `INITIAL` manifest requirement
  `ANALYSIS_PROVIDER_ADMISSION_ENABLED: true` is validated and recorded as a
  reviewed input only. `PREPARED` does not claim that a desired revision
  exists or that its runtime gate has been observed or remains true; the old
  serving revisions remain separately observed against the old manifest.
- The single GCS lock is acquired and the initial resource-specific
  CAS-token, metadata-observation, and observation-digest proofs are recorded.

**Allowed mutations**

None. This state is read-only admission and journal initialization. No
deployment, IAM, queue, scheduler, provider, or readiness mutation is allowed.

**Completion evidence**

The journal records the canonical old/desired manifest digests, source and
resource proof digests, lock fence, and a `PREPARED` transition whose proof
includes the reviewed manifest requirement
`ANALYSIS_PROVIDER_ADMISSION_ENABLED: true`. The public readiness proof shows
`ready: true`, `analysisV2AdmissionEnabled: false`, and
`earlybirdWebhookAutoAdmissionEnabled: false`. No `PREPARED` completion
evidence claims a desired revision exists or supplies a desired runtime-gate
observation; `STAGED` is the first state that can provide that evidence.

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

`PREPARED` is complete, both Vercel work-producing gates remain false, and the
two role deployment inputs resolve to the desired source/build/runtime inputs
and deterministic revision naming plan. The desired private worker
provider-admission requirement is true in both target `INITIAL` manifests;
`STAGED` is the first state that creates or reuses the exact revisions and
proves that runtime gate from them. The readiness v3 deployment is already
serving with `ready: true`, both Vercel admission facts false, and its exact
additive public schema observed.

**Allowed mutations**

- Build or deploy one exact no-traffic revision for each role using the
  desired runtime/build manifests and pinned inputs.
- Bind the desired role, private worker provider-admission value, and
  non-secret fingerprint configuration to those revisions; the Vercel gates
  remain false outside those revisions.
- Perform no traffic promotion, queue resume, scheduler resume, IAM grant
  removal, provider call, or user-work mutation.

Each deployment or traffic operation is preceded by a fresh Cloud Run
metadata generation/resourceVersion observation barrier under the GCS epoch
lock and exact source/build/runtime proof. The API request is not assumed to
be conditionally bound to resourceVersion; the coordinator reads the exact
postcondition immediately afterward. The desired deterministic naming plan is
used to create or look up the exact revision; its immutable observed revision
ID/digest is captured in the journal only after the platform confirms it.

**Completion evidence**

- Both exact desired revisions exist and receive no traffic.
- Each revision reports the desired role and
  `ANALYSIS_PROVIDER_ADMISSION_ENABLED: true`; no traffic can reach it.
- The Vercel public/intake and paid webhook admission facts remain false.
- Each staged revision's source SHA, runtime manifest digest, build manifest
  digest, private worker-gate value, and non-secret fingerprint digest match
  the protected packet.
- The public readiness v3 endpoint remains PII-free, reports `ready: true`,
  and reports both Vercel admission facts false.

**Retry and idempotency**

If the deterministic naming plan already resolves to an immutable revision
with the exact source/build/runtime/fingerprint digest and no traffic, the
coordinator reuses it and journals its observed immutable ID/digest. A
same-name or same-source revision with any different manifest, role, gate, or
metadata is not adopted. A failed build can be retried only with the same
protected inputs; an ambiguous platform result is resolved by read-back, not
by submitting a second uncontrolled deployment.

**Fail-closed behavior**

Any traffic, mutable latest selector, source drift, unexpected private worker
gate, Vercel gate-on state, producer drift, or Cloud Run generation race
leaves both Vercel gates closed. The coordinator does not promote a partial
pair.

### `PRODUCERS_CLOSED_ALIGNED`

**Entry evidence**

Both staged revisions are exact and no-traffic. Public readiness v3 reports
`ready: true`, `analysisV2AdmissionEnabled: false`, and
`earlybirdWebhookAutoAdmissionEnabled: false`. Both producer planes are bound
to the desired Git-backed source SHA and desired role fingerprints, but no
Vercel producer may create work. The private worker provider-admission value
is true in each exact staged `INITIAL` revision and is not a public readiness
fact.

**Allowed mutations**

- Close or reassert both Vercel work-producing gates: the public preflight
  gate and the paid webhook auto-admission gate.
- Deploy or select the reviewed producer revision that emits both desired
  producer fingerprints while keeping both Vercel gates false.
- Update only the protected, reviewed non-secret producer fingerprint
  configuration required to match the desired manifests.

Do not create a task, send a probe task, enable either Vercel gate, rotate IAM,
promote a worker, resume a scheduler, exercise a signed/manual test path, or
run a paid provider. Do not change the private worker provider-admission gate
away from its exact desired `INITIAL` value.

**Completion evidence**

- The selected READY producer deployment reports the exact Git-backed source
  SHA required by the packet.
- Preflight and paid fingerprint version/digest pairs match their desired
  manifests exactly.
- Public readiness v3 is the same additive strict key set, remains PII-free,
  has `ready: true`, and reports both Vercel admission facts false.
- A read-only producer and queue check sees no newly created task.

**Retry and idempotency**

Re-reading an already aligned producer is a no-op. A failed producer deploy
is recovered by selecting the exact captured deployment or retrying the same
reviewed source, never by following a mutable alias. If the public source SHA,
fingerprint, schema, or either Vercel admission fact changes, return to the
last safe closed state and require a fresh proof.

**Fail-closed behavior**

Any missing fingerprint, aggregate/admission ambiguity, public schema drift,
unexpected producer source, either Vercel gate enabled, or task creation
leaves both Vercel gates false and blocks the next state. The private worker
provider-admission gate may remain true only as specified by the exact staged
`INITIAL` manifest.

### `QUEUES_ALIGNED`

**Entry evidence**

`PRODUCERS_CLOSED_ALIGNED` is complete. Both exact queue resources are
observed PAUSED and empty; both exact recovery schedulers are PAUSED with
aged pause epochs; retention is enabled; and no recovery attempt occurred in
the quiescence window. Their complete configuration observation digests were
read immediately before this state; neither resource is assigned an invented
etag or generation.

**Allowed mutations**

- Reassert PAUSED on either queue or recovery scheduler only after an
  immediate complete resource/configuration re-read still matches the
  expected observation digest under the epoch lock.
- Refresh a bounded read-only empty and quiescence proof.

Do not purge tasks, acknowledge tasks, enqueue synthetic tasks, resume a
scheduler, resume a queue, disable retention, or mutate work payloads. If a
queue is non-empty, wait only for an operator-managed safe drain or abort.

**Completion evidence**

The complete queue listings are empty and both queues remain PAUSED. Both
recovery schedulers remain PAUSED with pause epochs older than the configured
window. Retention remains enabled. The postcondition records fresh queue and
scheduler observation digests.

**Retry and idempotency**

Repeated pause operations are no-ops when the resource is already PAUSED.
Empty and scheduler-age proofs are re-read on every retry. A changed
configuration digest, recent scheduler attempt, or new task invalidates the
proof and requires revalidation from `PRODUCERS_CLOSED_ALIGNED`.

**Fail-closed behavior**

The coordinator cannot rotate IAM or deploy traffic while either queue or
recovery scheduler is not provably quiescent. It does not manufacture
emptiness by deletion.

### `INVOKERS_ROTATED`

**Entry evidence**

Both producers are closed and aligned, both queues/schedulers are paused and
empty/quiescent, retention is enabled, both staged revisions are exact, and
the public readiness proof is `ready: true` with both Vercel admission facts
false. The private worker provider-admission value is true in both exact
staged `INITIAL` revisions. The current IAM etags and Cloud Run metadata
generation/resourceVersion observations are freshly read as pre-mutation
barriers under the GCS epoch lock; they are not assumed to be request-level
CAS tokens.

**Allowed mutations**

Using compare-and-swap etags and one lock fence:

1. Add the desired role-scoped OIDC, enqueuer, runtime, maintenance, and
   required actAs bindings for both role planes. Retain old invoker and
   enqueuer grants temporarily; they are not yet retired in this state.
2. Read back each policy and prove that the desired bindings are exact, scoped
   to the intended project/resource, and cannot cross roles.

Every IAM mutation is one bounded CAS operation with an immediate read-back.
Unrelated bindings are not replaced. No traffic, queue, scheduler, provider,
or Vercel admission mutation is allowed in this state. The private worker
provider-admission value remains the exact staged `INITIAL` setting.

**Completion evidence**

- Both role IAM policies contain the exact desired grants. Old
  invoker/enqueuer grants may still be present until both exact revisions are
  promoted; their removal is a later postcondition of `SERVICES_PROMOTED`.
- Desired task caller, enqueuer, runtime, and maintenance identities are
  bound only to their exact role/slot resources.
- IAM etag/policy-generation postconditions match the expected new state.
- Both Vercel admission facts remain false and both work planes remain
  paused; the private worker gate remains true only in the exact staged
  `INITIAL` revisions.

**Retry and idempotency**

If the desired additions are already exact, the operation is a no-op. If
desired grants were added partially, re-read the policy and complete only the
missing reviewed additions with the new etag. Old-grant removal is not part of
this state. If a CAS fails, do not retry with the stale etag; re-observe and
either prove the desired additions or stop.

**Fail-closed behavior**

There is no automatic IAM rollback. A partial policy is not treated as safe
for activation. Keep both Vercel gates false, queues/schedulers paused, and
the staged revisions no-traffic; leave the private worker gate at the exact
desired `INITIAL` value and record the bounded failure. Require a resumed
epoch or a new reviewed epoch after operator inspection. Restoring the old
policy blindly could reintroduce the identity collision or grant an ambiguous
role.

### `SERVICES_PROMOTED`

**Entry evidence**

`INVOKERS_ROTATED` is complete, both desired IAM policies are exact, the
queues and schedulers are still paused, both Vercel admission facts are false,
and each staged revision is bound to the immutable revision ID/digest captured
by `STAGED`. The private worker provider-admission value is true in the exact
desired `INITIAL` revisions.
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

Before each promotion, the coordinator takes a fresh Cloud Run metadata
generation/resourceVersion observation under the GCS epoch lock, verifies the
captured revision/source/runtime expectation, and issues one bounded traffic
operation. The API request is not assumed to be conditionally bound to the
observed resourceVersion; exact traffic and revision read-back is the
postcondition. Promotions and grant removals are separate mutations but share
the epoch lock and activation fence. The removal step is not permitted until
both promoted revisions, source SHAs, runtime identities, producer
fingerprints, and desired IAM additions are exact. No `latest`, mutable alias,
cross-role revision, queue resume, scheduler resume, or provider call is
allowed.

**Completion evidence**

- Both role services serve the captured desired revisions with exact traffic
  and source SHA proofs.
- Runtime identities, task caller configuration, role gates, and non-secret
  fingerprints match the desired manifests.
- Retired old invoker/enqueuer grants are absent only after both exact
  promotion postconditions and the removal CAS postconditions succeed.
- No old revision receives traffic unexpectedly.
- Public readiness remains additive schema v3 with `ready: true` and both
  Vercel admission facts false; the private worker gate remains the exact
  desired `INITIAL` value true.

**Retry and idempotency**

Promoting an already exact captured revision is a no-op. If one role is
promoted and the other is not, the coordinator verifies the first exact
postcondition and promotes only the missing captured revision. After both
promotions are exact, an already-complete old-grant removal is a no-op; a
partial removal is completed only with fresh IAM etags. An ambiguous traffic
result is resolved by read-only observation; the coordinator never promotes
the latest revision to compensate.

**Fail-closed behavior**

Any revision, traffic, source, runtime identity, fingerprint mismatch, or
failed post-promotion grant removal blocks verification and activation. Keep
both Vercel gates false and all work planes paused; do not switch back to a
guessed old revision or guessed old IAM policy.

### `VERIFIED`

**Entry evidence**

Both exact revisions are serving, desired IAM is exact, old grants retired as
specified, producer fingerprints match, and the public readiness proof has
`ready: true`, `analysisV2AdmissionEnabled: false`, and
`earlybirdWebhookAutoAdmissionEnabled: false`. The private worker
provider-admission value is true in both exact desired `INITIAL` revisions.
The queues are PAUSED and empty, recovery schedulers are PAUSED and aged, and
retention is enabled.

**Allowed mutations**

None except read-only checks and the bounded provider-free authenticated
malformed-body probes described in section 5.5. The probes must run after
auth, return the reviewed 4xx before the private worker provider-admission
gate can admit an operation, and create no task, provider-run, billable,
user-work, or ledger side effect.

**Completion evidence**

- Repeated public readiness reads show additive schema v3, `ready: true`,
  both exact fingerprints, `analysisV2AdmissionEnabled: false`, and
  `earlybirdWebhookAutoAdmissionEnabled: false`.
- Exact serving revisions, source SHAs, runtime identities, receiver IAM,
  queue IAM, enqueuer IAM, maintenance IAM, build separation, and private
  `ANALYSIS_PROVIDER_ADMISSION_ENABLED: true` all match.
- Queue and scheduler proofs remain paused/empty/quiescent and retention is
  enabled.
- Logs and ledgers show zero provider calls, billable operations, user-work
  creations, and task creations through the pre-activation verification
  boundary. The worker provider gate being true in a no-traffic revision is
  not itself provider activity.
- The journal contains a verification digest covering every invariant.

**Retry and idempotency**

Verification is fully repeatable. A probe or read that has any ambiguous
result is not retried against a provider; repeat the same read-only proof or
abort. A changed IAM etag, Cloud Run metadata generation/resourceVersion, GCS
object generation, queue observation digest, scheduler observation digest, or
Vercel proof invalidates verification and returns the epoch to closed
revalidation.

**Fail-closed behavior**

No activation occurs on a partial, stale, aggregate-only, or ambiguous proof.
Both Vercel admission facts remain false and all queues/schedulers remain
paused; the private worker gate remains the exact desired `INITIAL` value.

### `ACTIVATED`

**Entry evidence**

`VERIFIED` is complete, the lock is current, the activation fence is fresh,
and both queues/schedulers are still paused. The private worker gate is already
the exact desired `INITIAL` value true. Retention is still enabled.

**Allowed mutations** (in exact order)

1. Publish or select the reviewed producer state that sets
   `analysisV2AdmissionEnabled` to its exact desired activation value.
2. Independently set or select the reviewed paid webhook state and read the
   public readiness endpoint. Prove additive schema v3, `ready: true`,
   `analysisV2AdmissionEnabled: true`, the exact desired value of
   `earlybirdWebhookAutoAdmissionEnabled`, both desired fingerprints, and the
   exact Git-backed source SHA evidence. Never infer the paid value from the
   public preflight value. The private worker gate is not read from this
   endpoint; it remains proven from the exact serving revision.
3. Revalidate each queue and scheduler's complete observation digest
   immediately before its bounded resume operation.
4. Resume resources in this deterministic order under the epoch lock:
   preflight recovery scheduler, paid recovery scheduler, preflight queue,
   then paid queue. This is scheduler-before-queue for both roles; the order
   is fixed and not a transaction.
5. Read back all four resource states and record activation only after both
   roles are active, retention remains enabled, and desired IAM/revisions are
   still exact.

**Completion evidence**

The public proof is `ready: true`,
`analysisV2AdmissionEnabled: true`, and
`earlybirdWebhookAutoAdmissionEnabled` equal to its separately reviewed
desired value. Both recovery schedulers are enabled, both queues are enabled,
retention is enabled, the private worker gate is true in both exact serving
revisions, and both roles serve the exact desired revisions with exact IAM.
The journal records activation only after the complete postcondition, not when
the first resume call returns.

**Retry and idempotency**

If both Vercel admission facts already equal their reviewed activation values
and every resource is already active with the same epoch proof, activation is
a no-op. Once the public admission proof is true, legitimate external work
may be admitted into queues that are still paused during the short ordered
resume window; that is post-activation-boundary work, not a violation of the
pre-activation zero-work proof. If any resume fails, immediately set both
Vercel admission gates false, pause any resumed scheduler or queue, never
purge or discard newly admitted tasks, and require operator review and safe
drain before retry when a queue is non-empty. Do not treat a partially active
epoch as complete.

**Fail-closed behavior**

Activation never resumes a single role on a stale or unverified proof. A
partial activation is compensated by closing both Vercel gates and pausing any
resumed scheduler or queue; IAM and revisions remain at the exact desired
state rather than being restored by an unsafe automatic rollback. Cross-plane
atomicity is provided by the ordered state machine and this fail-closed
compensation, not by a transaction spanning Vercel, Cloud Scheduler, and
Cloud Tasks.

## 8. Safe ordering and partial-failure rules

The ordering is a safety property, not an operator preference:

1. Deploy additive readiness schema v3 with both Vercel work-producing gates
   false and verify the entire strict v2-plus-v3 PII-free DTO. The private
   worker provider-admission gate is not changed by this public deployment.
2. Acquire the single epoch lock and complete all `PREPARED` proofs.
3. Stage both role revisions with no traffic, exact desired
   `ANALYSIS_PROVIDER_ADMISSION_ENABLED: true`, and both Vercel gates false.
4. Keep both Vercel gates false while aligning both producer fingerprints to
   the desired Git-backed source SHA. Signed/manual test paths are not
   exercised.
5. Pause and prove both recovery schedulers and both queues are empty. Keep
   retention enabled.
6. Align desired OIDC and IAM with IAM-etag compare-and-swap. Add
   desired bindings first and read them back; retain old invoker/enqueuer
   grants until both revisions are exact. Never delete old service accounts.
7. Promote only the captured exact revisions, then remove retired old
   invoker/enqueuer grants using fresh CAS etags after both planes are exact
   and before activation.
8. Run the complete verification, including authenticated malformed-body
   probes that return reviewed 4xx before provider admission and zero-work
   ledger/log proofs through this pre-activation boundary.
9. Prove public readiness `ready: true`,
   `analysisV2AdmissionEnabled: true`, and
   `earlybirdWebhookAutoAdmissionEnabled` equal to its separately reviewed
   desired value. The private worker provider-admission gate remains the exact
   desired `INITIAL` value true and is not inferred from this public proof.
10. Resume resources in the fixed order: preflight recovery scheduler, paid
    recovery scheduler, preflight queue, then paid queue. Recheck each
    resource's complete observation digest immediately before its mutation;
    retain the retention scheduler enabled.

Before the public activation boundary, a failure leaves both Vercel gates
false, both queues paused, both recovery schedulers paused, and no
provider/user/billable work. The private worker gate may be true in an exact
no-traffic revision without violating that proof. A failure after desired
grants are added does not trigger an automatic IAM rollback. The desired
policy may be left in place while the system remains closed so an operator can
complete the same epoch after revalidation. This avoids restoring an old
policy whose identity aliases are precisely the reason the migration is
needed.

Once the public activation proof is true, legitimate external work may be
admitted into a still-paused queue during the fixed scheduler-then-queue
resume window. If any resume fails, immediately close both Vercel gates, pause
any resumed scheduler or queue, never purge or discard newly admitted tasks,
and require operator review and safe drain before retry if a queue is
non-empty. Inspect provider/billable/user-work ledgers; any observed work
requires review. The coordinator never cancels an ambiguous provider run,
changes payment status, or resumes the other role to compensate.

## 9. Crash recovery, fencing, and operator abort

### 9.1 Journal schema

The private journal has one immutable epoch header, one mutable epoch lock,
and append-only sequenced transition objects. The logical schemas are:

```text
epochHeader:
  epochIdDigest
  capabilityDigest
  oldManifestDigest
  desiredManifestDigest
  roleSetDigest
  sourcePlanDigest
  createdAt

epochLock:
  epochHeaderDigest
  ownerDigest
  lockFence
  lockExpiresAt

transition:
  sequence
  epochIdDigest
  fromState
  toState
  stateVersion
  lockFence
  preconditionDigest
  mutationDigest
  postconditionDigest
  proofDigest
  nativeConcurrencyTokenDigest
  resourceObservationDigest
  resultCode
  recordedAt
```

The epoch header is created once with GCS `ifGenerationMatch=0` and contains
only fixed epoch/capability/manifest/role/source metadata plus `createdAt`; it
never receives mutable state, lock ownership, lock expiry, `updatedAt`, or
evolving proof digests. The epoch lock is changed only with an exact observed
GCS object-generation precondition. Each transition object is created once
with `ifGenerationMatch=0`; its `sequence` values must be contiguous, and its
state/version/proof/result fields describe one completed transition. Captured
staged revision and resource proof values are represented only by their
non-secret digests in transition objects.

All fields are non-secret hashes, transition state/version markers, allowlisted
result codes, or bounded timestamps. The journal does not store identities,
credentials, URLs, project names, queue/scheduler names, task bodies,
deployment names, raw logs, user IDs, provider IDs, run IDs, or manifest
values. A digest must
be computed from a canonical protected value without making the value
recoverable in ordinary logs. Current state is derived from a validated
contiguous transition sequence, not from the epoch lock or a mutable header
field. Missing, duplicated, reordered, or invalid transitions block resume
and activation.

### 9.2 Lock ownership and expiry

The lock owner is the coordinator process bound to the capability and epoch;
the journal stores only its digest. Acquisition is compare-and-set on an
unowned or expired GCS lock object and returns a monotonic fencing token.
Creation uses `ifGenerationMatch=0`; renewal, replacement, and takeover use
the exact observed lock-object generation and are bounded to precede expiry.
The lock is ownership/fencing metadata only, not the state source of truth:
the coordinator derives state from the validated contiguous transition
objects. Every mutation verifies the live fence and the applicable native
token, metadata observation barrier, or resource observation digest. An
expired owner cannot renew or mutate, even if its process later resumes.

An operator may not force-unlock a live owner by changing a marker in the
journal. After expiry, a new owner must re-read all cloud state and either
resume the exact epoch with a new fence or mark the epoch aborted and create a
new reviewed epoch.

### 9.3 Resume rules for every state

- **`PREPARED`**: reacquire the lock, validate the contiguous transition
  sequence, and re-read every precondition. Resume only if the old/desired
  packet digests and resource proofs still match; the desired provider-gate
  value is still only a manifest requirement here, while old serving
  revisions remain separately observed. Do not claim or reuse a desired
  runtime-gate observation until `STAGED` creates or reuses the exact
  no-traffic revisions.
- **`STAGED`**: verify each captured no-traffic revision ID/digest. Create or
  reuse only the deterministic-plan revision with identical inputs; never
  adopt a different revision or latest alias.
- **`PRODUCERS_CLOSED_ALIGNED`**: re-read the public schema, both named Vercel
  admission facts, Git-backed SHA, and both fingerprints. Re-close both
  Vercel gates if needed; stop on any producer drift. Do not infer the private
  worker gate from this public read.
- **`QUEUES_ALIGNED`**: re-read complete queue listings and aged scheduler
  pauses. Reassert pause only when the complete configuration observation
  digest still matches under the epoch lock; do not purge or replay work.
- **`INVOKERS_ROTATED`**: read both IAM policies. If desired additions are
  already exact, continue. If additions are partial, complete only the
  reviewed additions using a new etag. Retain old invoker/enqueuer grants
  until both revisions are exact; never restore the old policy automatically.
- **`SERVICES_PROMOTED`**: observe both serving revisions and promote only a
  missing captured revision after a fresh Cloud Run metadata
  generation/resourceVersion observation barrier under the GCS lock; the
  deploy/traffic request is not assumed to be conditionally bound to that
  metadata value. Read exact traffic and revision postconditions. Once both
  are exact, remove retired invoker/enqueuer grants with fresh IAM etags. If
  traffic or removal is ambiguous, keep both Vercel gates false and require
  an operator decision.
- **`VERIFIED`**: rerun all read-only proofs and provider-free probes; the
  validated `VERIFIED` transition alone cannot authorize activation.
- **`ACTIVATED`**: prove public readiness and both Vercel admission facts plus
  all four resumed resources. If activation is partial, close both Vercel
  gates and pause every resumed resource, preserve any newly admitted tasks,
  and record a bounded recovery result; no automatic IAM rollback or automatic
  empty-queue reproof is required after the public boundary has opened.

### 9.4 Resource concurrency and race handling

Every mutation follows the resource-specific protocol in section 6.4:

1. Read the exact resource and its native CAS token, metadata observation
   barrier, or complete observation digest, as applicable.
2. Compare that token/digest to the last proof and the protected expected
   resource key.
3. Acquire or confirm the GCS epoch-lock fence immediately before mutation.
4. For IAM, submit one etag CAS; for Cloud Run, issue one bounded deploy or
   traffic operation after a fresh metadata generation/resourceVersion
   observation under the lock, without assuming request-level conditional
   binding; for GCS, use object-generation preconditions; for Cloud Tasks,
   Cloud Scheduler, and Vercel, perform one bounded operation under the lock
   after the immediate observation re-read.
5. Read the resource back and verify its exact postcondition, including the
   complete observation digest for resources without native CAS.
6. Append the next transition object with the applicable token/digest only
   after the postcondition succeeds; creation uses `ifGenerationMatch=0` and
   the contiguous sequence is then revalidated.

A changed native CAS token, Cloud Run metadata observation, or observation
digest returns a race result, not a retryable success. The coordinator
re-observes from current state, bounded to a reviewed number of attempts, and
then stops closed. It never retries with a stale IAM etag, Cloud Run
resourceVersion observation, or GCS object generation; it never uses an
unconditional overwrite; and it never assumes a queue/scheduler observation
remains current without the immediate post-read.

### 9.5 Operator abort semantics

An operator abort is a durable marker bound to the epoch and lock fence. Before
the public activation boundary, the coordinator finishes the minimum safe
closure: set both Vercel gates false, pause any resumed queue or scheduler,
verify the pre-activation queues are paused/empty when safe, and keep
retention enabled. After the public boundary has opened, it still sets both
Vercel gates false and pauses any resumed resource, but it never purges or
discards newly admitted tasks; a non-empty queue requires operator
review/safe drain before retry. The private worker gate remains the exact
desired `INITIAL` setting. The coordinator does not delete service accounts,
restore ambiguous IAM, mutate payment state, or run a canary.

An abort before activation leaves staged revisions no-traffic and may leave
the exact desired IAM policy in place. A later attempt uses a new reviewed
epoch after fresh old-state and resource-token/observation-digest proofs; it
must not reuse an aborted epoch's capability. An abort after partial activation follows the
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
| Source | Desired manifest omits exact source/build/runtime inputs or deterministic revision naming plan | Rejected before staging. |
| Source | `STAGED` revision differs from desired inputs, is mutable latest, or its immutable ID/digest is not captured after creation | Rejected; later states cannot proceed. |
| Producer | Missing or mismatched preflight fingerprint | Rejected. |
| Producer | Missing or mismatched paid fingerprint | Rejected. |
| Producer | Project environment metadata is present but active Git-backed SHA/fingerprint is absent | Rejected; metadata is not active evidence. |
| Readiness | Strict v3 exact-key DTO preserves every v2 key and exact three-route object, adds only the two Vercel booleans, and contains no PII/protected values | Accepted only with string schema literal `analysis-public-freeze-readiness-v3`; unknown or removed keys fail. |
| Readiness | `ready=true`, `analysisV2AdmissionEnabled=false`, `earlybirdWebhookAutoAdmissionEnabled=false`, private worker gate true only in exact staged `INITIAL` revision | Valid through `VERIFIED`; aggregate ready is independent of both Vercel gates. |
| Readiness | `ready=false` with any Vercel admission combination | Rejected for state completion and activation; v2 aggregate semantics remain fail-closed. |
| Readiness | `ready=true`, public gate true, paid webhook false when desired is false | Valid activation fact only if that exact paid desired value was separately reviewed. |
| Readiness | `ready=true`, public gate true, paid webhook differs from its separately reviewed desired value | Rejected; the paid value is never inferred from the public gate. |
| Readiness | Public DTO contains `ANALYSIS_PROVIDER_ADMISSION_ENABLED` or a provider-admission boolean | Rejected; private worker gate is not publicly readable. |
| Readiness | Public v2 route object changes path, status, inner key, or gate-before-runtime semantics | Rejected. |
| Queue | Wrong exact resource, location, or complete configuration observation digest | Rejected; no invented queue etag/generation is accepted. |
| Queue | Either queue not PAUSED | Rejected and remains closed. |
| Queue | Either queue non-empty | Rejected; no purge, replay, or synthetic drain. |
| Scheduler | Either recovery scheduler not PAUSED | Rejected. |
| Scheduler | Pause epoch future, malformed, or younger than quiescence window | Rejected. |
| Scheduler | Wrong exact resource, location, or complete configuration observation digest | Rejected; no invented scheduler etag/generation is accepted. |
| Retention | Retention disabled or target drifted | Rejected; retention is never disabled to complete migration. |
| IAM | Desired add grant CAS succeeds and read-back is exact | Continue. |
| IAM | IAM etag changes between proof and mutation | Re-observe and fail/retry with fresh etag; stale CAS is never reused. |
| IAM | Old grant removal occurs before both role planes are exact | Reject the coordinator implementation and fixture. |
| IAM | Old grant removal is ambiguous | Remain closed; no automatic IAM rollback. |
| Cloud Run | Service metadata generation/resourceVersion changes between the fresh pre-mutation observation and exact post-read, or traffic read-back differs | Treat the metadata values as observation barriers under the GCS epoch lock, re-observe, and stop after bounded attempts; no request-level resourceVersion CAS is assumed. |
| GCS | Lock/journal object generation precondition fails | Reject stale owner; acquire a new fence or stop closed. |
| Observation race | Queue or scheduler complete configuration digest changes before or after mutation | Re-observe under the epoch lock; stop closed after bounded attempts. |
| State failure | Failure before `PREPARED` completion | No mutation; both Vercel gates remain false and no desired revision or private worker runtime gate is created or changed. |
| State failure | Failure before/after each `STAGED` revision | Existing exact revision is reused only when no-traffic and digest-exact. |
| State failure | Failure before/after producer alignment | Both Vercel gates remain false; private worker gate may be true only in exact no-traffic `INITIAL` revisions; no task is created. |
| State failure | Failure before/after queue alignment | Both queues/schedulers remain paused; no purge or replay. |
| State failure | Failure after each IAM add/remove mutation | Desired exactness is re-read; no guessed old-policy restore. |
| State failure | Failure after one service promotion | The promoted exact revision remains closed; missing role is promoted only from the captured revision. |
| State failure | Failure during verification/probe | Both Vercel gates remain false; private worker gate true does not create work without traffic; no provider or billable side effect. |
| State failure | Failure after public admission is true but before all resumes | Both Vercel gates close immediately, resumed resources pause, newly admitted tasks are preserved, and a non-empty queue requires operator review/drain before retry. |
| Resume | Crash at every state boundary | Journal resume revalidates current state and performs no duplicate unsafe mutation. |
| Resume | Same epoch and exact postcondition replay | No-op/idempotent completion. |
| Resume | Expired owner resumes | Old fence rejected; new owner must re-observe. |
| Probe | Authenticated malformed body for each role | Reviewed 4xx before provider/task/billing/user work. |
| Zero work | Full migration harness through `VERIFIED` | Zero provider calls, billable operations, user-work rows, task creations, and real canary calls before the public activation boundary. |
| Security | Journal and logs inspected for protected values | Only non-secret digests, slot names, markers, timestamps, and allowlisted codes are present. |

### 10.1 Readiness v3 consumer and test updates

The readiness v3 implementation and every consumer must be updated together:

- the public DTO schema test asserts the entire v2 key set and exact route
  object, then the additive v3 key set with string schema literal
  `analysis-public-freeze-readiness-v3`; it rejects unknown, removed,
  duplicate, or renamed keys;
- v2 `ready` semantics remain exact: known stage, drain-and-block mode,
  public freeze enabled, frozen legacy producer gate, non-null source SHA,
  and both producer fingerprint ready booleans; neither new Vercel boolean is
  folded into `ready`;
- the runtime computes both role fingerprints from its own canonical config
  and emits null/false evidence on missing or malformed config;
- the runtime emits `analysisV2AdmissionEnabled` and
  `earlybirdWebhookAutoAdmissionEnabled` as strict, independent, PII-free
  booleans and never emits the private worker gate;
- the release checker consumes the two named Vercel facts explicitly and
  never promotes based only on aggregate `ready`;
- coordinator tests require `ready: true`, both Vercel booleans false, and
  exact freeze/SHA/fingerprint/route evidence through `VERIFIED`; the private
  worker gate is checked from the exact revision manifest and is true for the
  desired `INITIAL` target;
- readiness tests cover `ready=true` with both Vercel booleans false,
  `ready=true` with public true and the separately reviewed paid value,
  `ready=true` with a paid-value mismatch, and `ready=false` under every
  boolean combination; no combination treats `ready` as admission proof;
- activation tests require public true plus the exact separately reviewed
  paid webhook value before scheduler/queue resume, without inferring one
  gate from the other;
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
2. Deploy additive readiness v3 with both Vercel work-producing gates false.
   Verify the full v2 key set and exact route object plus the two new
   PII-free Vercel admission facts, aggregate/readiness separation, both
   fingerprints, and the selected Git-backed source SHA without exposing
   protected values. The private worker provider-admission gate is checked
   only from staged Cloud Run revision/runtime evidence.
3. Prepare the protected release packet containing exact old and desired
   role-slot manifests, exact old source SHAs/revisions, desired
   source/build/runtime inputs and deterministic revision naming plan, exact
   queue/scheduler resources and observation digests, aged pause proofs,
   retention proof, desired IAM, Vercel SHA, and both producer fingerprints.
4. Start the guarded coordinator. It must complete `PREPARED`, then move
   through the states in order while both Vercel gates remain false. The
   desired private worker gate requirement is true in the reviewed manifest;
   `STAGED` then proves that value in the exact no-traffic `INITIAL`
   revisions.
5. At `VERIFIED`, review exact revisions, IAM, queue/scheduler state,
   readiness, fingerprints, source SHAs, and zero-work ledgers/logs.
6. Activate by proving public readiness true, public preflight/intake
   admission true, and the paid webhook boolean equal to its separately
   reviewed desired value. Then resume both recovery schedulers before either
   queue in the fixed role order. Legitimate work admitted after that public
   boundary may wait in a still-paused queue during the short resume window;
   verify the complete postcondition and retention.
7. Keep the final real Instagram/provider canary unrun. A user/operator may
   perform it later under the separate canary procedure after reviewing this
   evidence.

### 11.2 Rollback and closure

Rollback means restoring safe closure, not restoring an ambiguous IAM graph:

- set both Vercel admission gates false;
- pause any resumed recovery scheduler and queue;
- before public activation, re-prove both queues paused/empty where safe; after
  public activation, preserve any newly admitted task and require operator
  review/safe drain if a queue is non-empty; keep retention enabled;
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
native-token/observation digests, bounded timestamps, lock fences, state
markers, and allowlisted reason codes. Even a non-secret digest must not be
accompanied by the value it represents.

### 12.2 Observability

Emit structured, PII-free events for epoch creation, lock acquire/renew/lose,
state transitions, proof success/failure, native-token/observation races, CAS
outcomes, activation closure, and operator abort. Fields are limited to
epoch/manifest digests, abstract role/slot, state, fence, result code,
duration, and non-secret proof digests.

Alert on any of the following:

- either Vercel admission fact true before `ACTIVATED` or without the exact
  readiness/SHA/fingerprint proof;
- paid webhook auto-admission differing from its separately reviewed desired
  value at activation;
- private `ANALYSIS_PROVIDER_ADMISSION_ENABLED` absent or false in an exact
  desired `INITIAL` worker revision, or a provider call before the public
  activation boundary;
- a queue or recovery scheduler enabled while the epoch is not activated;
- provider, billable, user-work, or task activity before the public activation
  boundary while both Vercel gates are false;
- IAM mutation without the active epoch fence or a fresh CAS etag;
- Cloud Run traffic/revision mutation without the active epoch fence and fresh
  pre-mutation metadata generation/resourceVersion observation plus exact
  post-read;
- queue or scheduler mutation without the active epoch fence and immediate
  complete observation digest read-back;
- an old service account deletion request;
- a transition object appended without a postcondition digest or contiguous
  sequence proof; or
- readiness v3 emitting an unknown key or a protected value.

### 12.3 Operator checklist

Before starting:

- Confirm exact `origin/main` implementation baseline and CI revision.
- Confirm the protected old and desired manifests are complete for all eight
  slots plus build identity.
- Confirm pairwise desired distinctness, build distinctness, same-slot-only
  unchanged identities, and retirement of all shared/retired identities.
- Confirm exact old observed source SHAs/revisions and desired
  source/build/runtime inputs plus deterministic revision naming plan. After
  `STAGED`, confirm the two captured immutable revision IDs/digests.
- Confirm exact queue resources are PAUSED and empty, both recovery schedulers
  are PAUSED with aged pause epochs, and retention is enabled.
- Confirm the Vercel Git-backed SHA, both producer fingerprints, additive v3
  readiness `ready: true`, `analysisV2AdmissionEnabled: false`, and
  `earlybirdWebhookAutoAdmissionEnabled: false`. Confirm the private worker
  provider-admission value is true in the desired `INITIAL` manifest, not via
  the public DTO.
- Confirm the coordinator capability and single lock namespace are valid.

During migration:

- Keep both Vercel admission gates false, do not exercise signed/manual paths,
  and do not send real or paid provider work.
- Recheck the applicable native concurrency token or complete observation
  digest immediately before every mutation.
- Confirm no traffic on staged revisions and no mutable latest selector.
- Confirm desired IAM is exact before removing old invoker/enqueuer grants.
- Confirm both queues/schedulers remain paused and empty/quiescent.
- Confirm staged private worker provider-admission is true only in the exact
  no-traffic desired `INITIAL` revisions.
- Record only non-secret digests and allowlisted markers.

Before activation:

- Confirm exact source SHA/revision, producer fingerprints, IAM, queue,
  scheduler, retention, readiness, and zero-work proofs.
- Run only provider-free authenticated malformed-body probes and verify the
  reviewed 4xx responses.
- Confirm public readiness v3 proves `ready: true`,
  `analysisV2AdmissionEnabled: true`, and the exact separately reviewed
  `earlybirdWebhookAutoAdmissionEnabled` value only at the activation
  boundary; do not infer the private worker gate from this proof.
- Resume preflight scheduler, paid scheduler, preflight queue, then paid
  queue, checking each native token/observation digest first.
- Confirm the full activation postcondition and leave the real canary to the
  user/operator.

After failure or abort:

- Close both Vercel admission gates and pause every resumed work resource.
- Preserve retention and inspect protected ledgers through the authorized
  operator path.
- Preserve newly admitted tasks if the public activation boundary had opened;
  require operator review/safe drain before retrying a non-empty queue.
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

The document contains no implementation gaps or unresolved markers.
State entry and activation ordering are consistent: both Vercel gates are
false through `VERIFIED`, the private worker gate requirement is true in the
reviewed manifest at `PREPARED` and is proven true only from exact desired
`INITIAL` revisions from `STAGED` onward, desired IAM is exact before old
grant removal, exact revisions are promoted before verification, public Vercel admission is
proven true before both work planes resume, and retention remains enabled.
Every mutation has a preceding proof and a postcondition, native-token and
observation-digest races are bounded and fail closed, and
the document supplies the manifests, capability, state machine, recovery,
testing, rollout, and closure contracts needed by a separate implementation
plan writer without exposing protected values.
