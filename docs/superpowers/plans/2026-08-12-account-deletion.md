# Account deletion implementation plan

1. Generate a forward Supabase migration with `supabase migration new`.
2. Add a service-role-only deletion job table and RPCs to begin, inspect and finalize a deletion. Beginning retires the account and disables shares. Finalization deletes V1/V2 result projections, scrubs request/preflight/order/user PII, and preserves payment/refund ledger fields.
3. Add PostgreSQL/PGlite contract tests for authorization, isolation, idempotency, result deletion, share invalidation, order anonymization and `payment_pending` preservation.
4. Add a server-side account deletion orchestrator that deletes registered R2 objects before finalization, calls Supabase Auth Admin deletion last, and records only bounded failure codes.
5. Add authenticated `POST /api/account/delete` with same-origin and typed-confirmation checks plus focused route tests.
6. Add a mypage danger-zone client component with a typed `탈퇴` confirmation and UI contract tests.
7. Run focused tests, migration tests, lint, typecheck, build and security review.
8. Open a PR, require green CI, apply the allowlisted migration first, merge/deploy the app, and verify production without deleting a real account.
