# Groble Phone Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Match Groble payments to the correct earlybird order by the buyer's Kakao phone number even when the Groble and login emails differ, while retaining the existing email fallback and payment safety invariants.

**Architecture:** Normalize Korean mobile numbers to E.164 in one shared server module and snapshot the normalized Kakao number into each checkout order. A forward-only Supabase migration makes phone-first matching and evidence persistence atomic inside the existing service-role RPC; the webhook parser supplies bounded buyer evidence, while authenticated DTOs and analytics never expose it. New auth UI shows Kakao only, but Google provider support and existing Google sessions remain intact and continue through the legacy email fallback.

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
    profile_image_url?: string;
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
    auth_provider: provider,
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

### Task 3: Forward-only database migration for phone snapshots and buyer evidence

**Files:**
- Create with CLI: `supabase/migrations/20260718*_add_groble_phone_matching.sql`
- Create: `lib/services/earlybird/groble-phone-migration-contract.test.ts`
- Create: `lib/services/earlybird/groble-phone-pglite.test.ts`
- Modify: `lib/services/earlybird/earlybird-postgres-concurrency.integration.test.ts`
- Modify: `lib/services/earlybird/store.ts`
- Modify: `app/api/earlybird/checkout/route.ts`
- Modify: `lib/services/earlybird/checkout-route.test.ts`

- [ ] **Step 1: Generate the forward migration**

Run: `npx supabase migration new add_groble_phone_matching`

Expected: one new empty migration after `20260717140000_add_groble_earlybird_presale.sql`; never edit the already-applied presale migration.

- [ ] **Step 2: Write failing migration contract tests**

Assert all of the following literal contracts:

```ts
expect(migration).toContain('ADD COLUMN phone_number_normalized TEXT');
expect(migration).toContain('WHERE phone_number_normalized IS NOT NULL');
expect(migration).toContain('expected_buyer_phone_number_normalized TEXT');
expect(migration).toContain('groble_buyer_email TEXT');
expect(migration).toContain('groble_buyer_phone_number TEXT');
expect(migration).toContain('groble_buyer_display_name TEXT');
expect(migration).toContain('SECURITY DEFINER');
expect(migration).toContain("SET search_path = ''");
expect(migration).not.toMatch(/GRANT SELECT \([^;]*(?:groble_buyer|expected_buyer_phone)/s);
```

Also assert that authenticated field-level grants remain exactly the pre-existing safe columns, and that only `service_role` can execute the replaced checkout/payment RPCs.

Run: `npm test -- lib/services/earlybird/groble-phone-migration-contract.test.ts`

Expected: FAIL against the empty migration.

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

Run: `npm test -- lib/services/earlybird/groble-phone-pglite.test.ts`

Expected: FAIL because the columns and replaced RPCs do not exist.

- [ ] **Step 4: Implement columns, backfill, checks, and indexes**

The migration must add nullable `users.phone_number_normalized`, backfill Korean mobile numbers using this bounded SQL normalizer, raise if any non-null normalized value is duplicated, then create a partial unique index. Nullable is required for old Google accounts and Kakao accounts whose consent response has no phone.

```sql
CREATE OR REPLACE FUNCTION public.normalize_kr_mobile_e164(p_value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
RETURNS NULL ON NULL INPUT
SET search_path = ''
AS $$
    WITH normalized AS (
        SELECT pg_catalog.regexp_replace(p_value, '[^0-9]', '', 'g') AS digits
    )
    SELECT CASE
        WHEN digits ~ '^010[0-9]{8}$' THEN '+82' || pg_catalog.substring(digits FROM 2)
        WHEN digits ~ '^8210[0-9]{8}$' THEN '+' || digits
        ELSE NULL
    END
    FROM normalized
$$;

REVOKE ALL ON FUNCTION public.normalize_kr_mobile_e164(TEXT)
FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.users ADD COLUMN phone_number_normalized TEXT;
UPDATE public.users
SET phone_number_normalized = public.normalize_kr_mobile_e164(phone_number)
WHERE phone_number IS NOT NULL;

ALTER TABLE public.users ADD CONSTRAINT users_phone_number_normalized_check
CHECK (
    phone_number_normalized IS NULL
    OR phone_number_normalized ~ '^\+8210[0-9]{8}$'
);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.users
        WHERE phone_number_normalized IS NOT NULL
        GROUP BY phone_number_normalized HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'DUPLICATE_NORMALIZED_PHONE_REQUIRES_REVIEW';
    END IF;
END;
$$;

CREATE UNIQUE INDEX users_phone_number_normalized_unique
ON public.users(phone_number_normalized)
WHERE phone_number_normalized IS NOT NULL;
```

Add the four order evidence columns and three webhook buyer evidence columns (`groble_buyer_email`, `groble_buyer_phone_number`, `groble_buyer_display_name`). Add bounded length/E.164 checks and a pending lookup index on `(expected_buyer_phone_number_normalized, expected_groble_product_id)`.

- [ ] **Step 5: Replace checkout RPC with an immutable phone snapshot**

Within `create_earlybird_checkout`, load the user's `auth_provider` and normalized phone under the existing user advisory lock. Enforce:

```sql
IF v_user.auth_provider = 'kakao' AND v_user.phone_number_normalized IS NULL THEN
    RAISE EXCEPTION 'CHECKOUT_PHONE_REQUIRED';
END IF;
```

Insert `v_user.phone_number_normalized` into `expected_buyer_phone_number_normalized`. Existing Google users may insert `NULL`, preserving email matching.

- [ ] **Step 6: Replace finalization RPC with phone-first matching**

Extend the signature with `p_buyer_phone_normalized TEXT`, `p_buyer_phone_raw TEXT`, and `p_buyer_display_name TEXT`. Preserve the payment advisory lock and event/payment idempotency checks before candidate lookup. Candidate selection must be:

```sql
IF p_buyer_phone_normalized IS NOT NULL THEN
    SELECT COUNT(*)
    INTO v_candidate_count
    FROM public.earlybird_orders AS candidate
    WHERE candidate.status = 'payment_pending'
      AND candidate.expected_groble_product_id = p_product_id
      AND candidate.expected_buyer_phone_number_normalized = p_buyer_phone_normalized;

    IF v_candidate_count = 1 THEN
        SELECT candidate.id
        INTO v_candidate_order_id
        FROM public.earlybird_orders AS candidate
        WHERE candidate.status = 'payment_pending'
          AND candidate.expected_groble_product_id = p_product_id
          AND candidate.expected_buyer_phone_number_normalized = p_buyer_phone_normalized
        FOR UPDATE;
    END IF;
END IF;

IF p_buyer_phone_normalized IS NULL OR v_candidate_count = 0 THEN
    SELECT buyer.id INTO v_user_id
    FROM public.users AS buyer
    WHERE lower(btrim(buyer.email)) = lower(btrim(p_buyer_email));
    -- Count the same legacy email/product pending candidates as the existing RPC.
END IF;
```

If phone matching returns more than one row, emit `ambiguous_buyer` without email fallback. If it returns exactly one, email mismatch is irrelevant. Persist bounded raw buyer evidence on every webhook event and selected order before returning any terminal disposition. The later product/amount check, inventory lock/update, `due_at`, cancellation reconciliation, and all current dispositions remain unchanged.

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

Expected: no new lint errors. Then inspect migration status with `npx supabase migration list --linked`. Do not run `db push` until preview code and database rollout order are reviewed.

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
