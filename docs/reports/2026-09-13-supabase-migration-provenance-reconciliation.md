# Supabase migration provenance reconciliation

Status: `BLOCKED_NO_CHANGE`

Observation date: `2026-09-13` (Asia/Seoul)

Source revision: `origin/main` at `72f9ed4e1795038f6ac9de9e51265c16d7f45b1f`

Remote read path: `npx --yes supabase@2.102.0 migration list --linked` and
`db query --linked`, from `/private/tmp/yeosachin-predeploy.6QZ9Lr`. No
production migration, migration repair, DDL, DML, RPC, payment-state change,
or application/landing-copy change was performed. The committed report does
not contain SQL bodies, user identifiers, credentials, or raw rows.

## Result

The local and remote histories each contain 391 distinct versions, but the
version sets differ by exactly six on each side. No local-only version has an
exact SQL equivalent among the six remote-only statements, and no semantic
replacement pair is proven across the two sets. The only proven supersession
is internal to the local source chain: `20260805050000` depends on and
supersedes the Standard-only branch introduced by `20260805001619`; both
remain absent from remote history.

Therefore no safe minimal history remediation is proven. Do not replay the
local files, add guessed placeholders for remote history, or run
`migration repair`/`db push` to force convergence.

## Local-only evidence and disposition

The blob and SHA-256 values below identify the exact files at the target
revision; the disposition is deliberately explicit rather than an inferred
pairing.

| Version and file | Git/source evidence | Disposition |
| --- | --- | --- |
| `20260805001619_remove_server_inventory_gate.sql` | blob `4f4184f78bffcb5c33899f8bc0b8c0da50ea9af4`; SHA-256 `24856ad9274f811213ee2dd336e52c59dcba0278346f10384cfe19ee08dd48ed`; introduced as `8c96a37b`, refined as `a33fa319` | `LOCAL_ONLY_UNPAIRED`; local-chain predecessor of `20260805050000`, not a remote equivalent |
| `20260805014000_skip_paid_relationship_precheck_for_selfhosted_auth.sql` | blob `00fde0b6f2583e9d069b542ac795def34edcb1d2`; SHA-256 `649786cd14ef220969860a03e8e9add1f687ee3e0bb76faf901c6be74660f2b8`; added in `a33fa319` | `LOCAL_ONLY_UNPAIRED`; relationship precheck patch has no matching remote target statement |
| `20260805023000_skip_paid_target_prechecks_for_selfhosted_auth.sql` | blob `56755dec169f3ed4ff9838d24c24e82a33257ab3`; SHA-256 `cd74e42a8dfa058ee682c318490a1c777a1ed4eb8ef85c6bc9916c97d7856e0d`; added in `a33fa319` | `LOCAL_ONLY_UNPAIRED`; target precheck patch has no matching remote target statement |
| `20260805025000_allow_selfhosted_auth_relationship_source_status.sql` | blob `9fefe277272e5044003579bee11e09d20adbc258`; SHA-256 `d8703fed00b00d378418206644bc8dbd5d0d7ed616b6722d6c7244583d945a23`; added in `a33fa319` | `LOCAL_ONLY_UNPAIRED`; constraint change has no matching remote target statement |
| `20260805050000_remove_paid_server_inventory_gate.sql` | blob `e6b70990fc1cf8447c70af0a1e4219bb03081f7c`; SHA-256 `6cc4d178ce1b2fcdd427d6a25d6356346f7029db77aa2e563e0d3b3ff2ddb631`; added in `42ac34ce` | `LOCAL_ONLY_UNPAIRED`; local-chain supersession of `20260805001619`, not a remote equivalent |
| `20260813233000_allow_anonymous_preflight_slot_validator_exec.sql` | blob `0039246af4bcc84456bf149e564a6e9df2890454`; SHA-256 `43c8988bd7a809dee318f5f9243f30e9bb69b0c79bf8ca9c1cd241298e0f3f1f`; added in `c2d18d8b` | `LOCAL_ONLY_UNPAIRED`; ACL grant has no matching remote target statement |

The local selfhosted-auth files form one coherent local series, but that is
not evidence that any remote-only row replaced them. The remote catalog does
show the relationship and target routines with the selfhosted-auth marker;
that proves current behavior only, not which migration history row supplied
it.

## Remote-only evidence and disposition

The metadata is an aggregate of the `statements` array using newline joining;
the MD5 values are of that aggregate. SQL bodies were retained only in the
isolated temporary read workspace for comparison and are not committed.

