# Groble Phone Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Match Groble payments to the correct earlybird order by the buyer's Kakao phone number even when the Groble and login emails differ, while retaining the existing email fallback and payment safety invariants.

**Architecture:** Normalize Korean mobile numbers to E.164 in one shared server module and snapshot the normalized Kakao number into each checkout order. Four ordered forward-only Supabase migrations isolate fast schema DDL, data backfill, validation/index construction, and RPC activation while preserving atomicity inside each implicit CLI transaction. The activation phase keeps a service-only 9-argument compatibility wrapper during the rolling deploy and installs the canonical 12-argument evidence RPC. The webhook parser supplies bounded buyer evidence, while authenticated DTOs and analytics never expose it. New auth UI shows Kakao only, but Google provider support and existing Google sessions remain intact and continue through the legacy email fallback.

**Tech Stack:** Next.js 16 App Router, TypeScript, `libphonenumber-js`, Zod, Supabase/Postgres RLS and SECURITY DEFINER RPCs, Vitest, PGlite.

---

### Task 1: Canonical Korean phone normalization

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `lib/services/identity/phone-number.ts`
- Create: `lib/services/identity/phone-number.test.ts`

- [ ] **Step 1: Install the parser dependency**

Run: `npm install libphonenumber-js`

Expected: `package.json` and `package-lock.json` contain one production dependency on `libphonenumber-js`; no phone parsing library is exposed to a client bundle.

- [ ] **Step 2: Write the failing normalization tests**

```ts
import { describe, expect, it } from 'vitest';
import { normalizeKoreanMobileNumber } from './phone-number';

describe('normalizeKoreanMobileNumber', () => {
    it.each([
        ['010-1234-5678', '+821012345678'],
        ['010 1234 5678', '+821012345678'],
        ['(010) 1234-5678', '+821012345678'],
        ['+82 10-1234-5678', '+821012345678'],
        ['821012345678', '+821012345678'],
    ])('normalizes %s', (input, expected) => {
        expect(normalizeKoreanMobileNumber(input)).toBe(expected);
    });

    it.each([null, undefined, '', '02-123-4567', '+1 212 555 0100', '010-12-34'])
        ('rejects %s', input => {
            expect(normalizeKoreanMobileNumber(input)).toBeNull();
        });
});
```

- [ ] **Step 3: Verify the tests fail**

Run: `npm test -- lib/services/identity/phone-number.test.ts`

Expected: FAIL because `phone-number.ts` does not exist.

- [ ] **Step 4: Implement one strict normalizer**

```ts
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

const E164_KOREAN_MOBILE = /^\+8210\d{8}$/;

export function normalizeKoreanMobileNumber(
    input: string | null | undefined
): string | null {
    if (typeof input !== 'string') return null;
    const trimmed = input.trim();
    if (!trimmed) return null;
    const candidate = trimmed.startsWith('82') && !trimmed.startsWith('+')
        ? `+${trimmed}`
        : trimmed;
    const parsed = parsePhoneNumberFromString(candidate, 'KR');
    if (!parsed?.isValid() || parsed.country !== 'KR') return null;
    const normalized = parsed.number;
    return E164_KOREAN_MOBILE.test(normalized) ? normalized : null;
}
```

- [ ] **Step 5: Verify and commit**

Run: `npm test -- lib/services/identity/phone-number.test.ts`

Expected: PASS.

```bash
git add package.json package-lock.json lib/services/identity/phone-number.ts lib/services/identity/phone-number.test.ts
git commit -m "feat: normalize Korean buyer phone numbers"
```

### Task 2: Persist normalized Kakao identity and keep Google legacy access

**Files:**
- Modify: `components/auth-buttons.tsx`
- Modify: `app/auth/callback/route.ts`
- Modify: `app/api/user/me/route.ts`
- Create: `lib/services/identity/auth-profile.ts`
- Create: `lib/services/identity/auth-profile.test.ts`

- [ ] **Step 1: Write failing pure profile tests**

Define a pure helper whose complete output contract is:

```ts
export interface AuthProfilePatch {
    name?: string;
    nickname?: string;
    profile_image?: string;
    gender?: string;
    birthyear?: string;
    phone_number?: string;
    phone_number_normalized?: string;
}

export function buildAuthProfilePatch(
    metadata: Record<string, unknown>
): AuthProfilePatch;
```

Test that a Kakao phone populates both raw and normalized fields, an invalid or absent phone omits both fields, and no email value enters this object.

Run: `npm test -- lib/services/identity/auth-profile.test.ts`

Expected: FAIL because the helper does not exist.

- [ ] **Step 2: Implement profile normalization and use it in both sync paths**

