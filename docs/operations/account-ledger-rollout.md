# Account-ledger rollout command

`npm run account-ledger:rollout` is the server-only activation command for the
account-principal bridge. It never accepts account identifiers, credentials, or
HMAC material as command-line arguments, and it emits aggregate-only JSON.

The default mode is a read-only audit. It recomputes the legacy E2E candidate
set in PostgreSQL, requires the frozen count, and timing-safely compares its
HMAC with the separately approved Keychain value.

## Keychain inputs

All values live under the `ai-baram-detector.account-ledger` Keychain service:

- `audit-secret-v1`: canonical base64url encoding of 32 random bytes.
- `expected-legacy-e2e-hmac-v1`: approved HMAC of the sorted legacy candidate
  set.
- `operator-account-id-v1`: the designated operator account UUID.
- `internal-tester-account-ids-v1`: a JSON array of designated internal-tester
  account UUIDs.

Runner credential records are created by the provision mode only, under the
Basic and Standard runner item names. They must not be copied into an env file,
shell history, a document, or test fixtures.

## Modes

```bash
npm run account-ledger:rollout
npm run account-ledger:rollout -- --mode plan
npm run account-ledger:rollout -- --mode apply --confirm-account-ledger-activation
npm run account-ledger:rollout -- --mode provision --confirm-account-ledger-activation
```

`audit` and `plan` do not mutate the database or Auth. `apply` is the only
mode that activates paid-ever replay; it first verifies the candidate HMAC,
builds a bounded all-principal classification payload in PostgreSQL, and then
uses the existing service-only classification RPC. Re-running `apply` with the
same active command version is aggregate-only and idempotent.

`provision` is unavailable until the account-ledger command version is active.
It creates or recovers exactly one Basic and one Standard Auth identity, stores
their credentials in Keychain, validates immutable runner metadata against the
database registry, and provisions each through the service-only RPC. It does
not mint an alternative admission or entitlement: fresh runs still use the
existing signed admission and signed entitlement flow.

Do not run a real migration push, `apply`, or `provision` until the linked
project's migration history is clean, the remote baseline audit matches the
approved counts, and a human has supplied the exact confirmation flag.
