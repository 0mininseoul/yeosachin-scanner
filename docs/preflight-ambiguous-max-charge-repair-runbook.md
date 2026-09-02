# Retained anonymous preflight identity-drift repair

This runbook is for the narrowly scoped, owner-only repair introduced by the
identity-drift migration. It is a manual, fail-closed action for an expired,
PII-scrubbed anonymous preflight whose retained provider input hash differs
from the retained preflight target hash and whose historical start cannot be
proved either way.

## Before the change

1. Confirm that the migration is present in the reviewed branch and has not
   been applied to the production database.
2. Use a direct database connection as the database owner. The candidate-list
   function is deliberately revoked from `PUBLIC`, `anon`, `authenticated`,
   and `service_role`; the generator must not use a REST endpoint or a service
   key.
3. Write output to a new path outside the repository. The generator requires
   an absolute `--output-file`, creates it exclusively with mode `0600`, and
   never writes candidate identities or SQL to stdout. Keep the generated file
   in an access-controlled temporary directory and remove it after review.
4. Store the external evidence reference in a regular file outside the
   repository with mode `0400` or `0600`. The generator hashes the reference
   and emits only the lowercase SHA-256 digest; never put the reference itself
   in the SQL, terminal, issue, or review.

Run the read-only candidate listing from the repository root:

```sh
DATABASE_URL='[owner-only direct database connection]' \
  npx tsx scripts/repair-preflight-ambiguous-max-charge.ts \
  --list --limit=20 --output-file='/secure/tmp/identity-drift-candidates.json'
```

Review only the PII-free fields in that file: `preflightId`, `operationKey`,
`inputHash`, `logicalProvider`, `actorId`, `credentialSlot`, `maxChargeUsd`,
and `reservedAt`. Do not add target handles, provider payloads, run IDs,
tokens, account identifiers, or evidence references to the file.

## Candidate gate

Every candidate must be checked against the exact values returned by the
owner-only list function and the incident record:

- `user_id` is null and `provider_selector` is `anonymous_apify`.
- The preflight is `expired`, PII-scrubbed, and both its expiry and last update
  are at least seven days old.
- The provider row is `starting`, has no `run_id`, has the exact operation,
  input hash, provider, actor, credential slot, maximum charge, and reservation
  timestamp supplied to the repair.
- The provider reservation and update are at least seven days old; the
  provider input hash is distinct from the preflight target hash.
- The preflight lease and every matching admission lease are absent or
  expired. A live lease is a hard stop.
- An existing PII-free `INTERNAL_ERROR` failure receipt is present. Do not
  edit, delete, or recreate it.
- Historical evidence establishes identity/configuration drift but cannot
  prove that no provider start occurred. Therefore the maximum charge is
  retained conservatively; no run ID is fabricated and the row is never
  changed to `resolved_no_run`.

If any value differs, stop. Do not retry the candidate, call an older resolver,
or widen the candidate query.

## Generate and review the owner statement

Use the exact candidate values and an explicit confirmation token. The command
only writes a SQL artifact; it does not execute the resolver:

```sh
npx tsx scripts/repair-preflight-ambiguous-max-charge.ts \
  --resolve \
  --preflight-id='[candidate UUID]' \
  --operation-key='target-profile-fallback' \
  --input-hash='[64 lowercase hex characters]' \
  --logical-provider='apify' \
  --actor-id='apify/instagram-profile-scraper' \
  --credential-slot='[validated slot]' \
  --max-charge-usd='0.002600000000' \
  --reserved-at='[candidate reservation timestamp with timezone]' \
  --evidence-reference-file='/secure/incident-reference.txt' \
  --confirm='I_VERIFIED_HISTORICAL_IDENTITY_DRIFT_AND_MAX_CHARGE_REPAIR' \
  --output-file='/secure/tmp/identity-drift-repair.sql'
```

Review the artifact out of band. It must contain exactly one call to
`resolve_analysis_preflight_provider_run_identity_drift`, the nine exact
candidate arguments, and an evidence digest. It must not contain a raw
evidence reference or any provider payload.

Execute the statement only in an owner SQL session after repeating the gate.
The resolver locks the preflight before the provider row, rechecks every
immutable identity, rechecks the seven-day fence and live-lease absence, then
updates only the mutable terminal/usage/evidence fields. `run_id` remains null;
`actual_usage_usd` is the retained `max_charge_usd`; and the terminal status is
`resolved_identity_drift`.

## Verify and close

After the owner statement commits, verify through an owner-only read that:

- the provider row is `resolved_identity_drift`, has no run ID, and has
  `actual_usage_usd = max_charge_usd` with a non-null usage reconciliation
  timestamp;
- the evidence column contains only the expected digest;
- exactly one `provider_start_identity_drift` acquisition-cost event exists
  for the candidate, with terminal status `resolved_identity_drift`, maximum
  charge and actual usage equal to the retained maximum, and the same evidence
  digest;
- replaying the exact statement is successful and creates no second event;
- replaying with any changed identity or evidence value fails closed; and
- the existing `INTERNAL_ERROR` receipt is unchanged.

The normal purge function is intentionally not redefined by this migration and
its existing allowlist does not include `resolved_identity_drift`. These rows
and their receipts therefore remain retained for a separately reviewed
historical decision. Do not alter payment, queue, worker, scheduler, hosting,
or remote-database configuration as part of this repair.
