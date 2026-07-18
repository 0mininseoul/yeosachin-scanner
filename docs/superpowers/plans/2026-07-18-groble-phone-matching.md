# Groble Phone Matching Implementation Plan

> [!WARNING]
> **SUPERSEDED - DO NOT EXECUTE.** 이 역사적 계획 문서는 구현 이력 보관용이며 아래 task, 명령, pseudocode는 실행 지침이 아니다. 현행 계약은 [Groble 전화번호 매칭 설계](../specs/2026-07-18-amplitude-axiom-groble-phone-design.md)와 [Groble 얼리버드 운영 문서](../../groble-earlybird-operations.md)가 정본이다. raw 전화번호 기반 신뢰, Google/이메일 기반 신규 checkout, 기존 주문 전화번호 backfill, Groble 구매자 연락처 영속 저장을 지시하는 문구는 폐기되었고 구현하면 안 된다. `20260719131500_stop_persisting_groble_buyer_contacts.sql`은 기존 연락처를 삭제하고 이후 연락처를 보관하지 않도록 old/new writer를 강제한다.

> Archive only: task checkbox와 commit 예시는 당시 진행 기록을 설명할 뿐 현재 작업 목록이 아니다.

**Current goal:** Match Groble payments to immutable, recently verified Kakao phone snapshots even when Groble and login emails differ. Email fallback is restricted to orders created before migration and labeled `legacy_email`.

**Current architecture:** The Kakao REST callback is the only phone-provenance writer and records raw, E.164, `kakao_rest_api`, and DB-clock verification evidence atomically. Checkout and the mandatory order trigger require that evidence to be no more than 24 hours old, overwrite caller-supplied matching fields, and create an immutable `verified_kakao_phone` snapshot. Existing orders alone remain `legacy_email`; no migration promotes raw profiles or backfills order phones. Checkout and direct INSERT share a namespaced product fence before user/snapshot locks. The 9-argument wrapper rejects NULL event types, validates before `payment -> product -> sorted users`, and includes the existing payment owner with product and email candidates before preserving accepted duplicate replay. It blocks every new event if any same-product unresolved verified order exists. The canonical 12-argument finalizer treats Groble buyer values as transaction-local matching inputs. The contact fence migration clears compatibility columns and forces old and new writers to store `NULL`.

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

### Task 2: Record verified Kakao provenance and keep Google ownership access

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

Test that a Kakao REST phone sync populates both raw and normalized fields, invalid or absent data clears both, a non-Kakao metadata sync preserves them, and no email value enters this object. These fields alone are not trusted until the callback writes their provenance atomically.

Run: `npm test -- lib/services/identity/auth-profile.test.ts`

Expected: FAIL because the helper does not exist.

- [ ] **Step 2: Implement profile normalization and use it in both sync paths**

`buildAuthProfilePatch` must call `normalizeKoreanMobileNumber` only for an explicit Kakao REST synchronize mode. `/api/user/me` may reuse the helper for non-phone profile fields but must not read or write phone fields from auth metadata. On Kakao callback, update the phone values on every login and atomically write `phone_number_verification_source = 'kakao_rest_api'` plus a verification timestamp; invalid or absent phone data clears the complete provenance tuple. Retain existing Google sessions only for ownership access.