`buildAuthProfilePatch` must call `normalizeKoreanMobileNumber` and only set `phone_number_normalized` when parsing succeeds. Replace the duplicated metadata mapping in `app/auth/callback/route.ts` and `app/api/user/me/route.ts` with this helper. On Kakao callback, update non-empty Kakao values on every login so phone changes are synchronized; retain the current create and legacy Google behavior.

```ts
const profile = buildAuthProfilePatch(kakaoProperties);
await supabaseAdmin.from('users').upsert({
    id: user.id,
    email: user.email,
    provider,
    ...profile,
}, { onConflict: 'id' });
```

- [ ] **Step 3: Hide only the Google entry point**

Keep `signIn(provider: 'kakao' | 'google')` and callback provider handling for legacy compatibility, but remove the rendered Google button and its visible copy from `AuthButtons`. The only rendered action is:

```tsx
<button onClick={() => signIn('kakao')} disabled={busy}>
    {kakaoText}
</button>
```

Do not disable the Supabase Google provider, delete Google rows, or invalidate sessions.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- lib/services/identity/auth-profile.test.ts && npx tsc --noEmit`

Expected: PASS and type-check exits 0.

```bash
git add components/auth-buttons.tsx app/auth/callback/route.ts app/api/user/me/route.ts lib/services/identity
git commit -m "feat: sync Kakao phone identity for checkout"
```

### Task 3: Ordered forward-only database migrations for phone snapshots and buyer evidence

**Files:**
- Create with CLI: `supabase/migrations/20260718104053_add_groble_phone_matching.sql`
- Create with CLI: `supabase/migrations/20260718114650_backfill_groble_phone_matching.sql`
- Create with CLI: `supabase/migrations/20260718114658_validate_groble_phone_matching.sql`
- Create with CLI: `supabase/migrations/20260718114707_activate_groble_phone_matching.sql`
- Create: `lib/services/earlybird/groble-phone-migration-contract.test.ts`
- Create: `lib/services/earlybird/groble-phone-pglite.test.ts`
- Modify: `lib/services/earlybird/earlybird-postgres-concurrency.integration.test.ts`
- Modify: `lib/services/earlybird/store.ts`
- Modify: `app/api/earlybird/checkout/route.ts`
- Modify: `lib/services/earlybird/checkout-route.test.ts`

- [ ] **Step 1: Generate the four forward migrations**

Run each command separately so the filenames have a strict timestamp order:

```bash
npx supabase migration new add_groble_phone_matching
npx supabase migration new backfill_groble_phone_matching
npx supabase migration new validate_groble_phone_matching
npx supabase migration new activate_groble_phone_matching
```

Expected: four new empty migrations after `20260717140000_add_groble_earlybird_presale.sql`; never edit the already-applied presale migration. Supabase CLI v2.102.0 executes each file as one implicit transaction and does not support a no-transaction migration directive, so file boundaries are lock boundaries.

- [ ] **Step 2: Write failing migration contract tests**

Read all four files in timestamp order. Assert both the combined feature contract and these per-file statement boundaries:

```ts
expect(ddlMigration).toContain('ADD COLUMN phone_number_normalized TEXT');
expect(ddlMigration).not.toMatch(/^UPDATE public\./m);
expect(backfillMigration).not.toMatch(/^ALTER TABLE/m);
expect(validationMigration).not.toContain('CREATE OR REPLACE FUNCTION');
expect(activationMigration).not.toMatch(/^CREATE (?:UNIQUE )?INDEX/m);
```

Also assert that no file contains both an `ALTER TABLE ... ADD` action and a top-level backfill, all checks are added `NOT VALID` and validated only in phase 3, authenticated field-level grants remain exactly the pre-existing safe columns, and only `service_role` can execute either finalizer signature and the replaced checkout/refund RPCs.

Run: `npm test -- lib/services/earlybird/groble-phone-migration-contract.test.ts`

Expected: FAIL while the CLI-generated phase files are empty or the original migration is still monolithic.

- [ ] **Step 3: Write failing PGlite behavioral tests**

Cover these complete scenarios:

```ts
it('accepts one phone-matched order when buyer email differs');
it('falls back to email for a legacy Google order without a phone snapshot');
it('stores buyer evidence on accepted and unmatched events');
it('does not consume inventory for zero or multiple phone candidates');
it('does not let displayName influence matching');
it('preserves mismatch, duplicate event, duplicate payment and overflow behavior');
it('snapshots the current user phone and does not follow later profile changes');
it('rejects a Kakao checkout without a valid normalized phone');
it('allows a legacy Google checkout without a phone snapshot');
```

Apply all four migrations sequentially in separate `database.exec` calls, then run: `npm test -- lib/services/earlybird/groble-phone-pglite.test.ts`

Expected: FAIL because the columns and replaced RPCs do not exist.

- [ ] **Step 4: Implement four bounded migration transactions**

Every file sets `lock_timeout = '5s'` and `statement_timeout = '2min'`. Keep these dependencies and statement classes exact:

| Phase | Allowed work |
|---|---|
| 1, `add` | Add nullable user/order/webhook columns, add eight bounded checks as `NOT VALID`, create and revoke the strict normalization helper. Do not backfill, scan, validate, index, replace an application RPC, or grant browser access in this transaction. |
| 2, `backfill` | Normalize `users`, abort on duplicate non-null normalized phones, and snapshot unresolved `payment_pending` and `cancelled` orders with no payment ID. Do not run `ALTER TABLE`, create indexes, or replace functions. |
| 3, `validate` | Validate all eight checks and create the user unique index plus pending and cancelled phone lookup indexes. Normal indexes are intentional because the CLI cannot run a concurrent index outside its implicit transaction; use the measured-size deployment gate in `docs/groble-earlybird-operations.md`. |
| 4, `activate` | Restate the safe authenticated projection, replace checkout/finalizer/refund RPCs, install the rolling compatibility wrapper, and apply service-role ACLs. Do not mix schema DDL, backfill, validation, or indexes into this transaction. |

Nullable user phones remain required for old Google accounts and Kakao accounts whose consent response has no phone. A duplicate abort leaves phase 1 safely applied while phase 2 rolls back as a unit.

- [ ] **Step 5: Replace checkout RPC with an immutable phone snapshot**

Within `create_earlybird_checkout`, load the user's `provider` and normalized phone with `FOR UPDATE` after taking the existing user advisory lock. Enforce:

```sql
IF v_user_provider = 'kakao' AND v_user_phone_number_normalized IS NULL THEN
    RAISE EXCEPTION 'CHECKOUT_PHONE_REQUIRED';
