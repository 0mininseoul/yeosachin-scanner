# Preflight pending display target refresh design

## Status and goal

Approved design for the standard `/analyze` preflight flow. After the create
request is accepted, keep a display-only, normalized Instagram username in
`sessionStorage` bound to that `preflightId`, so an ordinary iOS Safari reload
can continue to render `@username 계정 조회 중` while the preflight is pending.

This is a client-only UX recovery. It does not add username data to a URL or
API response, expand a database/schema contract, or change provider, B-lite,
payment, admission, polling, or pricing behavior. Landing marketing copy is
unchanged.

## Current context

- `app/analyze/page.tsx` resumes from `?preflight=<id>` (and the existing
  anonymous `claim` token), but only reads the existing bound `pending_ig`
  handoff for an authenticated owner.
- `hooks/useAnalysisV2Preflight.ts` sets `targetInstagramId` in memory on
  start/resume and replaces it with the server target on `ready`. A pending
  status response intentionally has no target field.
- `components/preflight-pending-status.tsx` renders the supplied target and
  falls back to `대상 계정` when it is null.
- `lib/services/pending-analysis-target.ts` owns the existing `pending_ig`
  storage, including its anonymous autostart and authenticated
  owner/preflight-bound modes. Its tests cover normalization, ownership,
  expiry, terminal cleanup, logout, and unavailable storage.
- `lib/services/analysis/preflight-client-races.test.ts` verifies synchronous
  consumed cleanup before redirect and the current resume/terminal contracts.

The current branch is at `origin/main` (`8bc15ddd`); no application change is
being made in this spec-only work.

## Alternatives

1. **Put the username in the resume URL.** Rejected: it leaks the target into
   browser history, copied links, referrers, and server/request logs, and is
   explicitly outside the approved design.
2. **Reuse `pending_ig` for the display record.** Rejected: that key already
   represents two different handoffs. Making its owner/preflight fields
   optional for a third meaning would make an unbound login target easy to
   mistake for a resumable preflight and could clear the wrong flow.
3. **Use a dedicated preflight-bound `sessionStorage` record (recommended).**
   Keep one small record under a new display-specific key, containing only the
   canonical username, `preflightId`, and bounded timestamp. It isolates the
   display concern, works for both anonymous and authenticated standard flows,
   survives same-tab reloads, and can reject stale/mismatched records without
   touching existing handoff behavior. Its trade-off is one additional helper
   and cleanup path.

## Architecture and storage contract

Extend the existing client storage module with a display-only record; do not
change the meaning or shape of `pending_ig`:

```text
key: preflight_display_target_v1
value: {
  preflight_id: <canonical UUID>,
  stored_at: <safe integer milliseconds>,
  target: <normalized Instagram username>
}
```

The helper should expose narrowly scoped operations equivalent to:

- `storePreflightDisplayTarget(storage, { preflightId, target, now? })`
- `readPreflightDisplayTarget(storage, { preflightId, now? })`
- `clearPreflightDisplayTarget(storage, preflightId)`
- `clearPreflightDisplayTargetForTerminalState(storage, { preflightId, status })`

The exact exported names may follow local naming conventions, but the boundary
must remain display-only and preflight-bound. Validate the UUID, normalize via
the existing Instagram username rules (trim, remove leading `@`, lowercase,
`[A-Za-z0-9._]`, max 30, and reject invalid dot placement), require a safe
timestamp, and use the existing 30-minute bounded lifetime. A malformed,
expired, or mismatched record is removed and treated as absent. Cleanup must
only remove a record when its stored `preflight_id` matches the requested ID.

The helper uses `availablePendingTargetStorage()` and catches all
`sessionStorage` access/serialization errors. Storage is best-effort: a quota,
private-mode, or unavailable-storage failure must not fail the accepted
preflight or alter its API state.

## Data flow and lifecycle

### Accepted response

1. The existing input validation and `normalizeInstagramUsername` path remain
   authoritative for the request.
2. After a current, schema-valid accepted response has attached its
   `preflightId`, store the already-normalized client target in the dedicated
   record. Do this only after acceptance and only for the standard `/analyze`
   flow; never persist on an unaccepted attempt or a stale request generation.
3. Continue the existing navigation with only `preflight` and (for anonymous
   claim continuation) `claim` query parameters. The username is never added
   to the URL.
4. Keep the existing `pending_ig` authenticated binding for OAuth/login
   handoff where it is currently required. The new record is not an owner
   credential and does not replace that handoff.

### Resume after reload

During `/analyze` initialization, once the `preflight` query ID is validated
and before calling `resumePreflight`, read the display record by that ID for
both anonymous and authenticated sessions. Pass the recovered normalized
target as the existing resume display value; the server status request still
uses the existing auth/claim checks. This makes the first pending render
immediate while `loadPreflight` fetches authoritative state.

If the record is absent, invalid, expired, or bound to another preflight, the
resume proceeds exactly as today and the component falls back to `대상 계정`.
The server response remains authoritative: a `ready` response replaces the
display value with `status.target.username`, and no storage value is used for
plans, eligibility, exclusion, checkout, or analysis execution.

