# Signed E2E Runner Email Provider Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow only a valid signed and registered E2E runner to create a preflight from its Supabase `email` Auth identity while preserving the existing `google`/`kakao` restriction for ordinary production intake.

**Architecture:** Extend the preflight provider type to represent the runner's real `email` identity, but make route admission request-scoped: `email` is accepted only after the signed admission token verifies and `requireActiveE2eTestRunner` succeeds. Invalid tokens and ordinary email sessions remain rejected before persistence or provider work.

**Tech Stack:** Next.js App Router, TypeScript, Vitest, Supabase Auth

---

### Task 1: Scope email Auth to signed E2E admission

**Files:**
- Modify: `app/api/analysis/preflight/route.ts`
- Modify: `lib/services/analysis/preflight.ts`
- Test: `lib/services/analysis/preflight-route.test.ts`

- [ ] **Step 1: Write the failing route tests**

Add one test that signs an admission token, changes the mocked user provider to `email`, and expects `202` plus `authProvider: 'email'` in `preflightStore.createOrReplay`. Add a second test with the same email session and no signed token that expects `400 / UNSUPPORTED_AUTH` and no persistence.

```ts
it('accepts email auth only for a valid signed E2E runner admission', async () => {
    const secret = Buffer.alloc(32, 13).toString('base64url');
    vi.stubEnv('ANALYSIS_TEST_ENTITLEMENTS_ENABLED', 'true');
    vi.stubEnv('ANALYSIS_TEST_ENTITLEMENT_SECRET', secret);
    mocks.getUser.mockResolvedValue({
        data: { user: {
            id: userId,
            email: 'runner@example.com',
            app_metadata: { provider: 'email', analysis_test_runner_v1: 'basic' },
        } },
        error: null,
    });
    const token = createAnalysisTestAdmission({
        userId,
        targetInstagramId: 'target.name',
        idempotencyKey: 'preflight-key-000000000000',
        nonce: 'preflight_admission_nonce_06',
    }, { secret });

    const response = await createPreflight(postRequest(
        { targetInstagramId: 'Target.Name' },
        'preflight-key-000000000000',
        token,
    ));

    expect(response.status).toBe(202);
    expect(mocks.requireActiveE2eTestRunner).toHaveBeenCalledOnce();
    expect(mocks.store.createOrReplay).toHaveBeenCalledWith(
        expect.objectContaining({ authProvider: 'email', accessMode: 'test_entitlement' }),
    );
});

it('rejects an ordinary email-auth preflight before persistence', async () => {
    mocks.getUser.mockResolvedValue({
        data: { user: {
            id: userId,
            email: 'runner@example.com',
            app_metadata: { provider: 'email' },
        } },
        error: null,
    });

    const response = await createPreflight(postRequest());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'UNSUPPORTED_AUTH' });
    expect(mocks.store.createOrReplay).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
npx vitest run lib/services/analysis/preflight-route.test.ts
```

Expected: the signed email-runner test fails with `UNSUPPORTED_AUTH`; the ordinary email test already passes and serves as the regression boundary.

- [ ] **Step 3: Implement the minimal request-scoped provider rule**

Extend the provider type and make the helper explicitly opt in to email only for the already verified signed-admission branch.

```ts
// lib/services/analysis/preflight.ts
export type PreflightAuthProvider = 'google' | 'kakao' | 'email';

// app/api/analysis/preflight/route.ts
function authProvider(
    value: unknown,
    options: { allowSignedE2eEmail: boolean } = { allowSignedE2eEmail: false },
): PreflightAuthProvider | null {
    if (value === 'google' || value === 'kakao') return value;
    if (options.allowSignedE2eEmail && value === 'email') return value;
    return null;
}

provider = authProvider(user.app_metadata?.provider, {
    allowSignedE2eEmail: signedTestAdmission === 'valid',
});
```

Do not change public-admission gates, token verification order, runner classification checks, error codes, marketing copy, or database schema.

- [ ] **Step 4: Run focused and adjacent tests and verify GREEN**

Run:

```bash
npx vitest run lib/services/analysis/preflight-route.test.ts lib/services/analysis/preflight.test.ts lib/services/analysis/test-entitlement-route.test.ts
npm run lint
npm run build
```

Expected: all tests, lint, and production build pass with no new warnings attributable to the change.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-08-12-e2e-runner-email-provider.md app/api/analysis/preflight/route.ts lib/services/analysis/preflight.ts lib/services/analysis/preflight-route.test.ts
git commit -m "fix: admit signed email e2e runners"
```
