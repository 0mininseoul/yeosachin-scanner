# Production preflight stale invoker cleanup

Date: 2026-09-06 (Asia/Seoul)

This investigation re-derived the dedicated production preflight receiver,
removed exactly one stale service-level `roles/run.invoker` member, and
verified the receiver and queue invariants afterward. The report is
intentionally sanitized: it contains no project or service names, regions,
URLs, identity values, task/request IDs, tokens, credentials, or payloads.
Values that identify control-plane objects are represented only by booleans,
counts, and SHA-256 digests.

## Scope and baseline

| Check | Result |
| --- | --- |
| Fresh worktree is clean | true |
| Worktree `HEAD` equals exact `origin/main` | true |
| Repository source files changed | false |
| Cloud Run services inspected in the configured region | 5 |
| Preflight-shaped candidates | 2 |
| Candidate matching canonical preflight target and audience | 1 |
| Unique dedicated production preflight service | true |
| Selected service digest | `9390329dcb395778cf614b44bcd2849cdc69865df16afee37e1685388d236332` |

The candidate was selected only when its enabled preflight configuration,
project/location/queue settings, task caller, target, and audience matched the
canonical preflight configuration. The second preflight-shaped candidate had a
different target/audience pair and was not touched.

## Receiver and identity derivation

| Check | Result |
| --- | --- |
| Receiver target matches canonical target | true |
| Receiver audience matches canonical audience | true |
| Receiver target and audience share an origin | true |
| Receiver is Ready | true |
| Receiver has a single 100% traffic allocation | true |
| Receiver generation present | true |
| Receiver generation digest | `8527a891e224136950ff32ca212b45bc93f69fbb801c3b1ebedac52775f99e61` |
| Current revision digest | `60e3586e2a4cec6b761ce6b0248ab57ffbc94150fe5453b4ab30f40597f51e91` |
| Current receiver task caller present | true |
| Current receiver task caller digest | `1dd8988303176b7ecb660f0fdf278c2983eb73c9776204e51720a5e216f620de` |
| Current receiver task caller matches canonical caller | true |
| Maintenance caller present | true |
| Maintenance caller digest | `a095e93fbbcec97714375c39fbf6d30a4f1dfc741166fdfb9ff6bd80704f9605` |
| Runtime identity present | true |
| Runtime identity digest | `42a165dbdb0fee4e076c5f894f3049697b6b98c013c94a46dfec6acc97d43722` |

Revision history was read-only re-derived before the change:

| Check | Result |
| --- | --- |
| Receiver revisions readable | 10 |
| Revision describe failures | 0 |
| Revisions carrying the stale caller, total | 9 |
| Historical revisions carrying the stale caller | 9 |
| Current corrected revision carries the stale caller | false |
| Digest of matching revision-name set | `a6015085e37a6affd43c0784231635732f308227ad5ee595969ce3f2e2830678` |
| Current revision task caller matches canonical caller | true |

## Pre-mutation IAM classification

The service-level policy was fetched immediately before mutation. Its etag was
present and retained in the proposed policy file.

| Check | Result |
| --- | --- |
| IAM etag present | true |
| IAM etag digest | `44702e4fc6c525b54c301f6148a78c0635668ca5820908b13ff1af9c258635c1` |
| Normalized IAM policy digest before | `7a89c6ed212eb2aa9a954aa48819e9e25c1e167ee0cb23ee375f548f9c9ac2a5` |
| `roles/run.invoker` binding count | 1 |
| Invoker member count | 3 |
| Invoker bindings with conditions | 0 |
| Public invoker member count | 0 |
| Non-public invoker member count | 3 |
| Current task caller is an invoker | true |
| Maintenance caller is an invoker | true |
| Runtime identity is an invoker | false |
| Cloud Tasks service agent is an invoker | false |
| Stale candidate count after allowed-principal subtraction | 1 |
| Stale candidate digest | `6e7ba25c5b6bbb431bc3e684b97332e620e8f0a2c06177ac72af9deb8f1dded6` |
| Stale candidate is unconditioned and non-public | true |
| Stale candidate is not the current task caller | true |
| Stale candidate is not the maintenance caller | true |
| Stale candidate is not the runtime identity | true |
| Stale candidate is not the Cloud Tasks service agent | true |

