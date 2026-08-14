# Preflight Refresh Display Target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the normalized Instagram username in a preflight-bound, display-only `sessionStorage` record so a same-tab `/analyze` reload can render the pending target for anonymous and authenticated standard preflights.

**Architecture:** Add one best-effort storage boundary beside the existing `pending_ig` handoff without changing that key's meaning. The standard preflight hook writes the record only after the accepted response is schema-valid and attached to the current generation; `/analyze` reads it before resume, while current server status remains authoritative and matching lifecycle cleanup removes it on terminal, consumed, or reset paths.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Vitest, browser `sessionStorage`.

---

## File structure

- Modify `lib/services/pending-analysis-target.ts`: add the dedicated `preflight_display_target_v1` record helpers; leave all `pending_ig` shapes and behavior unchanged.
- Modify `lib/services/pending-analysis-target.test.ts`: cover display-record normalization, UUID/TTL validation, preflight fencing, terminal cleanup, and fail-open storage errors alongside the existing handoff tests.
- Modify `hooks/useAnalysisV2Preflight.ts`: persist only after an accepted standard response is attached to the current coordinator generation; clear the matching display record when accepted status is terminal, including synchronous consumed redirect cleanup.
- Modify `app/analyze/page.tsx`: read the display record before `resumePreflight` for both anonymous and authenticated URLs, preserve the authenticated `pending_ig` handoff fallback, and clear only the active display record on reset.
- Modify `lib/services/analysis/preflight-client-races.test.ts`: verify consumed ordering, pending retention, generation fencing, accepted-write placement, resume ordering, reset scoping, and the unchanged URL/API boundary through focused source/contract assertions.
- Create no server route, contract, database, provider, B-lite, payment, or unrelated UI/refactor files.

### Task 1: Add the isolated display-only storage boundary

**Files:**
- Modify: `lib/services/pending-analysis-target.ts:7-117,168-210`
- Modify: `lib/services/pending-analysis-target.test.ts:1-220`

- [ ] **Step 1: Write the failing storage tests**

Extend the existing `createStorage`, `NOW`, and UUID fixtures in `lib/services/pending-analysis-target.test.ts` with these tests. Use the exact public names below so the hook and page have one stable boundary:

