# CI Contract Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan.

**Goal:** Restore the exact GitHub `quality` job to green by repairing one real Amplitude redirect regression and five stale source-contract assertions without weakening the product contracts those tests protect.

**Architecture:** Work from a clean top-level Orca worktree based on `origin/main` at `2a28326462bf636f92368dc894b5ea76911d79bb`. Keep the production change limited to the paid-return redirect effect. Update source-contract tests to follow the current `currentOrder` state boundary and the two-path progress-image component.

**Tech Stack:** Next.js 16, React 19, TypeScript, Vitest, Amplitude browser SDK.

---

## Scope and ownership

- `app/earlybird/earlybird-status.tsx`
- `lib/services/amplitude-funnel-caller-contract.test.ts`
- `lib/services/amplitude-privacy-contract.test.ts`
- `lib/services/earlybird/ui-state.test.ts`
- `lib/services/media/proxy-image-rendering.test.ts`

Do not change payment state transitions, analysis orchestration, database schema, provider routing, landing copy, or unrelated tests.

## Task 1: Reproduce the exact CI failures

- [ ] **Step 1: Verify the worktree base**

Run:

```bash
git status --short
git rev-parse HEAD
git merge-base --is-ancestor 2a28326462bf636f92368dc894b5ea76911d79bb HEAD
```

Expected: clean status, the requested base or a documented descendant, and exit code 0 for the ancestry check.

- [ ] **Step 2: Run the four failing files with the GitHub CI environment**

```bash
CI=true \
NEXT_PUBLIC_APP_URL=http://localhost:3000 \
NEXT_PUBLIC_SUPABASE_URL=https://example.supabase.co \
NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-anon-key \
SUPABASE_SERVICE_ROLE_KEY=ci-service-role-key-with-at-least-32-characters \
IMAGE_PROXY_SIGNING_SECRET=ci-image-proxy-signing-secret-with-at-least-32-characters \
RESEND_API_KEY=re_ci_build_placeholder \
RESEND_FROM_EMAIL=noreply@example.com \
npx vitest run \
  lib/services/amplitude-funnel-caller-contract.test.ts \
  lib/services/amplitude-privacy-contract.test.ts \
  lib/services/earlybird/ui-state.test.ts \
  lib/services/media/proxy-image-rendering.test.ts
```

Expected before changes: six failed assertions matching GitHub Actions run `33267256180`. If the failure set differs, stop and report the delta before editing.

## Task 2: Restore the bounded analytics flush

- [ ] **Step 1: Make the caller-contract test require the intended behavior**

Require the paid automatic-fulfillment effect to:

1. emit `PAYMENT_CONFIRMED_VIEWED` once;
2. call the existing `flushAnalytics()` helper;
3. navigate with `router.replace(nextUrl)` only from the flush settlement path;
4. cancel navigation after effect cleanup;
5. depend on `currentOrder`, not the stale `order` prop.

Keep the existing privacy assertions and event-key ownership intact.

- [ ] **Step 2: Implement the minimal production repair**

In `app/earlybird/earlybird-status.tsx`, import `flushAnalytics` and use the existing bounded helper before the automatic paid-return redirect. Use an effect-local active flag so an unmounted component does not navigate:

```ts
let active = true;
void flushAnalytics().finally(() => {
    if (active) router.replace(nextUrl);
});
return () => {
    active = false;
};
```

Do not add another timeout. The helper already has the 500 ms upper bound.

- [ ] **Step 3: Run the two Amplitude contract files**

```bash
npx vitest run \
  lib/services/amplitude-funnel-caller-contract.test.ts \
  lib/services/amplitude-privacy-contract.test.ts
```

Expected: both files pass.

## Task 3: Align recovery and media contracts with current ownership

- [ ] **Step 1: Replace stale prop ownership in recovery assertions**

Update `lib/services/earlybird/ui-state.test.ts` assertions from `order.*` to the current owner snapshot `currentOrder.*`, including checkout recovery, system status, result URL, support state, and effect dependencies. Do not loosen assertions to generic property-name fragments.

- [ ] **Step 2: Preserve both progress-image paths**

Update `lib/services/media/proxy-image-rendering.test.ts` so the progress component contract separately proves:

- the visible slide image renders `displaySrc`, is `unoptimized`, and is lazy-loaded;
- the hidden/probe image renders `probeSrc`, is `unoptimized`, and is eager-loaded;
- unsafe raw result URLs still cannot bypass `safeResultImageUrl` and the local proxy gate.

Do not reduce the expectation to merely finding any `<Image>` tag.

- [ ] **Step 3: Re-run the four-file reproduction**

Run the command from Task 1. Expected: all four files pass, with 65 tests passing unless the clean base contains an independently documented test-count change.

## Task 4: Verify and commit

- [ ] **Step 1: Run the full local quality gate**

```bash
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Expected: zero failures. Report any pre-existing or unrelated failure rather than suppressing it.

- [ ] **Step 2: Review the diff**

```bash
git diff --check
git diff --stat
git diff -- \
  app/earlybird/earlybird-status.tsx \
  lib/services/amplitude-funnel-caller-contract.test.ts \
  lib/services/amplitude-privacy-contract.test.ts \
  lib/services/earlybird/ui-state.test.ts \
  lib/services/media/proxy-image-rendering.test.ts
```

Expected: only owned files changed; no secret, generated output, snapshot churn, or unrelated formatting.

- [ ] **Step 3: Commit**

```bash
git add \
  app/earlybird/earlybird-status.tsx \
  lib/services/amplitude-funnel-caller-contract.test.ts \
  lib/services/amplitude-privacy-contract.test.ts \
  lib/services/earlybird/ui-state.test.ts \
  lib/services/media/proxy-image-rendering.test.ts
git commit -m "fix: restore paid return analytics contract"
```

Return the commit SHA, exact test results, and any concerns. Do not push or deploy.