### Terminal, reset, and consumed cleanup

- A non-pending terminal status (`ready`, `blocked`, `expired`, `failed`, or
  `completed` where represented by a caller) clears the matching display
  record after the status is accepted. `ready` cleanup is safe because the
  authoritative target is now in the response and the pending component is no
  longer shown.
- A `consumed` response clears the matching display record synchronously
  before the existing redirect to `/progress/<requestId>`, preserving the
  current consumed race guarantee.
- “대상 변경”/reset clears the active preflight's matching display record
  before resetting in-memory state and replacing the route. A new accepted
  preflight writes its own binding, so an old target cannot appear for it.
- Existing `pending_ig` terminal/reset/logout cleanup remains in place and is
  not broadened to infer or delete unrelated display records.

If a late response belongs to an older generation, the existing coordinator
must ignore it; it must not overwrite or clear the current preflight's display
record. A mismatched cleanup request is a no-op rather than a global delete.

## Error handling and privacy

- Storage read/write/remove errors are non-blocking and sanitized; no storage
  exception or raw target is sent to analytics or logged.
- The record contains no `userId`, claim token, request ID, profile data,
  payment data, or provider data. It is a same-origin, per-tab presentation
  cache with a 30-minute TTL, not an authentication or authorization artifact.
- Do not add the username to query parameters, API request/response schemas,
  Supabase rows, server logs, provider inputs, B-lite state, payment records,
  or analytics properties. Existing `data-amp-mask` behavior around the
  rendered target remains unchanged.
- If storage is unavailable, retain the current in-memory behavior and generic
  `@대상 계정 조회 중` fallback; never block polling or navigation.

## Implementation boundary (future change)

The implementation should be limited to:

- `lib/services/pending-analysis-target.ts`: dedicated record helpers.
- `lib/services/pending-analysis-target.test.ts`: pure storage/validation/
  expiry/terminal tests.
- `hooks/useAnalysisV2Preflight.ts`: persist only after the accepted standard
  response and perform matching terminal/consumed cleanup where the hook owns
  the lifecycle.
- `app/analyze/page.tsx`: read by `preflightId` before resume and clear the
  matching record on reset; preserve existing anonymous claim and authenticated
  handoff paths.
- `lib/services/analysis/preflight-client-races.test.ts` (and a focused
  analyze contract test if needed): verify resume ordering, consumed cleanup,
  and stale/mismatched record fencing.

Do not modify server preflight routes/contracts, `lib/contracts/analysis-v2.ts`,
Supabase migrations, provider/B-lite/payment code, or unrelated UI/refactors.

## Verification plan

### Unit and contract tests

- Store `@Target.Name` as `target.name` only after a valid preflight UUID;
  reject invalid username, UUID, timestamp, dot placement, malformed JSON,
  future/expired records, and storage exceptions.
- Read succeeds for the matching preflight ID and returns null while clearing
  a mismatched or stale record. A record for preflight A must survive a cleanup
  request for preflight B.
- Pending status retains the matching record; `ready`, `blocked`, and
  `consumed` clear it, with consumed removal occurring before redirect.
- Accepted standard responses persist for anonymous and authenticated callers;
  resume reads the record before `resumePreflight` and does not require a
  username query parameter. A missing record still resumes successfully.
- Reset clears only the active preflight display record. Existing `pending_ig`
  ownership/autostart/logout tests remain green unchanged.

### Browser acceptance

For both an anonymous claim URL and an authenticated preflight URL, start a
preflight, reload the same `/analyze?preflight=<id>` tab while status is
pending, and verify the UI keeps `@<normalized username> 계정 조회 중` while
polling continues. Verify terminal ready/blocked and target reset remove the
display record. Verify no URL contains the username. If iOS Safari automation
is unavailable, keep the same-tab reload scenario as a manual acceptance case;
unit/contract tests must still cover the ordering and cleanup guarantees.

Run the focused Vitest files, then the repository lint/build checks required by
the implementation workflow. This document intentionally contains no
application implementation or test changes.

## Self-review

- **No unresolved placeholders:** helper names are intentionally descriptive
  but allow local naming alignment.
- **Consistency:** the dedicated key is never read as `pending_ig`; anonymous
  and authenticated resume use the same preflight binding; server state remains
  authoritative after reload.
- **Scope:** one client storage helper plus standard `/analyze` lifecycle
  wiring; no server/schema/provider/B-lite/payment work or unrelated refactor.
- **Ambiguity resolved:** “terminal” means every non-pending preflight outcome,
  including `ready`, plus `consumed`; cleanup is always preflight-ID matching.
  “After accepted” means after schema validation and current-generation attach,
  not on input, before POST, or after a stale response.
- **Overengineering check:** one record, one TTL, and best-effort storage are
  sufficient; no URL target, cookie, database field, encryption, multi-record
  index, or new state machine is introduced.