```ts
import {
    clearPreflightDisplayTarget,
    clearPreflightDisplayTargetForTerminalState,
    readPreflightDisplayTarget,
    storePreflightDisplayTarget,
} from './pending-analysis-target';

it('stores and reads one normalized display target bound to a preflight', () => {
    const storage = createStorage();

    expect(storePreflightDisplayTarget(storage, {
        now: NOW,
        preflightId: PREFLIGHT_A,
        target: '  @Target.Name  ',
    })).toBe(true);
    expect(JSON.parse(storage.setItem.mock.calls[0][1])).toEqual({
        preflight_id: PREFLIGHT_A,
        stored_at: NOW,
        target: 'target.name',
    });
    expect(readPreflightDisplayTarget(storage, {
        now: NOW + 60_000,
        preflightId: PREFLIGHT_A,
    })).toBe('target.name');
});

const invalidDisplayInputs: Array<[string, string, number]> = [
    ['not-a-uuid', 'safe_target', NOW],
    [PREFLIGHT_A, 'has spaces', NOW],
    [PREFLIGHT_A, '.leading_dot', NOW],
    [PREFLIGHT_A, 'trailing_dot.', NOW],
    [PREFLIGHT_A, 'double..dot', NOW],
    [PREFLIGHT_A, 'a'.repeat(31), NOW],
    [PREFLIGHT_A, 'safe_target', Number.MAX_SAFE_INTEGER + 1],
];
it.each(invalidDisplayInputs)('rejects invalid display record input %j', (preflightId, target, now) => {
    const storage = createStorage();

    expect(storePreflightDisplayTarget(storage, {
        now,
        preflightId,
        target,
    })).toBe(false);
    expect(storage.setItem).not.toHaveBeenCalled();
});

it.each([
    ['future', { preflight_id: PREFLIGHT_A, stored_at: NOW + 1, target: 'safe_target' }, NOW],
    ['expired', { preflight_id: PREFLIGHT_A, stored_at: NOW, target: 'safe_target' }, NOW + 30 * 60_000 + 1],
    ['malformed', '{"preflight_id":', NOW],
    ['mismatched', { preflight_id: PREFLIGHT_B, stored_at: NOW, target: 'safe_target' }, NOW],
])('removes and ignores a %s display record', (_label, raw, now) => {
    const storage = createStorage();
    storage.setItem('preflight_display_target_v1', typeof raw === 'string' ? raw : JSON.stringify(raw));
    storage.removeItem.mockClear();

    expect(readPreflightDisplayTarget(storage, {
        now,
        preflightId: PREFLIGHT_A,
    })).toBeNull();
    expect(storage.removeItem).toHaveBeenCalledWith('preflight_display_target_v1');
});

it('fences explicit cleanup to the stored preflight id', () => {
    const storage = createStorage();
    storePreflightDisplayTarget(storage, {
        now: NOW,
        preflightId: PREFLIGHT_A,
        target: 'safe_target',
    });

    expect(clearPreflightDisplayTarget(storage, PREFLIGHT_B)).toBe(false);
    expect(readPreflightDisplayTarget(storage, {
        now: NOW,
        preflightId: PREFLIGHT_A,
    })).toBe('safe_target');
    expect(clearPreflightDisplayTarget(storage, PREFLIGHT_A)).toBe(true);
    expect(readPreflightDisplayTarget(storage, {
        now: NOW,
        preflightId: PREFLIGHT_A,
    })).toBeNull();
});

it.each(['ready', 'blocked', 'expired', 'consumed', 'completed', 'failed']) (
    'clears a matching display record for terminal state %s',
    status => {
        const storage = createStorage();
        storePreflightDisplayTarget(storage, {
            now: NOW,
            preflightId: PREFLIGHT_A,
            target: 'safe_target',
        });

        expect(clearPreflightDisplayTargetForTerminalState(storage, {
            preflightId: PREFLIGHT_A,
            status,
        })).toBe(true);
        expect(readPreflightDisplayTarget(storage, {
            now: NOW,
            preflightId: PREFLIGHT_A,
        })).toBeNull();
    },
);

it('retains a matching display record while pending and fails open when storage throws', () => {
    const storage = createStorage();
    storePreflightDisplayTarget(storage, {
        now: NOW,
        preflightId: PREFLIGHT_A,
        target: 'safe_target',
    });
    expect(clearPreflightDisplayTargetForTerminalState(storage, {
        preflightId: PREFLIGHT_A,
        status: 'pending',
    })).toBe(false);

    const unavailable = {
        getItem: vi.fn(() => { throw new Error('unavailable'); }),
        removeItem: vi.fn(() => { throw new Error('unavailable'); }),
        setItem: vi.fn(() => { throw new Error('unavailable'); }),
    };
    expect(storePreflightDisplayTarget(unavailable, {
        now: NOW,
        preflightId: PREFLIGHT_A,
        target: 'safe_target',
    })).toBe(false);
    expect(readPreflightDisplayTarget(unavailable, {
        now: NOW,
        preflightId: PREFLIGHT_A,
    })).toBeNull();
    expect(() => clearPreflightDisplayTarget(unavailable, PREFLIGHT_A)).not.toThrow();
});
```

- [ ] **Step 2: Run the RED unit test**

Run:

```bash
npx vitest run lib/services/pending-analysis-target.test.ts
```

Expected: FAIL because the four display-helper exports do not exist yet; the current `pending_ig` tests remain passing.

- [ ] **Step 3: Implement the minimal display record helpers**

In `lib/services/pending-analysis-target.ts`, keep `PENDING_TARGET_KEY`, `StoredPendingTarget`, and every existing `pending_ig` function unchanged. Add a separate key, record type, and terminal set:

```ts
const PREFLIGHT_DISPLAY_TARGET_KEY = 'preflight_display_target_v1';
const PREFLIGHT_DISPLAY_TARGET_TTL_MS = 30 * 60_000;
const PREFLIGHT_DISPLAY_TERMINAL_STATES = new Set([
    'blocked',
    'completed',
    'consumed',
    'expired',
    'failed',
    'ready',
]);

interface StoredPreflightDisplayTarget {
    preflight_id: string;
    stored_at: number;
    target: string;
}

interface PreflightDisplayTargetInput {
    now?: number;
    preflightId: string;
    target: string;
}

interface ReadPreflightDisplayTargetInput {
    now?: number;
    preflightId: string;
}
```