| Version | Remote `name` | Statements / chars / MD5 | Git/source disposition |
| --- | --- | --- | --- |
| `20260814110000` | `rearm_concierge_snapshot_conflict_execution` | 8 / 9285 / `58660ce7d4e0fb061aafe200ad48967f` | `REMOTE_ONLY_UNRESOLVED`; defines a rearm routine, but no matching path/blob exists in all Git refs |
| `20260814111000` | `reopen_concierge_snapshot_cleanup_intent` | 8 / 7740 / `fd1e84a89bc02978a128d008d75deda5` | `REMOTE_ONLY_UNRESOLVED`; rewrites the provider-run cleanup routine, but no matching path/blob exists in all Git refs |
| `20260823165841` | `add_incident_gender_review_correction` | 3 / 3015 / `6bbfb9a8ea0af4db55dbe382dff5b6ef` | `REMOTE_ONLY_EXACT_SOURCE_RECOVERABLE`; canonical SQL matches the file from non-main commit `9fc65c76` (SHA-256 `127249a95db12a36461851e131375c031e5cf192cd863f0edcf9267f746c1287`), which is not an ancestor of `origin/main` |
| `20260824151600` | `publish_incident_reviewed_result_copy` | 3 / 6473 / `ac1c6676a612ea3d152a115cb7dfab7e` | `REMOTE_ONLY_EXACT_SOURCE_RECOVERABLE`; canonical SQL matches the file from non-main commit `9042120d` (SHA-256 `61c02d274685734e4e76e494b845fdfd365a6f983fb7ca2edf719d2b3ab52b44`), which is not an ancestor of `origin/main` |
| `20260824152500` | `normalize_incident_reviewed_copy_subjects` | 3 / 1899 / `daf98debfd9b5dd11d2a08c7432f5361` | `REMOTE_ONLY_EXACT_SOURCE_RECOVERABLE`; canonical SQL matches the file from non-main commit `6bdb5149` (SHA-256 `fb288103bd1b4d4d7fc635c6d106a8829322f2853751ff6baae9b4b1ad306124`), which is not an ancestor of `origin/main` |
| `20260824160500` | `publish_incident_media_reviewed_result_copy` | 3 / 7206 / `2b3b8369b27a5b0cc1e137371f11e587` | `REMOTE_ONLY_EXACT_SOURCE_RECOVERABLE`; canonical SQL matches the file from non-main commit `0c52c100` (SHA-256 `89c6254cb74ee4e493144749694de74617df197f9451191795faf282cc6dfcd6`), which is not an ancestor of `origin/main` |

For the four recoverable rows, the comparison accounts for Supabase's
statement-array serialization (statement separators and blank separator lines)
and then produces identical canonical text. This is exact provenance to the
non-main Git commits, not equivalence to any local-only file. The two August
14 rows remain unresolved even though later source contains body-fingerprint
anchors for their routine signatures; those anchors are not the original
migration sources.

## Explicit six-by-six pairing matrix

Every cell is `∅` (`NO_EQUIVALENCE_PROVEN`). Similar words such as
“inventory”, “cleanup”, or “concierge” were not treated as equivalence.

| Local \ Remote | `14110000` | `14111000` | `23165841` | `24151600` | `24152500` | `24160500` |
| --- | --- | --- | --- | --- | --- | --- |
| `05001619` | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ |
| `05014000` | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ |
| `05023000` | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ |
| `05025000` | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ |
| `05050000` | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ |
| `13233000` | ∅ | ∅ | ∅ | ∅ | ∅ | ∅ |

## Minimum safe remediation and rollback

1. Keep the six local-only files and six remote-only history rows unchanged;
   retain the divergence as a fail-closed provenance blocker.
2. Before any future convergence decision, obtain owner-reviewed source for
   both unresolved remote rows and independently verify current routine bodies,
   ACLs, constraints, dependencies, and the exact remote statement arrays.
   The four non-main source files may be restored only as reviewed provenance
   artifacts; importing them into the canonical migration path is not implied.
3. Do not use `migration repair`, `db push`, or replayed SQL as a substitute
   for missing provenance. A metadata repair would assert a history claim that
   this audit cannot prove, while replay could duplicate already-live behavior.

No production change means no database rollback is required. If this report is
rejected, the reversible action is a Git revert of its documentation commit;
no production history or payment state needs to be touched.

No tests or CI were run, as this read-only audit made no runtime or migration
implementation change.