This proves the independent classification using only aggregate facts: the
policy had exactly one extra unconditioned, non-public member; that member
matches nine historical receiver revisions; and it matches none of the
current task, maintenance, runtime, or Cloud Tasks service-agent identities.

## IAM change

The change used one `set-iam-policy` request with the immediately fetched etag
preserved in the policy document. The resulting semantic delta was guarded
before the request.

| Check | Result |
| --- | --- |
| Proposed policy retained the fetched etag | true |
| Semantic members removed | 1 |
| Semantic members added | 0 |
| IAM mutation succeeded | true |
| Normalized expected policy digest | `d59934e23af7a09720945657715248cbf1eda134eb601d9ad2795a5cc02730e4` |

## Post-mutation verification

| Check | Result |
| --- | --- |
| IAM etag present after change | true |
| IAM etag changed | true |
| IAM etag digest after | `de5c1e57c2d77b5c79d6bb302201bd5c7a801cefc56cbf56369a5f0735b43439` |
| Normalized IAM policy digest after | `d59934e23af7a09720945657715248cbf1eda134eb601d9ad2795a5cc02730e4` |
| Post-policy equals expected policy | true |
| Unrelated roles/bindings preserved | true |
| `roles/run.invoker` binding count | 1 |
| Exact invoker member count | 2 |
| Invoker bindings with conditions | 0 |
| Public invoker member count | 0 |
| Non-public invoker member count | 2 |
| Current task caller remains an invoker | true |
| Maintenance caller remains an invoker | true |
| Runtime identity is an invoker | false |
| Cloud Tasks service agent is an invoker | false |
| Stale member remains an invoker | false |
| Unclassified invoker member count | 0 |
| Exact current task + maintenance invoker set | true |

Cloud Run and queue state were re-read after the IAM update:

| Check | Result |
| --- | --- |
| Cloud Run service generation unchanged | true |
| Cloud Run service spec/env digest unchanged | true |
| Cloud Run traffic/revision digest unchanged | true |
| Cloud Run control-plane digest unchanged | true |
| Queue state before | `RUNNING` |
| Queue task count before | 0 |
| Queue state after | `RUNNING` |
| Queue task count after | 0 |
| Queue remains running and empty | true |
| Receiver remains Ready | true |
| Receiver remains single-revision 100% traffic | true |
| Current revision task caller still matches canonical caller | true |
| Current revision still does not carry stale caller | true |

The normalized Cloud Run service spec digest was
`eba3d81e5ceee629c6efc395c4f96ad06d0c059a51a38cbd509f4e48c15c5ac0` both
before and after. The normalized traffic digest was
`be2b474be5cf877384c71773f82fa0e2c250aead32d12de370b16aafa1d07797` both
before and after.

## Corrected-revision and provider-free verification

Logs were queried only for the current corrected revision from its creation
timestamp forward; no log entry, identity, URL, ID, or payload was emitted.

| Check | Result |
| --- | --- |
| Corrected-revision 401 query readable | true |
| New corrected-revision HTTP-401 count | 0 |
| Corrected-revision log query readable | true |
| Corrected-revision log record count | 114 |
| Provider-keyword record count | 1 |
| Provider-keyword HTTP record count | 0 |
| Provider-keyword text-payload record count | 0 |
| Provider-keyword JSON-payload record count | 0 |
| Provider-keyword control-plane audit record count | 1 |
| Provider invocation signal count | 0 |
| Apify/Gemini/Vertex/B-lite invocation observed | false |

The one provider-keyword record was control-plane audit-only: it had no HTTP,
text, or application JSON payload shape. No task was created, retried, or
deleted for this cleanup, and no Apify, Gemini, Vertex, B-lite, payments,
Vercel, Supabase, expired-row, or provider mutation was performed.

Status: **DONE**
