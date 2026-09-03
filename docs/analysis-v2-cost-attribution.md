# Automatic-analysis v2 cost attribution

Migration `20260904110000_add_analysis_v2_cost_attribution.sql` adds the
service-role-only request/order rollup for automatic-analysis v2. It extends
the existing provider, preflight, AI-attempt, budget-reservation, cache, and
self-hosted ledgers; it does not replace their facts or change the existing
reserve/load/terminalize RPC wire shape.

## Scope and naming

The fixed rollup scope is
`analysis-v2-direct-provider-and-vertex-metered-v1`, with
`infrastructure_included = false`. `total_known_cost_usd` and
`total_conservative_cost_usd` therefore cover directly attributable provider
charges and deterministic Vertex/Gemini metered estimates only. They exclude
shared Cloud Run, Cloud Tasks, Supabase, Vercel, and email overhead and must
not be presented as fully loaded invoice cost or as a total infrastructure
average.

Apify values are provider-reported actual charges only when the authoritative
provider run is terminal and reconciled. Vertex/Gemini response usage is
stored as `metered_estimated_cost_usd`, tied to immutable
`pricing_version`, `canonical_model_name`, and location provenance; it is not
an invoice actual. Unknown, active, manually unresolved, or unreconciled
provider rows remain conservative estimates or unknown usage according to the
rollup and are never relabeled as actual charges.

## Attribution and completeness

When a preflight is consumed, the mapping table records one source identity per
preflight/provider operation. Its unique keys make retries and repeated
reconciliation idempotent, while the rollup joins the mapping to the
authoritative provider-run row so a late Apify reconciliation updates the same
attribution exactly once. The order link is populated when
`earlybird_orders.result_request_id` is available; production and
`test_entitlement` requests are included for `basic`, `standard`, and `plus`
plans where those request columns are present.

`directly_attributable_cost_complete` is deliberately stricter than “the amount columns are
non-null.” The rollup exposes source/operation counts, `usage_unknown`, and
per-ledger coverage-gap counts for missing preflight evidence, provider
evidence, AI attempts, and budget cross-checks. For a consumed preflight with
no provider rows, `provider_selector = selfhosted_auth` is an explicit
zero/no-paid-provider fact; an anonymous/cache selector remains unknown
because this schema does not prove a cache hit. A missing AI attempt/cache
source likewise remains unknown unless an existing ledger row proves it, so no
synthetic AI zero receipt is created. For guarded v2.12 attempts, every
non-cancelled `vertex_ai_budget_reservations` row must match the AI-attempt
ledger by request/run, operation, attempt, model, and location; reserved,
`usage_unknown`, unmatched, duplicate, or mismatched reservations make the
request incomplete. Reservation `actual_cost_usd` is treated as the same
metered response estimate and is not summed as an additional charge. For an
uncertain reservation, `total_conservative_cost_usd` includes only the
non-negative delta between `estimated_cost_usd` and any matched complete
attempt estimate, preventing double counting.

Self-hosted authenticated scraper receipts are explicit
`selfhosted_auth`/`no_paid_provider` zero-cost provenance, since that path
deliberately bypasses paid provider runs. Only bounded operation/provider/
status/count fields are exposed; `items`, `account_slot`, and secrets are not
copied. Global-cache checkpoints are explicit no-call/cache-hit evidence.

The current Gemini V2 transport sends inline `contents` and no
`cachedContent` reference. A complete response may therefore record proven
zero cache-read tokens for this transport; provider omission must not be
treated as zero on a transport that can send cached content. Legacy attempts
remain null/unknown because this migration does not invent historical pricing
or cache provenance.

## Retention and read boundary

Terminal requests are copied into a durable, PII-free snapshot. Source-table
changes, including late reconciliation, refresh the snapshot, and a
`BEFORE DELETE` request trigger performs the final refresh while cascading
request/preflight children still exist. The snapshot intentionally has no
foreign keys to purgeable source rows, so request/preflight `ON DELETE
CASCADE` cannot erase completed cost history. The live/history views are
intentionally default-definer aggregation views: all new table/view/function
privileges are revoked from public, anon, and authenticated, with only the
service role granted, and executable coverage verifies the denied read path.
`load_analysis_v2_cost_rollup` is service-role-only.

## Rollout order and verification

Apply the concurrent Supabase optimization migration
`20260904100000` first, then apply this migration as
`20260904110000`. Rebase this branch on `origin/main` after the optimizer PR
lands, rerun the migration contract and PGlite tests, and perform the normal
review/CI migration checks before any remote application. This change requires
no external Instagram/provider/account reads or canary, and it performs no
production mutation; it does not by itself require an app-runtime code deploy;
after merge, apply
`20260904110000` remotely only through the documented predecessor gate. Shared
infrastructure allocation is explicitly out of scope.
