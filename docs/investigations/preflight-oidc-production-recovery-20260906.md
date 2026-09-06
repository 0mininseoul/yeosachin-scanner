# Production preflight OIDC recovery

Date: 2026-09-06 (Asia/Seoul)

This report is intentionally sanitized. It contains no service-account
addresses, credentials, full URLs, task names, request IDs, cookies, or
request bodies.

## Outcome

The dedicated preflight worker had an application-level OIDC caller mismatch
after the earlier private Cloud Run invoker correction. The producer caller
identity declared by the canonical main `.env.local` was present, while the
deployed receiver's `PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL` was different. The
Vercel project Production env is configuration intended for the next
deployment, not proof of values loaded by the currently serving deployment;
active-runtime producer proof is deferred to the fingerprint guard branch. The
receiver therefore returned application `401 / UNAUTHORIZED` before parsing a
task, while the corrected incident path is proven by actual queue-OIDC
400/`INVALID_REQUEST` and zero-401 logs.

Only the dedicated worker's receiver-caller environment value was corrected.
The new revision was staged with no traffic, reviewed, and then promoted to
100% traffic. No source files or application code were changed.

## Boolean control-plane evidence

| Check | Result |
| --- | --- |
| Checkout equals fetched `origin/main` | true |
| Canonical producer identity present | true |
| Canonical producer equals Vercel project Production env intended for the next deployment | true (configuration comparison only) |
| Receiver expected caller present before change | true |
| Producer equals receiver expected caller before change | false |
| Dedicated receiver target and audience origins match | true |
| Current queue target and audience origins match | true (approved trace evidence) |
| Receiver target/audience unchanged by correction | true |
| Service-level unconditional `roles/run.invoker` contains producer | true |
| Public invoker members absent | true |
| Queue state remains `RUNNING` | true |

The canonical local target/audience pair was internally consistent but pointed
at the legacy worker origin rather than the dedicated receiver. That local
target drift is not authoritative for the preserved live queue/receiver target,
was not used as producer proof, and was not changed. The approved production
target and audience were preserved, and the correction was limited to the stale
receiver caller value. Vercel marks the project Production target/audience
values sensitive, so their values were not retrieved or emitted; the deployed
receiver and queue control-plane origins were compared without exposing them.

## Guarded-path decision

The guarded capacity queue check was run read-only. It verified the task and
enqueuer accounts, Cloud Tasks API, service-agent role, and keyless/project-role
constraints, then stopped on the pre-existing task-identity IAM drift marker.
No queue or IAM mutation was made.

The full guarded capacity deploy was not used because it performs a source
build and re-applies the complete runtime manifest, secret references, scaling,
and role gates. The incident was one receiver environment value, so a narrowly
scoped Cloud Run revision update was safer and had a smaller blast radius.

## Change and staging review

The dedicated service was updated with the equivalent of:

```text
gcloud run services update <dedicated-preflight-service> --no-traffic \
  --update-env-vars=PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL=<producer-identity>
```

The staged revision was Ready and had zero live traffic. Before promotion,
fresh control-plane comparisons proved:

- only `PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL` changed;
- all other environment values and Secret Manager references were unchanged;
- runtime identity, CPU/memory, concurrency, timeout, scale limits, and
  private-authenticated ingress were unchanged;
- target and audience were unchanged;
- service-level IAM and queue state were unchanged; and
- the pre-existing live traffic allocation was unchanged.

The exact reviewed Ready revision, rather than `latest`, was promoted to
100%. Post-promotion checks confirmed single-revision 100% traffic and all of
the invariants above.

## Provider-free authentication verification

The operator could not mint a producer identity token directly because the
active operator lacked the token-creator permission. To test the actual queue
OIDC path without touching an owner request, a one-off synthetic malformed-body
task was created on the existing queue with the producer OIDC identity and
then deleted after its first response. The body was intentionally invalid, so
the worker could reject it before any provider or analysis work.

On the corrected revision, the fresh log aggregate showed:

| Observation window | Result |
| --- | ---: |
| Worker route application 400 completions | 1 |
| `INVALID_REQUEST` failures | 1 |
| Worker route application 401 completions | 0 |
| Request-log HTTP 401 responses | 0 |
| Request-log HTTP 400 responses | 1 |
| Recovery route HTTP 200 completions | 6 |

The synthetic task was the only task created and was deleted after observation.
No expired row was changed or retried, and no owner target account was
invoked. Apify, Gemini/Vertex, B-lite inference, payments, and external
provider calls were not invoked.

## Remaining concern

The independent task-identity act-as checker remains red from before this
change. It was intentionally left untouched because repairing it would be a
separate IAM operation, outside the receiver-only correction, and was not
needed for the verified queue OIDC caller or private service invoker binding.

Status: **DONE_WITH_CONCERNS**
