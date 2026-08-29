# Supabase and Legacy Cleanup Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan.

**Goal:** Produce an evidence-backed, read-only reduction map for the oversized Supabase schema and duplicate analysis code so a later cleanup can preserve all required user and payment data while removing only proven legacy objects.

**Architecture:** Query catalog metadata and aggregate counts only, then cross-reference each database object against application code, migrations, operations scripts, and data-policy requirements. Deliver documentation and a sequenced cleanup proposal; create no migration and execute no DDL or DML.

**Tech Stack:** Supabase CLI, PostgreSQL catalogs, `rg`, Git history, Markdown.

---

## Non-negotiable safety boundary

- Read-only catalog queries and aggregate counts only.
- No `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `ALTER`, `DROP`, `CREATE`, RPC mutation, migration repair, or `supabase db push`.
- Do not create any file under `supabase/migrations/`.
- Do not print or persist API keys, database passwords, cookies, UUIDs, email addresses, usernames, raw event payloads, or row-level user data.
- Preserve the protected migration `supabase/migrations/20260719190000_reconcile_stuck_groble_earlybird_order.sql` untouched.
- Use the linked production project and macOS Keychain path described in `AGENTS.md`; do not source `.env.local` directly.

## Scope and ownership

- New `docs/reports/2026-08-30-supabase-legacy-cleanup-audit.md`
- New `docs/reports/2026-08-30-supabase-legacy-cleanup-audit.ko.md`
- Documentation only. No source, test, config, or migration changes.

## Task 1: Establish trustworthy inventory evidence

- [ ] **Step 1: Verify project identity without exposing credentials**

Confirm the linked Supabase project is the production `yeosachin` project using sanitized CLI metadata. If identity cannot be proven, stop rather than querying another project.

- [ ] **Step 2: Capture catalog-only inventory**

Collect sanitized metadata for application schemas, including:

- tables, partitioned tables, views, materialized views, sequences;
- estimated row counts and total/index/toast sizes;
- columns, primary keys, unique constraints, foreign keys, and dependency edges;
- functions/RPCs, triggers, RLS enablement, and policy names/roles/actions;
- publication/realtime membership;
- storage bucket/object dependency counts without object names or paths;
- migration history alignment.

Do not include row contents or identifiers in the report.

- [ ] **Step 3: Record evidence limitations**

Distinguish exact counts from PostgreSQL estimates, live catalog evidence from migration history, and objects whose external consumers cannot be proven locally.

## Task 2: Cross-reference repository usage

- [ ] **Step 1: Map database objects to code**

Search `app/`, `lib/`, `hooks/`, `components/`, `scripts/`, `supabase/migrations/`, `.github/`, and current operations documentation for each object, function, status, and storage dependency. Exclude generated dependency directories.

- [ ] **Step 2: Map analysis engines and adapters**

Identify the current canonical paid analysis path and every older or duplicate entry point, including:

- API routes and queue/task handlers;
- V1/V2/concierge/replay helpers;
- scraper routers and the intentionally retained `apify`, `rapidapi`, and `selfhosted` provider switch;
- duplicate DTOs, status projections, result assemblers, and operational scripts.

Do not recommend removing a provider implementation merely because it is inactive by default; the switchable collection architecture is intentional.

- [ ] **Step 3: Classify confidence**

For every candidate, assign exactly one:

- `keep`;
- `consolidate`;
- `archive-then-drop`;
- `drop-candidate`;
- `unknown`.

Every `drop-candidate` must have zero live code references, no unresolved dependency edge, a stated data-retention disposition, and a rollback/archive note. Otherwise classify it `unknown` or `archive-then-drop`.

## Task 3: Apply the approved data-policy constraints to the proposal

- [ ] **Step 1: Preserve the required cohort**

The proposal must preserve as much user-owned data as possible from 2026-07-24 onward. It must also preserve the administrator identity while treating administrator-generated test orders and analysis artifacts as removable only in a later separately approved mutation.

- [ ] **Step 2: Account for known entity splits**

The target schema proposal must address:

- split `landing_leads` into target-account and excluded-account ownership;
- stable anonymous-to-authenticated mapping for the same visitor;
- a separate plan-waitlist entity;
- a separate withdrawn-user archive with re-login hiding pre-withdrawal data;
- paid-only `first_paid_at` semantics;
- short-lived abandoned `payment_pending` cleanup while preserving independent provider/payment evidence;
- removal of the 22 known E2E identities and their artifacts only in a later approved cleanup;
- preservation of valid external-user orders and results.

- [ ] **Step 3: Sequence the future reduction safely**

Propose phases with explicit preconditions:

1. observability and backup/archive proof;
2. compatibility reads/writes or data copy;
3. reference and contract migration;
4. retention cleanup;
5. object removal;
6. post-removal verification and rollback window.

No SQL in the report may be presented as ready-to-run production migration. Prefer pseudocode or clearly fenced non-executable sketches.

## Task 4: Produce the reports and commit

- [ ] **Step 1: Write the English evidence report**

Include:

- executive decision;
- inventory totals by object kind;
- keep/reduce matrix with evidence and confidence;
- canonical analysis-flow map;
- proposed target schema and code boundary;
- ordered cleanup waves;
- unknowns and required validation;
- explicit statement that no production mutation occurred.

- [ ] **Step 2: Write the Korean executive summary**

Keep it concise and decision-oriented: what can be removed confidently, what must stay, what requires archive/migration first, and the next approval boundary.

- [ ] **Step 3: Validate privacy and scope**

```bash
git diff --check
git status --short
rg -n '(service_role|SUPABASE_SERVICE_ROLE_KEY|postgres(ql)?://|Bearer |eyJ[a-zA-Z0-9_-]+\.)' \
  docs/reports/2026-08-30-supabase-legacy-cleanup-audit.md \
  docs/reports/2026-08-30-supabase-legacy-cleanup-audit.ko.md
```

Expected: only the two report files are changed and the secret-pattern scan returns no findings.

- [ ] **Step 4: Commit**

```bash
git add \
  docs/reports/2026-08-30-supabase-legacy-cleanup-audit.md \
  docs/reports/2026-08-30-supabase-legacy-cleanup-audit.ko.md
git commit -m "docs: audit supabase and legacy cleanup scope"
```

Return the commit SHA, sanitized inventory totals, high-confidence candidates, unknowns, and confirmation that no DDL/DML/provider call occurred. Do not push or deploy.