END IF;
```

Insert `v_user_phone_number_normalized` into `expected_buyer_phone_number_normalized`. Existing Google users may insert `NULL`, preserving email matching.

- [ ] **Step 6: Activate canonical and rolling-compatible finalization RPCs**

Create the canonical 12-argument signature by adding `p_buyer_phone_normalized TEXT`, `p_buyer_phone_raw TEXT`, and `p_buyer_display_name TEXT`. Keep the existing 9-argument signature as a service-only SQL wrapper that delegates to the canonical function with the three evidence arguments set to typed `NULL`. Do not drop this wrapper in the activation migration; remove it only through a later post-drain migration after every old application instance has exited.

Preserve the payment advisory lock and event/payment idempotency checks before candidate lookup. Determine every user reachable through the current phone, email, or an unresolved phone snapshot, lock those user IDs in text-sorted order, then run all authoritative counts. The query order is:

```sql
-- 1. payment_pending by normalized phone + product
-- 2. when count = 0, cancelled/payment_id IS NULL by phone + product + amount
-- 3. only when both phone counts = 0, payment_pending by email + product
-- 4. reselect the chosen row with the same predicates and FOR UPDATE
```

If pending phone matching returns more than one row, emit `ambiguous_buyer` without email fallback. If it returns exactly one, email mismatch is irrelevant. After zero pending phone candidates, check unresolved cancelled snapshots by phone, product, and amount before email fallback: one becomes `late_cancelled_payment`/`refund_pending`, multiple are ambiguous, and zero continues to the legacy email path. Lock every possible user in deterministic order, and make checkout and refund transitions use the same per-user advisory lock before their row lock. Persist bounded raw buyer evidence on every webhook event and selected order before returning any terminal disposition. The later product/amount check, inventory update, `due_at`, and all current dispositions remain unchanged.

- [ ] **Step 7: Surface the checkout phone requirement without leaking a phone**

Add `CHECKOUT_PHONE_REQUIRED` to `boundedDatabaseCode`, then map it in `persistenceErrorResponse`:

```ts
if (error.code === 'CHECKOUT_PHONE_REQUIRED') {
    return errorResponse(
        409,
        error.code,
        '카카오 계정의 전화번호 동의 정보를 확인한 뒤 다시 로그인해주세요.'
    );
}
```

The response must not include a raw or normalized number. Add a route test proving the 409 mapping.

- [ ] **Step 8: Verify database behavior and concurrency**

Run:

```bash
npm test -- lib/services/earlybird/groble-phone-migration-contract.test.ts \
  lib/services/earlybird/groble-phone-pglite.test.ts \
  lib/services/earlybird/earlybird-pglite.test.ts
npx vitest run lib/services/earlybird/earlybird-postgres-concurrency.integration.test.ts
```

Expected: all tests pass; if the optional local Postgres script is absent or Docker is unavailable, record that and rely on PGlite plus the existing CI integration suite.

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations lib/services/earlybird app/api/earlybird/checkout/route.ts
git commit -m "feat: match Groble payments by phone snapshot"
```