```ts
const profile = buildAuthProfilePatch(kakaoRestProperties);
await supabaseAdmin.from('users').upsert({
    id: user.id,
    email: user.email,
    provider,
    ...profile,
    phone_number_verification_source: profile.phone_number_normalized
        ? 'kakao_rest_api'
        : null,
    phone_number_verified_at: profile.phone_number_normalized
        ? callbackTimestamp
        : null,
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

### Task 3: Ordered forward-only database migrations for verified snapshots

**Files:**
- Create with CLI: `supabase/migrations/20260719131000_add_groble_phone_matching.sql`
- Create with CLI: `supabase/migrations/20260719131100_activate_groble_phone_checkout.sql`
- Create with CLI: `supabase/migrations/20260719131200_backfill_groble_phone_matching.sql`
- Create with CLI: `supabase/migrations/20260719131300_validate_groble_phone_matching.sql`
- Create with CLI: `supabase/migrations/20260719131400_activate_groble_phone_finalization.sql`
- Create: `lib/services/earlybird/groble-phone-migration-contract.test.ts`
- Create: `lib/services/earlybird/groble-phone-pglite.test.ts`
- Modify: `lib/services/earlybird/earlybird-postgres-concurrency.integration.test.ts`
- Modify: `lib/services/earlybird/store.ts`
- Modify: `app/api/earlybird/checkout/route.ts`
- Modify: `lib/services/earlybird/checkout-route.test.ts`

- [ ] **Step 1: Generate the five forward migrations**

Run each command separately so the filenames have a strict timestamp order:

```bash
npx supabase migration new add_groble_phone_matching
npx supabase migration new activate_groble_phone_checkout
npx supabase migration new backfill_groble_phone_matching
npx supabase migration new validate_groble_phone_matching
npx supabase migration new activate_groble_phone_finalization
```

Expected: five new empty migrations after `20260717140000_add_groble_earlybird_presale.sql`; never edit the already-applied presale migration. Supabase CLI v2.102.0 executes each file as one implicit transaction and does not support a no-transaction migration directive, so file boundaries are lock and rollout boundaries.

- [ ] **Step 2: Write failing migration contract tests**

Read all five files in timestamp order. Assert both the combined feature contract and these per-file statement boundaries:

```ts
expect(ddlMigration).toContain('ADD COLUMN phone_number_normalized TEXT');
expect(ddlMigration).toContain('BEFORE INSERT ON public.earlybird_orders');
expect(ddlMigration).not.toMatch(/^UPDATE public\./m);
expect(checkoutMigration).toContain('create_earlybird_checkout');
expect(checkoutMigration).not.toContain('finalize_earlybird_groble_payment');
expect(backfillMigration).not.toMatch(/^ALTER TABLE/m);
expect(validationMigration).not.toContain('CREATE OR REPLACE FUNCTION');
expect(finalizationMigration).not.toContain('create_earlybird_checkout');
```

Also assert that no file contains both an `ALTER TABLE ... ADD` action and a top-level backfill, all 11 checks are added `NOT VALID` and validated only in phase 4, and phase 1 contains `SECURITY DEFINER`/empty-search-path provenance and snapshot triggers revoked from `PUBLIC`, `anon`, `authenticated`, and `service_role`. The order trigger must be mandatory, Kakao-only, `BEFORE INSERT` only, acquire the shared namespaced product lock before snapshot lookup, ignore caller-supplied policy fields, and require complete Kakao REST provenance verified within 24 hours. Phase 1 must rename/revoke the old checkout body and expose only a bounded-validation, product-first bridge; the internal body stays until a post-drain migration. Assert that `/api/user/me` cannot establish provenance, checkout performs the same fresh-verification check in `product -> user` order, both finalizers use NULL-safe event-type validation, and the rolling wrapper uses `validation -> payment -> product -> sorted verified/payment-owner/email users -> duplicate/gates`. Authenticated field-level grants remain exactly the pre-existing safe columns, and only `service_role` can execute either finalizer signature and the public checkout/refund RPCs.

Run: `npm test -- lib/services/earlybird/groble-phone-migration-contract.test.ts`

Expected: FAIL while the CLI-generated phase files are empty or the original migration is still monolithic.

- [ ] **Step 3: Write failing PGlite behavioral tests**

Cover these complete scenarios:

```ts
it('accepts one phone-matched order when buyer email differs');
it('falls back to email only for a pre-migration legacy_email order');
it('does not persist buyer contacts on accepted or unmatched events');
it('does not consume inventory for zero or multiple phone candidates');
it('does not let displayName influence matching');
it('preserves mismatch, duplicate event, duplicate payment and overflow behavior');
it('snapshots the current user phone and does not follow later profile changes');
it('rejects checkout without fresh complete Kakao REST provenance');
it('rejects a Google checkout without verified Kakao provenance');
it('fails closed when an old checkout body inserts after activation');
it('treats multiple cancelled legacy candidates as ambiguous');
it('blocks a new 9-argument event for any same-product unresolved verified order');
it('preserves accepted 9-argument duplicate_event and duplicate_payment replay');
it('serializes a same-product checkout behind the rolling wrapper product gate');
it('serializes same-payment rolling and canonical finalizers without deadlock');
```

Apply all five migrations sequentially in separate `database.exec` calls. Verify that Phase 1 renames and revokes the presale body, exposes only its product-first bridge, and that a bridge call resumed after Phase 2 can still reach the internal body but fails closed without complete fresh provenance. Prove the mandatory trigger rejects an unverified direct insertion even though `service_role` cannot execute the trigger function directly. Add environment-gated native PostgreSQL tests that (a) pause the rolling wrapper on a legacy user lock and prove a different user's same-product checkout waits on the product fence, (b) queue rolling then canonical calls for one payment behind a user lock and prove both finish as accepted/duplicate without deadlock, (c) force cross-product wrappers to share a duplicate-payment owner and email candidate and prove the payment owner is prelocked in the same sorted set, and (d) resume a raw-only Phase 1 bridge call after Phase 2 and prove `CHECKOUT_PHONE_REQUIRED` with no order.

Expected: FAIL because the columns and replaced RPCs do not exist.

- [ ] **Step 4: Implement five bounded migration transactions**

Every file sets `lock_timeout = '5s'` and `statement_timeout = '2min'`. Keep these dependencies and statement classes exact:

| Phase | Allowed work |
|---|---|
| 1, `add` | Add nullable user/order/webhook compatibility columns, add 11 bounded checks as `NOT VALID`, create and revoke the strict normalization helper, install the user provenance trigger, the mandatory product-fenced fresh-Kakao `BEFORE INSERT` order snapshot trigger, and the immutable snapshot guard. Rename the prior checkout body to an application-role-revoked internal function and expose a bounded-validation product-first bridge. The constant default classifies only rows that already existed as `legacy_email`. Do not scan, validate, index, or grant browser access in this transaction. |
| 2, `activate checkout` | Replace the public `create_earlybird_checkout` bridge and its ACL, leaving the revoked internal Phase 1 body for a post-drain migration. Require complete Kakao REST provenance no more than 24 hours old after `product -> user` advisory locks; never derive trust from raw or auth-metadata values. |
| 3, `backfill` | Clear partial or unproven user provenance without promoting legacy raw phones, abort on duplicate verified normalized phones, and leave all existing orders as `legacy_email`. Do not backfill order phone snapshots, run `ALTER TABLE`, create indexes, or replace functions. |
| 4, `validate` | Validate all 11 checks and create the user unique index plus pending and cancelled phone lookup indexes. Normal indexes are intentional because the CLI cannot run a concurrent index outside its implicit transaction; use the measured-size deployment gate in `docs/groble-earlybird-operations.md`. |
| 5, `activate finalization` | Restate the safe authenticated projection, replace canonical finalizer/refund RPCs, install the rolling compatibility wrapper, and apply their service-role ACLs. Do not redefine checkout or mix schema DDL, backfill, validation, or indexes into this transaction. |

Nullable user phones remain required for old Google accounts and Kakao accounts whose consent response has no phone. Before phase 1, stop checkout/order INSERT writes and verify there are no active writers; its table DDL drains transactions that already reached the relation. Once phase 1 commits, the bridge establishes product-before-user ordering and every new order INSERT must pass the product-fenced trigger's complete, fresh Kakao REST provenance check. A Phase 1 bridge call waiting through Phase 2 can still invoke the revoked internal body, and a raw-only call fails closed with `CHECKOUT_PHONE_REQUIRED`. Phase 3 clears partial or unproven user tuples and never repairs orders or promotes raw values. Phase 2 rejects every checkout without fresh provenance regardless of provider. A duplicate abort rolls phase 3 back as a unit while phases 1 and 2 remain compatible.

- [ ] **Step 5: Replace checkout RPC with an immutable phone snapshot**

Within `create_earlybird_checkout`, validate bounded request/product inputs, acquire `hashtextextended('earlybird:groble:product:' || p_expected_product_id, 0)`, and then acquire the existing user advisory lock. Load the user's provider and complete phone provenance with `FOR UPDATE`. Validate it without deriving or falling back:

```sql
IF v_user_provider <> 'kakao'
   OR v_user_phone_number_verification_source IS DISTINCT FROM 'kakao_rest_api'
   OR v_user_phone_number_verified_at IS NULL
   OR v_user_phone_number_verified_at < clock_timestamp() - INTERVAL '24 hours'
   OR v_user_phone_number_normalized IS NULL
   OR public.normalize_kr_mobile_e164(v_user_phone_number)
        IS DISTINCT FROM v_user_phone_number_normalized THEN
    RAISE EXCEPTION 'CHECKOUT_PHONE_REQUIRED';
