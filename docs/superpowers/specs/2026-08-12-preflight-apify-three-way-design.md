# Preflight Apify Three-Way Distribution Design

## Goal

Distribute new preflight Apify profile fallbacks evenly and deterministically across the primary, secondary, and quaternary credentials without changing retry identity or adding cross-account failover.

## Design

`selectPreflightApifyCredentialSlot` hashes the normalized preflight UUID and maps the result modulo three to `primary`, `secondary`, or `quaternary` when all three tokens are configured. Existing provider-run rows remain authoritative, so retries resume the stored credential slot. If the three-way credential set is incomplete, selection falls back to the existing Analysis V2 configured slot rather than silently creating a smaller pool.

Random selection is rejected because it is not reproducible. Automatic account failover is rejected because an ambiguous Apify start could create duplicate runs and charges.

## Scope

- Change only the preflight fallback slot selector.
- Keep beta pool routing and paid analysis routing unchanged.
- Preserve existing provider-run checkpoint behavior.
- Verify deterministic three-way coverage, case normalization, and incomplete-pool fallback.
- Deploy the worker with the already configured quaternary secret reference and confirm traffic/provenance.

## Failure Investigation

The latest Cloud Run `preflight.failed` burst is classified as retryable `PREFLIGHT_PERSISTENCE_ERROR`, not an Apify provider failure. Investigation therefore treats it separately from slot distribution and verifies the current persistence path before deployment.