### Task 4: Parse and forward official Groble buyer evidence

**Files:**
- Modify: `lib/services/groble/webhook.ts`
- Modify: `lib/services/groble/webhook.test.ts`
- Modify: `app/api/webhooks/groble/route.ts`
- Modify: `lib/services/earlybird/groble-webhook-route.test.ts`

- [ ] **Step 1: Write failing parser and route tests**

The completed event must expose:

```ts
export interface GroblePaymentCompletedEvent {
    eventId: string;
    occurredAt: string;
    paymentId: string;
    buyerEmail: string;
    buyerPhoneNumber: string | null;
    buyerDisplayName: string | null;
    productId: string;
    amountKrw: number;
    paidAt: string;
}
```

Test bounded trimming, phone/display name omission for legacy fixtures, overlong rejection, phone normalization forwarding, and an email-mismatch/phone-match accepted route result.

Run: `npm test -- lib/services/groble/webhook.test.ts lib/services/earlybird/groble-webhook-route.test.ts`

Expected: FAIL because the parser and RPC call omit the fields.

- [ ] **Step 2: Extend the strict schema without breaking old signed fixtures**

```ts
buyer: z.object({
    email: z.string().trim().email().max(320),
    phoneNumber: z.string().trim().min(1).max(64).optional(),
    displayName: z.string().trim().min(1).max(100).optional(),
}),
```

Return `null` for absent values. Do not log the values.

- [ ] **Step 3: Normalize and call the extended service-role RPC**

```ts
const buyerPhoneNormalized = normalizeKoreanMobileNumber(event.buyerPhoneNumber);
await supabaseAdmin.rpc('finalize_earlybird_groble_payment', {
    p_event_id: event.eventId,
    p_idempotency_key: idempotencyKey,
    p_event_type: 'payment.completed',
    p_occurred_at: event.occurredAt,
    p_payment_id: event.paymentId,
    p_buyer_email: event.buyerEmail,
    p_buyer_phone_normalized: buyerPhoneNormalized,
    p_buyer_phone_raw: event.buyerPhoneNumber,
    p_buyer_display_name: event.buyerDisplayName,
    p_product_id: event.productId,
    p_amount_krw: event.amountKrw,
    p_paid_at: event.paidAt,
});
```

Map `CHECKOUT_PHONE_REQUIRED` to a bounded Korean checkout error. Preserve webhook 2xx behavior for unmatched, ambiguous, mismatch, duplicate, and overflow dispositions.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- lib/services/groble/webhook.test.ts lib/services/earlybird/groble-webhook-route.test.ts lib/services/earlybird/checkout-route.test.ts`

Expected: PASS.

```bash
git add lib/services/groble app/api/webhooks/groble/route.ts lib/services/earlybird/groble-webhook-route.test.ts
git commit -m "feat: ingest Groble buyer contact evidence"
```

### Task 5: Security, privacy, browser verification, and rollout

**Files:**
- Modify: `app/privacy/page.tsx`
- Modify: `.env.example` only if a non-secret contract changes
- Modify: `docs/groble-earlybird-operations.md`

- [ ] **Step 1: Update the privacy and operations contracts**

State that Groble supplies buyer name, email, and phone for payment matching, support, fraud prevention, and statutory transaction retention. Name Groble as the payment provider. Do not claim that card numbers enter this application. Document phone-first matching, legacy email fallback, unmatched manual review, and the rule that no buyer PII enters Amplitude or Axiom.

- [ ] **Step 2: Run the complete focused suite**

Run:

```bash
npm test -- lib/services/identity lib/services/groble lib/services/earlybird
npx tsc --noEmit
npm run lint
```

Expected: all commands exit 0.

- [ ] **Step 3: Validate the migration before remote push**

Run: `npx supabase db lint --linked`

Expected: no new lint errors. Then inspect all four files in timestamp order with `npx supabase migration list --linked`, repeat the row-count/size query in `docs/groble-earlybird-operations.md`, and follow its lock-timeout abort/retry procedure. Do not run `db push` until preview code and the split database rollout order are reviewed.

- [ ] **Step 4: Browser-check auth and checkout states**

At desktop 1440×900 and mobile 390×844 verify:

- login/signup renders only Kakao;
- an existing Google session still opens its owned pages;
- Kakao phone present reaches Groble checkout without a second email field;
- Kakao phone absent receives the bounded relogin/support error;
- no phone, email, or Groble buyer evidence appears in status JSON or page markup.

- [ ] **Step 5: Commit the documentation update**

```bash
git add app/privacy/page.tsx docs/groble-earlybird-operations.md .env.example
git commit -m "docs: disclose Groble buyer contact processing"
```