Export exactly these signatures:

```ts
export function storePreflightDisplayTarget(
    storage: PendingTargetStorage,
    { now = Date.now(), preflightId, target }: PreflightDisplayTargetInput,
): boolean;

export function readPreflightDisplayTarget(
    storage: PendingTargetStorage,
    { now = Date.now(), preflightId }: ReadPreflightDisplayTargetInput,
): string | null;

export function clearPreflightDisplayTarget(
    storage: PendingTargetStorage,
    preflightId: string,
): boolean;

export function clearPreflightDisplayTargetForTerminalState(
    storage: PendingTargetStorage,
    { preflightId, status }: { preflightId: string; status: string | null | undefined },
): boolean;
```

Use the module's existing `normalizePendingTarget` and `isCanonicalUuid`; reject any invalid target, UUID, or unsafe timestamp before `setItem`. Serialize only `{ preflight_id, stored_at, target }` under the new key. On read, catch `getItem`, JSON, validation, and removal failures; accept only the matching canonical UUID, normalized target, safe timestamp, non-future timestamp, and age at most `PREFLIGHT_DISPLAY_TARGET_TTL_MS`. Remove malformed, expired, or mismatched records and return `null`. On explicit clear, parse the record and call `removeItem` only when its stored `preflight_id` exactly matches the requested ID. Terminal cleanup returns `false` for nonterminal status and delegates to matching clear for every state in the terminal set. No helper logs, throws, or touches `pending_ig`.

- [ ] **Step 4: Run the GREEN unit test**

Run:

```bash
npx vitest run lib/services/pending-analysis-target.test.ts
```

Expected: PASS for the existing handoff suite and all new display-record cases.

- [ ] **Step 5: Commit the storage boundary**

```bash
git add lib/services/pending-analysis-target.ts lib/services/pending-analysis-target.test.ts
git commit -m "feat: add preflight display target storage"
```

### Task 2: Wire accepted, resume, terminal, consumed, and reset lifecycles

**Files:**
- Modify: `hooks/useAnalysisV2Preflight.ts:173-186,448-552,623-650`
- Modify: `app/analyze/page.tsx:27-50,259-343,673-696`
- Modify: `lib/services/analysis/preflight-client-races.test.ts:1-265`

- [ ] **Step 1: Write the failing lifecycle and source-contract tests**

Add the display helper imports to `preflight-client-races.test.ts`, and extend the existing storage fixtures with these assertions:

```ts
it('clears display target synchronously before a consumed redirect', () => {
    const redirectConsumedPreflight = consumedRedirect();
    expect(redirectConsumedPreflight).toBeTypeOf('function');
    if (!redirectConsumedPreflight) return;
    const storage = createStorage();
    storePreflightDisplayTarget(storage, {
        now: 1_750_000_000_000,
        preflightId,
        target: 'safe_target',
    });
    storage.removeItem.mockClear();
    const replace = vi.fn();
    const consumed = preflightStatusV1Schema.parse({
        schemaVersion: 1,
        preflightId,
        status: 'consumed',
        exclusionDecision: 'skip',
        requestId: otherPreflightId,
    });

    expect(redirectConsumedPreflight(consumed, { replace, storage })).toBe(true);
    expect(readPreflightDisplayTarget(storage, {
        now: 1_750_000_000_001,
        preflightId,
    })).toBeNull();
    expect(replace).toHaveBeenCalledWith(`/progress/${otherPreflightId}`);
    expect(storage.removeItem.mock.invocationCallOrder[0])
        .toBeLessThan(replace.mock.invocationCallOrder[0]);
});

it('keeps a pending display target and fences cleanup to another preflight', () => {
    const storage = createStorage();
    storePreflightDisplayTarget(storage, {
        now: 1_750_000_000_000,
        preflightId,
        target: 'safe_target',
    });
    expect(clearPreflightDisplayTargetForTerminalState(storage, {
        preflightId: otherPreflightId,
        status: 'ready',
    })).toBe(false);
    expect(readPreflightDisplayTarget(storage, {
        now: 1_750_000_000_001,
        preflightId,
    })).toBe('safe_target');
});

it('documents accepted-write, resume-ordering, standard-only, and reset contracts', () => {
    const hookSource = readFileSync(
        new URL('../../../hooks/useAnalysisV2Preflight.ts', import.meta.url),
        'utf8',
    );
    const analyzeSource = readFileSync('app/analyze/page.tsx', 'utf8');
    const attach = hookSource.indexOf('coordinator.attachPreflight(generation, accepted.data.preflightId)');
    const store = hookSource.indexOf('storePreflightDisplayTarget(');
    expect(attach).toBeGreaterThanOrEqual(0);
    expect(store).toBeGreaterThan(attach);
    expect(hookSource).toContain("if (flow === 'standard')");
    expect(hookSource).toContain('clearPreflightDisplayTargetForTerminalState');
    expect(analyzeSource).toContain('readPreflightDisplayTarget(');
    expect(analyzeSource).toContain('displayTarget ?? boundTarget');
    expect(analyzeSource).toContain('clearPreflightDisplayTarget(storage, activePreflightId)');
    expect(analyzeSource).toContain('new URLSearchParams({ preflight: accepted.preflightId })');
    expect(analyzeSource).not.toContain('targetInstagramId: instagramId');
});
```