END IF;
```

Insert normalized, source, and verified-at into the order snapshot with policy `verified_kakao_phone`. Existing Google users cannot create new orders without independently obtaining the same verified Kakao provenance. The phase-1 order trigger re-enters the same product lock before provenance lookup on RPC calls and acquires it itself for service-role direct INSERTs, then overwrites caller-supplied matching fields; a separate UPDATE trigger keeps the snapshot immutable. Give both `SECURITY DEFINER` functions an empty search path and revoke direct execution from every application role. The user trigger may enforce atomicity and DB-clock verification, but only the Kakao REST callback may present new provenance; never derive identity from arbitrary auth metadata.

- [ ] **Step 6: Activate canonical and rolling-compatible finalization RPCs**

In phase 5, create the canonical 12-argument signature by adding `p_buyer_phone_normalized TEXT`, `p_buyer_phone_raw TEXT`, and `p_buyer_display_name TEXT`. The last two remain compatibility parameters and current callers pass typed `NULL`. Keep the existing 9-argument signature as a service-only wrapper. Do not drop this wrapper in the activation migration; remove it only through a later post-drain migration after every old application instance has exited.

The 9-argument wrapper must duplicate canonical bounded input validation before deriving lock keys; both overloads use `IS DISTINCT FROM` so a NULL event type fails closed before duplicate attribution. The wrapper then acquires the canonical payment lock, shared namespaced product lock, and one text-sorted union of unresolved verified owners, the existing `payment_id` order owner, and email candidates. Only after those locks may it make the read-only check for an already accepted event ID or payment ID and delegate such calls so canonical `duplicate_event` and `duplicate_payment` dispositions continue to work. For a new event, recheck all unresolved verified orders for the product under the product fence and raise `GROBLE_CANONICAL_PHONE_REQUIRED` before any event or idempotency write if one remains. Only when that set is empty may it delegate an email-only legacy candidate. The canonical call re-enters payment/user locks, so same-payment old/new calls and cross-product duplicate wrappers cannot form a user-lock inversion.

For the canonical finalizer, determine every user reachable through the current phone, email, or an unresolved phone snapshot, lock those user IDs in text-sorted order, then run all authoritative counts. The query order is:

```sql
-- 1. payment_pending by normalized phone + product
-- 2. when count = 0, cancelled/payment_id IS NULL by phone + product + amount
-- 3. only when both phone counts = 0, payment_pending by email + product
-- 4. reselect the chosen row with the same predicates and FOR UPDATE
```

If pending phone matching returns more than one row, emit `ambiguous_buyer` without email fallback. If it returns exactly one, email mismatch is irrelevant. After zero pending phone candidates, check unresolved cancelled snapshots by phone, product, and amount before email fallback: one becomes `late_cancelled_payment`/`refund_pending`, multiple are ambiguous, and zero continues to the legacy email path. The legacy cancelled path must also count exact user/product/amount candidates and return `ambiguous_buyer` for more than one instead of selecting the latest row. Lock every possible user in deterministic order, and make checkout and refund transitions use the same per-user advisory lock before their row lock. Treat buyer inputs as transaction-local and leave contact compatibility columns `NULL`. The later product/amount check, inventory update, `due_at`, and all current dispositions remain unchanged.

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

### Task 4: Parse transaction-local Groble matching inputs

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
    productId: string;
    amountKrw: number;
    paidAt: string;
}
```

