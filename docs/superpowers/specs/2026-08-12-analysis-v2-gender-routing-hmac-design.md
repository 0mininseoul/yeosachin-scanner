# Analysis V2 Gender-Routing HMAC Design

## Goal

Provision and inject a dedicated Secret Manager HMAC for the reviewed Basic and
Standard `test_entitlement` gender-routing path without changing ordinary
production or Plus execution.

## Chosen approach

The canonical worker receives one exact Secret Manager reference named
`ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET`, backed only by the new
`ai-baram-v2-gender-routing-hmac` resource and a positive numeric version.
The existing secret lifecycle script owns creation, scoped runtime-service
account IAM, version verification, explicit rotation, and source-boundary
validation. The deploy script owns Cloud Run injection and verifies that both
the service template and serving revision have exactly one non-plaintext,
numeric-pinned reference.

This follows the existing preflight identity HMAC model rather than creating a
separate test worker or reusing another HMAC. A separate worker would change
the established routing topology, while reuse would weaken purpose isolation.

## Safety invariants

- The resource is distinct from Supabase, provider, image, and preflight
  secrets; it receives only the runtime identity's resource-scoped accessor
  binding.
- Apply, dry-run, and check require the dedicated numeric version pin where
  the corresponding existing lifecycle guarantees require pins. `latest`,
  duplicate entries, missing refs, wrong secret IDs, and plaintext values fail
  closed.
- Secret values are never rendered to output, runtime manifests, docs, or
  shell traces. Source values remain in an outside-repository dotenv and are
  streamed directly to Secret Manager stdin only when a version is created.
- Existing service and serving-revision invariants remain intact. The
  application consumes this injected value only for the narrow Basic/Standard
  `test_entitlement` routing lineage, so normal production and Plus behavior
  does not change.

## Verification

The shell fixtures will prove lifecycle creation, numeric pinning, exact IAM,
source-value validation, no value leakage, and Cloud Run injection/verification
for the new ref. Deployment fixture cases will additionally reject absent,
wrong, duplicate, plaintext, and unpinned gender-routing references while
retaining existing preflight HMAC rotation protection.