The consumed test must retain the existing `pending_ig` assertion in the neighboring test; it proves the new helper does not replace the authenticated handoff. The source contract also verifies that no username is appended to the route query.

- [ ] **Step 2: Run the RED lifecycle tests**

Run:

```bash
npx vitest run lib/services/analysis/preflight-client-races.test.ts lib/services/pending-analysis-target.test.ts
```

Expected: FAIL on the missing display imports and lifecycle/source-contract assertions while the existing coordinator and `pending_ig` tests continue to pass.

- [ ] **Step 3: Persist only after current standard acceptance in the hook**

Import `storePreflightDisplayTarget` and `clearPreflightDisplayTargetForTerminalState`. In `startPreflight`, leave input normalization and the request body untouched. After the existing schema parse, `scope.isCurrent()` check, and `coordinator.attachPreflight(...)` success, add:

```ts
if (flow === 'standard') {
    const storage = availablePendingTargetStorage();
    if (storage) {
        storePreflightDisplayTarget(storage, {
            preflightId: accepted.data.preflightId,
            target: normalized,
        });
    }
}
```

Keep `pending_ig` binding in `app/analyze/page.tsx` for the authenticated OAuth/login handoff. Do not persist before the accepted schema parse, on rejected responses, for stale generations, or for the beta-test flow.

- [ ] **Step 4: Clear terminal and consumed records in the hook**

Extend `redirectConsumedPreflight` so its existing `pending_ig` cleanup and the new matching cleanup both happen before `replace`:

```ts
if (storage) {
    clearPendingAnalysisTargetForTerminalState(storage, status.status);
    clearPreflightDisplayTargetForTerminalState(storage, {
        preflightId: status.preflightId,
        status: status.status,
    });
}
```

In `loadPreflight`, after schema validation and `scope.isCurrent()` succeeds, clear the new record for every accepted non-pending terminal status before updating React state. Keep the consumed branch first so its removal remains synchronous before `/progress/<requestId>` navigation. A stale scope must return before any cleanup; a pending response must retain the record. Keep `ready` authoritative by continuing to set `targetInstagramId` from `parsed.data.target.username`.

- [ ] **Step 5: Read before resume for both auth modes and clear only active reset**

In the `/analyze` initialization effect, obtain `const storage = availablePendingTargetStorage()` once. When a validated `preflight` query is resumable, read the dedicated record unconditionally for anonymous and authenticated sessions before calling `resumePreflight`:

```ts
const displayTarget = storage
    ? readPreflightDisplayTarget(storage, { preflightId: resumablePreflightId })
    : null;
let boundTarget: string | null = null;
if (user && storage) {
    boundTarget = readPendingAnalysisTargetForPreflight(storage, {
        ownerId: user.id,
        preflightId: resumablePreflightId,
    });
}
void resumePreflight(
    resumablePreflightId,
    displayTarget ?? boundTarget ?? undefined,
    resumableClaimToken ?? undefined,
);
```