Test bounded trimming, phone omission for legacy fixtures, overlong rejection, phone normalization forwarding, and an email-mismatch/phone-match accepted route result. Display names are not part of the parsed application event.

Run: `npm test -- lib/services/groble/webhook.test.ts lib/services/earlybird/groble-webhook-route.test.ts`

Expected: FAIL because the parser and RPC call omit the fields.

- [ ] **Step 2: Extend the strict schema without breaking old signed fixtures**

```ts
buyer: z.object({
    email: z.string().trim().email().max(320),
    phoneNumber: z.string().trim().min(1).max(64).optional(),
}),
```

Return `null` for an absent phone. Do not log any buyer value.

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
    p_buyer_phone_raw: null,
    p_buyer_display_name: null,
    p_product_id: event.productId,
    p_amount_krw: event.amountKrw,
    p_paid_at: event.paidAt,
});
```

Raw phone and display name compatibility arguments stay `NULL`, and the later contact fence forces every compatibility column to `NULL` for old and new writers. Preserve webhook 2xx behavior for unmatched, ambiguous, mismatch, duplicate, and overflow dispositions.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- lib/services/groble/webhook.test.ts lib/services/earlybird/groble-webhook-route.test.ts lib/services/earlybird/checkout-route.test.ts`

Expected: PASS.

```bash
git add lib/services/groble app/api/webhooks/groble/route.ts lib/services/earlybird/groble-webhook-route.test.ts
git commit -m "feat: process Groble buyer matching input"
```

### Task 5: Security, privacy, browser verification, and rollout

**Files:**
- Modify: `app/privacy/page.tsx`
- Modify: `.env.example` only if a non-secret contract changes
- Modify: `docs/groble-earlybird-operations.md`

- [ ] **Step 1: Update the privacy and operations contracts**

State that Groble supplies buyer email and phone as transaction-local payment-matching inputs and name Groble as the payment provider. Do not claim that card numbers or buyer contacts are retained by this application. Document phone-first matching, migration-only `legacy_email` fallback, unmatched manual review, the database contact fence, and the rule that no buyer PII enters Amplitude or Axiom.

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

Expected: no new lint errors. Then inspect all five files in timestamp order with `npx supabase migration list --linked`, repeat the row-count/size query in `docs/groble-earlybird-operations.md`, and follow its lock-timeout abort/retry procedure. Do not run `db push` until preview code and the split database rollout order are reviewed.

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
git commit -m "docs: disclose Groble buyer matching inputs"
```
