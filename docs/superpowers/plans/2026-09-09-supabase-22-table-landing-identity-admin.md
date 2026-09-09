# Landing Identity and Admin Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** \`landing_leads\`의 target/excluded 입력을 하나의 anonymous journey로 묶고, verified OAuth claim과 운영자 전용 Leads 화면을 추가한다.

**Architecture:** 기존 \`landing_leads\`와 \`analysis_preflights\` 이름을 유지한다. 서버가 device ID와 capture token의 HMAC만 저장하고, preflight 경계에서 target/excluded row를 idempotently 연결하며, operator API는 raw 입력·hash·UUID를 제거한 bounded projection만 반환한다.

**Tech Stack:** Next.js App Router, TypeScript/Zod, Supabase PostgreSQL RPC/RLS, Vitest, PGlite.

---

## Scope and exact files

| Action | Path |
|---|---|
| Create (generated path) | \`$LANDING_MIGRATION_PATH\` from \`npx supabase migration new add_landing_lead_journey_contract\` |
| Create | \`lib/services/landing/landing-lead-journey.ts\` |
| Create | \`lib/services/landing/landing-lead-journey.test.ts\` |
| Create | \`lib/services/landing/landing-lead-journey-pglite.test.ts\` |
| Create | \`app/api/admin/landing-leads/route.ts\` |
| Create | \`app/api/admin/landing-leads/route.test.ts\` |
| Modify | \`lib/services/leads/store.ts\`, \`app/api/leads/route.ts\` |
| Modify | \`lib/services/analysis/anonymous-preflight.ts\`, \`app/admin/analysis-audit/workbench.tsx\` |
| Create | \`app/admin/analysis-audit/operator-console-leads.test.tsx\` |

이 plan은 \`app/page.tsx\`, 기존 marketing copy, \`supabase/migrations/20260719190000_reconcile_stuck_groble_earlybird_order.sql\`, \`.playwright-mcp/\`를 수정하지 않는다. \`payments\`, \`payment_orders\`, \`pending_analysis\`의 상태나 데이터를 건드리지 않는다.

## Contract

새 row는 아래 shape를 지키며 attribution은 identity key가 아니다.

~~~sql
ALTER TABLE public.landing_leads
    ADD COLUMN journey_id UUID NOT NULL DEFAULT extensions.gen_random_uuid(),
    ADD COLUMN anonymous_principal_hash VARCHAR(64),
    ADD COLUMN auth_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    ADD COLUMN source_preflight_id UUID,
    ADD COLUMN capture_token_hash VARCHAR(64),
    ADD COLUMN mapping_status TEXT NOT NULL DEFAULT 'legacy_unlinked',
    ADD COLUMN mapping_source TEXT,
    ADD COLUMN linked_at TIMESTAMPTZ;

ALTER TABLE public.landing_leads
    ADD CONSTRAINT landing_leads_mapping_status_check CHECK (
        mapping_status IN (
            'legacy_unlinked', 'anonymous_device',
            'authenticated_user', 'unlinked_after_deletion'
        )
    ),
    ADD CONSTRAINT landing_leads_mapping_source_check CHECK (
        mapping_source IS NULL OR mapping_source IN (
            'legacy_import_v1', 'capture_v1', 'preflight_v1',
            'account_deletion_v1'
        )
    ),
    ADD CONSTRAINT landing_leads_capture_hash_check CHECK (
        capture_token_hash IS NULL OR capture_token_hash ~ '^[a-f0-9]{64}$'
    );

CREATE INDEX landing_leads_journey_created_idx
    ON public.landing_leads(journey_id, created_at DESC, id DESC);
CREATE INDEX landing_leads_mapping_filter_idx
    ON public.landing_leads(mapping_status, input_context, created_at DESC, id DESC);
CREATE UNIQUE INDEX landing_leads_capture_token_hash_uidx
    ON public.landing_leads(capture_token_hash);
~~~

서비스 타입은 다음 필드명과 enum을 그대로 사용한다.

~~~ts
export type LandingLeadMappingStatus =
    | 'legacy_unlinked'
    | 'anonymous_device'
    | 'authenticated_user'
    | 'unlinked_after_deletion';

export type LandingLeadJourneyClaim = Readonly<{
    journeyId: string;
    tokenHash: string;
    mappingStatus: LandingLeadMappingStatus;
    created: boolean;
}>;
~~~

## Task 1: Journey schema and one-way capture contract

**Files:**

- Create: \`lib/services/landing/landing-lead-journey.test.ts\`
- Create: \`lib/services/landing/landing-lead-journey.ts\`
- Create (generated path): \`$LANDING_MIGRATION_PATH\`
- Test: \`lib/services/leads/landing-leads-migration-contract.test.ts\`

- [ ] **Step 1: Write the failing tests.** Assert the migration contains all columns/checks/indexes above, including \`source_preflight_id UUID\`, the constrained \`mapping_source\`, and \`landing_leads_capture_token_hash_uidx\`; keeps \`ENABLE ROW LEVEL SECURITY\` and \`REVOKE ALL ON TABLE public.landing_leads FROM PUBLIC, anon, authenticated\`; and has service-only RPCs named \`create_or_replay_landing_lead_capture\`, \`claim_landing_lead_journey\`, and \`unlink_landing_lead_journey_after_deletion\`. In \`landing-lead-journey.test.ts\`, assert domain-separated HMAC output is 64 lowercase hex and never equals the raw device ID or token.

~~~ts
it('uses a domain-separated digest and never returns raw identity material', () => {
    const result = deriveAnonymousPrincipalHash(
        'device-123',
        'landing-lead-v1-secret-with-32-bytes-minimum',
    );
    expect(result).toMatch(/^[a-f0-9]{64}$/);
    expect(result).not.toContain('device-123');
    expect(result).not.toBe(createCaptureToken('device-123').token);
});
~~~

- [ ] **Step 2: Run RED.**

~~~bash
npx vitest run lib/services/landing/landing-lead-journey.test.ts lib/services/leads/landing-leads-migration-contract.test.ts
~~~

Expected: FAIL because the journey migration and service functions do not exist.

- [ ] **Step 3: Create the migration and add the minimal schema/service.** Run Steps 3–4 in one shell session so the generated path variable remains available. Capture exactly one path from the CLI output, place the contract SQL above in that file, enable and force RLS, revoke table access from \`PUBLIC, anon, authenticated, service_role\`, grant only \`service_role\` to the server RPCs, and set every SECURITY DEFINER function to \`SET search_path = ''\`.

~~~bash
set -euo pipefail
LANDING_MIGRATION_OUTPUT="$(npx supabase migration new add_landing_lead_journey_contract)"
LANDING_MIGRATION_PATH="$(printf '%s\n' "$LANDING_MIGRATION_OUTPUT" | sed -n 's/^Created new migration at //p')"
test "$(printf '%s\n' "$LANDING_MIGRATION_PATH" | awk 'NF { count++ } END { print count + 0 }')" -eq 1
test -f "$LANDING_MIGRATION_PATH"
export LANDING_MIGRATION_PATH
~~~

The capture RPC must insert target/excluded rows with one \`journey_id\`, store only token hash, and be idempotent on the nullable unique \`capture_token_hash\` fence; it must not write raw device ID. The claim RPC must update only rows matching \`auth_user_id IS NULL AND mapping_status <> 'unlinked_after_deletion'\`; the deletion fence must set \`unlinked_after_deletion\` and never make those rows claimable again. The \`claim_landing_lead_journey\` and \`unlink_landing_lead_journey_after_deletion\` definitions also use \`LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''\`. Every SECURITY DEFINER RPC uses the exact post-definition ACL below, with no broader grant:

~~~sql
CREATE OR REPLACE FUNCTION public.create_or_replay_landing_lead_capture(
    p_journey_id UUID,
    p_instagram_id TEXT,
    p_input_context TEXT,
    p_anonymous_principal_hash VARCHAR(64),
    p_capture_token_hash VARCHAR(64)
)
RETURNS TABLE(journey_id UUID, created BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    IF p_input_context NOT IN ('target', 'excluded')
       OR p_instagram_id !~ '^[a-z0-9._]{1,30}$'
       OR p_capture_token_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION 'LANDING_LEAD_INPUT_INVALID';
    END IF;
    INSERT INTO public.landing_leads(
        journey_id, instagram_id, input_context,
        anonymous_principal_hash, capture_token_hash,
        mapping_status, created_at
    ) VALUES (
        p_journey_id, p_instagram_id, p_input_context,
        p_anonymous_principal_hash, p_capture_token_hash,
        'anonymous_device', pg_catalog.clock_timestamp()
    )
    ON CONFLICT (capture_token_hash) DO NOTHING;
    RETURN QUERY SELECT p_journey_id, FOUND;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_or_replay_landing_lead_capture(UUID, TEXT, TEXT, VARCHAR, VARCHAR) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_or_replay_landing_lead_capture(UUID, TEXT, TEXT, VARCHAR, VARCHAR) TO service_role;

REVOKE EXECUTE ON FUNCTION public.claim_landing_lead_journey(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_landing_lead_journey(UUID, UUID) TO service_role;

REVOKE EXECUTE ON FUNCTION public.unlink_landing_lead_journey_after_deletion(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unlink_landing_lead_journey_after_deletion(UUID) TO service_role;
~~~

- [ ] **Step 4: Run GREEN and commit.**

~~~bash
npx vitest run lib/services/landing/landing-lead-journey.test.ts lib/services/leads/landing-leads-migration-contract.test.ts
git diff --check
git add lib/services/landing/landing-lead-journey.test.ts lib/services/landing/landing-lead-journey.ts "$LANDING_MIGRATION_PATH" lib/services/leads/landing-leads-migration-contract.test.ts
git commit -m "feat: add landing lead journey contract"
~~~

Expected: focused tests PASS and one commit contains only the journey contract.

## Task 2: Capture, preflight handoff, claim, and deletion fence

**Files:**

- Modify: \`lib/services/leads/store.ts\`, \`app/api/leads/route.ts\`
- Modify: \`lib/services/analysis/anonymous-preflight.ts\`
- Create: \`lib/services/landing/landing-lead-journey-pglite.test.ts\`
- Test: \`lib/services/leads/leads-route.test.ts\`, \`lib/services/analysis/anonymous-preflight.test.ts\`

- [ ] **Step 1: Add RED service and PGlite cases.** Cover fire-and-forget landing capture, missed capture repaired at preflight creation, excluded row with same journey and preflight, duplicate exclusion, conflicting user claim, and account deletion. Assert old owner is never replaced and deleted rows become \`unlinked_after_deletion\`.

~~~sql
UPDATE public.landing_leads
SET auth_user_id = NULL,
    mapping_status = 'unlinked_after_deletion',
    mapping_source = 'account_deletion_v1',
    linked_at = NULL
WHERE journey_id = $1
  AND mapping_status = 'authenticated_user';
~~~

- [ ] **Step 2: Implement minimal adapter.** \`POST /api/leads\` creates an opaque signed capture token, sends only its hash and the server-derived HMAC to \`create_or_replay_landing_lead_capture\`, and returns \`{ status: 'stored', captureToken }\` without raw device data. \`createAnonymousAnalysisV2Preflight\` consumes the token idempotently, binds the existing target row or creates it with \`source_preflight_id\`, and records analytics failure as a durable bounded event without blocking analysis. The claim RPC uses \`WHERE auth_user_id IS NULL AND mapping_status <> 'unlinked_after_deletion'\` and rejects a different non-null owner.

- [ ] **Step 3: Run GREEN.**

~~~bash
npx vitest run lib/services/landing/landing-lead-journey-pglite.test.ts lib/services/leads/leads-route.test.ts lib/services/analysis/anonymous-preflight.test.ts lib/services/analysis/anonymous-preflight-claim.test.ts
~~~

Expected: PASS; tests must show no raw token/device value in RPC arguments or response payloads.

- [ ] **Step 4: Commit the lifecycle adapter.**

~~~bash
git add lib/services/leads/store.ts app/api/leads/route.ts lib/services/analysis/anonymous-preflight.ts lib/services/landing/landing-lead-journey-pglite.test.ts
git commit -m "feat: bind landing leads to preflight journeys"
~~~

## Task 3: Operator API and Leads dashboard section

**Files:**

- Create: \`app/api/admin/landing-leads/route.ts\`
- Create: \`app/api/admin/landing-leads/route.test.ts\`
- Modify: \`app/admin/analysis-audit/workbench.tsx\`
- Create: \`app/admin/analysis-audit/operator-console-leads.test.tsx\`

- [ ] **Step 1: Write RED route/UI contracts.** Reuse \`createClient\`, \`getAnalysisAuditOperatorDecision\`, \`supabaseAdmin\`, and \`Cache-Control: private, no-store\`. Query accepts only \`context\`, \`mappingStatus\`, \`instagramId\`, \`from\`, \`to\`, \`cursor\`, \`pageSize\`; page size is 1–50. Assert 401/403/503/400, keyset cursor, and no \`raw_input\`, \`referrer\`, \`user_agent\`, \`anonymous_principal_hash\`, \`capture_token_hash\`, UUID, IP, or claim field in JSON.

~~~ts
const landingLeadListRowSchema = z.object({
    instagramId: z.string().regex(/^[a-z0-9._]{1,30}$/),
    inputContext: z.enum(['target', 'excluded']),
    mappingStatus: z.enum([
        'legacy_unlinked', 'anonymous_device',
        'authenticated_user', 'unlinked_after_deletion',
    ]),
    rowCountInJourney: z.number().int().positive().max(100),
    firstSeenAt: z.string().datetime({ offset: true }),
    lastSeenAt: z.string().datetime({ offset: true }),
}).strict();
~~~

- [ ] **Step 2: Implement server projection and UI.** Add \`loadLandingLeadAdminProjection\` in \`lib/services/landing/landing-lead-journey.ts\`; it groups by journey server-side and emits bounded summaries/details without internal IDs. Add Target and Excluded tabs, authenticated/anonymous-device/legacy-unlinked filters, normalized Instagram/date filters, loading/error/empty states, and keyset pagination to the existing \`AnalysisAuditWorkbench\`. Do not alter any existing marketing copy.

- [ ] **Step 3: Run GREEN.**

~~~bash
npx vitest run app/api/admin/landing-leads/route.test.ts app/admin/analysis-audit/operator-console-leads.test.tsx app/admin/analysis-audit/operator-console-interaction.test.tsx
npx tsc --noEmit --pretty false
~~~

Expected: all focused route/UI tests PASS and TypeScript exits 0.

- [ ] **Step 4: Commit and verify the dashboard boundary.**

~~~bash
git diff --check
git add app/api/admin/landing-leads/route.ts app/api/admin/landing-leads/route.test.ts app/admin/analysis-audit/workbench.tsx app/admin/analysis-audit/operator-console-leads.test.tsx
git commit -m "feat: add operator landing leads dashboard"
~~~

Expected: the diff contains no \`app/page.tsx\` change and no browser Supabase query.

## Task 4: Final regression, migration dry-run packet, and handoff

- [ ] **Step 1: Run the complete owned suite.**

~~~bash
npx vitest run lib/services/landing/landing-lead-journey.test.ts lib/services/landing/landing-lead-journey-pglite.test.ts lib/services/leads/landing-leads-migration-contract.test.ts lib/services/leads/leads-route.test.ts lib/services/analysis/anonymous-preflight.test.ts lib/services/analysis/anonymous-preflight-claim.test.ts app/api/admin/landing-leads/route.test.ts app/admin/analysis-audit/operator-console-leads.test.tsx
~~~

Expected: all tests PASS; any guarded external integration is reported as skipped, never converted to a fake pass.

- [ ] **Step 2: Run repository gates.**

~~~bash
npx tsc --noEmit --pretty false
npm run lint
npm run build
git diff --check
~~~

Expected: typecheck/build exit 0; lint has 0 errors; diff check has no output.

- [ ] **Step 3: Review security and rollout evidence.** Run \`rg -n "raw_input|user_agent|capture_token|anonymous_principal|auth_user_id" app/api/admin/landing-leads lib/services/landing\` and verify only server-side input/DB code matches. Record migration predecessor, RLS/ACL snapshot, row-count/checksum parity, and claim/deletion tests in \`docs/reports/2026-09-09-supabase-22-landing-identity-evidence.md\`.

- [ ] **Step 4: Commit the evidence report only after all checks pass.**

~~~bash
git add docs/reports/2026-09-09-supabase-22-landing-identity-evidence.md
git commit -m "docs: record landing identity evidence"
~~~

No DROP, admission activation, \`payment_pending\` mutation, or real \`0_min._.00\` canary is permitted by this plan.