The helper rejects invalid UUIDs; retain the existing `resumePreflight` UUID guard and auth/claim condition. If the display record is absent or storage is unavailable, pass the authenticated bound target when available, otherwise `undefined`, preserving the generic `대상 계정` fallback and current status polling.

In `handleReset`, capture `const activePreflightId = preflight?.preflightId` before `reset()`. With the available storage, call `clearPreflightDisplayTarget(storage, activePreflightId)` only when that ID exists, before `reset()` and `router.replace('/analyze')`; retain the existing global `pending_ig` reset cleanup. Leave the terminal `pending_ig` effect, logout flow, query parameters, API calls, and landing copy unchanged.

- [ ] **Step 6: Run the GREEN lifecycle tests**

Run:

```bash
npx vitest run lib/services/analysis/preflight-client-races.test.ts lib/services/pending-analysis-target.test.ts
```

Expected: PASS with consumed removal ordered before redirect, pending and mismatched records retained, accepted writes fenced after attach, both resume modes reading before resume, and reset cleanup scoped to the active ID.

- [ ] **Step 7: Commit the lifecycle wiring**

```bash
git add hooks/useAnalysisV2Preflight.ts app/analyze/page.tsx lib/services/analysis/preflight-client-races.test.ts
git commit -m "feat: restore preflight target after refresh"
```

### Task 3: Verify scope, types, and the implementation handoff

**Files:**
- Review only: `docs/superpowers/specs/2026-08-14-preflight-refresh-display-target-design.md`
- Review only: the five implementation files named in this plan

- [ ] **Step 1: Run the focused GREEN suite**

```bash
npx vitest run lib/services/pending-analysis-target.test.ts lib/services/analysis/preflight-client-races.test.ts
```

Expected: both files pass with no unhandled storage exceptions.

- [ ] **Step 2: Run repository verification**

```bash
npm run lint
npm run build
```

Expected: ESLint and the production Next.js build exit with status 0.

- [ ] **Step 3: Perform the spec and completeness self-review**

Check each requirement against the implementation before declaring completion:

- The helper has exactly one display key, canonical UUID binding, existing username normalization, safe timestamp validation, a 30-minute TTL, mismatch fencing, and fail-open read/write/remove behavior.
- Standard accepted responses write only after current-generation attachment; rejected, stale, and beta responses do not write.
- `/analyze` reads before resume for anonymous claim and authenticated owner URLs; a missing record still resumes; server `ready` target replaces the display value.
- Pending retains the record; `ready`, `blocked`, `expired`, `failed`, `completed`, and `consumed` clear it; consumed clears before redirect; reset clears only the active ID.
- The four helper names, argument objects, `string | null` read result, boolean write/clear results, `preflightId` field, and terminal status values match across the module, hook, page, and tests; lint/build provide the final TypeScript consistency check.
- No username is placed in query parameters, request/response schemas, database rows, logs, provider/B-lite/payment state, or analytics properties, and `pending_ig` behavior remains intact.
- No changed file is outside `lib/services/pending-analysis-target.ts`, its test, `hooks/useAnalysisV2Preflight.ts`, `app/analyze/page.tsx`, and `lib/services/analysis/preflight-client-races.test.ts`.

Search the plan for unresolved instructions and remove any occurrence. Then run:

```bash
git diff --check origin/main...HEAD
git diff --stat origin/main...HEAD
```

Expected: the manual scan finds no unresolved instructions, `git diff --check` is clean, and the diff lists only the plan plus the two minimal implementation commits once the plan is executed.

- [ ] **Step 4: Commit the completed plan**

For this planning task, commit only the plan document; do not implement application code in this worktree:

```bash
git add docs/superpowers/plans/2026-08-14-preflight-refresh-display-target.md
git commit -m "docs: plan preflight display target refresh"
```

The future implementation handoff is complete after the two focused implementation commits and the repository verification in Task 3; no URL/API/DB/provider/B-lite/payment changes or refactor commit is authorized by this plan.
