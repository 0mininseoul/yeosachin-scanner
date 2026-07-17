# Instagram provider scope ledger

This ledger is the current source of truth for relationship-provider scope. Historical documents remain available for context but do not authorize implementation.

| Item | Class | Verdict | Reason | Safe alternative | Archive/reference destination |
|---|---|---|---|---|---|
| Instagram login-cookie or session-based collection | Bright-line | Descoped | Requires user or account credentials and authenticated access outside the approved public-data boundary. | Documented API-key vendor providers; direct public reads only for profile data. | `docs/superpowers/specs/2026-07-08-self-hosted-scraper-design.md` |
| Account pools, disposable accounts, or session rotation | Bright-line | Descoped | Expands credential handling and is intended to sustain access that the service may restrict. | Apify Scraping Solutions as the no-login relationship primary. | `docs/superpowers/specs/2026-07-08-self-hosted-scraper-design.md` |
| Proxy rotation, unblock services, stealth, or traffic-evasion transport | Bright-line | Descoped | Attempts to bypass or obscure provider enforcement and adds unsafe operational dependencies. | Direct public profile transport or vendor-managed documented APIs. | `docs/superpowers/plans/2026-07-08-self-hosted-scraper.md` |
| CAPTCHA or access-challenge bypass and browser/device fingerprint spoofing | Bright-line | Descoped | Circumvents access controls or misrepresents the requesting client. | Documented vendor APIs or direct public profile reads that succeed without a challenge. | `docs/superpowers/plans/2026-07-08-self-hosted-scraper.md` |
| Undocumented authenticated relationship endpoints | Bright-line | Descoped | Response and authorization contracts are not approved or stable enough for production use. | Documented Apify actor inputs; documented API-key vendors only as explicit operator diagnostics. | `docs/superpowers/plans/2026-07-08-self-hosted-scraper.md` |
| Extracting credentials from browser sessions or user logins | Bright-line | Descoped | Creates unnecessary secret-handling and account-compromise risk. | Server-side vendor API keys stored in deployment environment variables. | This ledger; historical docs are reference-only. |

## Approved implementation

- Direct, unauthenticated public profile reads through `selfhosted`.
- Apify relationship reads through `scraping_solutions/instagram-scraper-followers-following-no-cookies` as the production default, with no automatic relationship fallback.
- Top-level public comments through the Apify-maintained `apify/instagram-comment-scraper`, capped at 15 comments on each of at most six target posts; replies stay disabled.
- Public liker identities through community Actor `datadoping/instagram-likes-scraper`, capped at 150 per target post and 100 per candidate post. Only positive username intersections are persisted; missing rows remain unknown and carry explicit coverage.
- Per-request administrator controls can set `comments` and `likers` independently to `apify` or `disabled`. Neither capability has an automatic fallback.
- A shared 99% relationship completeness gate based on the target profile's declared count and the requested plan limit.
- Live Apify canaries passed with 473/474 followers and 641/642 following. Dataset order is preserved for the product's recent-mutual badges; the Actor exposes no follow timestamp, so this ordering remains a build/provider assumption that must be revalidated after changes.
- FlashAPI relationship reads only when explicitly selected by an operator for diagnosis. The live full canary returned 320/474 followers and 425/642 following (66.76% combined coverage), so it is not approved as a production default or fallback.
- CoderX and legacy Stable RapidAPI only when explicitly selected by an operator.
- Aggregate telemetry and read-only canary calls with explicit paid-call confirmation.
- Bounded no-login canaries passed for liker and comment schema, uniqueness, and post attribution. DataDoping does not provide a completeness SLA, so ongoing canaries remain required.

No approved implementation accepts Instagram passwords, login cookies, session tokens, proxy credentials, or evasion settings.

## Temporary authorized E2E exception

- One signed `test_entitlement` request for the exact allowlisted target may bind an immutable operation-to-slot map before the initial job is dispatched.
- Followers and following are separate provider operations. Each operation remains on one credential slot; a single relationship side is never paged or pooled across credentials.
- The exception is not reachable from production admission, ordinary signed tests, early access, or paid analysis. Absence of the request-bound policy preserves the deployment's existing single Starter slot behavior.
- PostgreSQL stores slot labels only. Provider tokens remain deployment secrets, and a durable provider run can resume only with its recorded slot.
- The exception must be disabled after the authorized `0_min._.00` E2E. It is not a beta or launch operating mode.
- The exception is allowlisted to Supabase owner UUID `974247fa-8d0e-4ab7-b6d2-ddf256ad6bdd` (`ym1113@kakao.com`) as well as the exact target. Success includes ownership of the request, terminal completion, visibility on that account's `기록` page, and result-link re-entry.
- Provider policy boundaries in this ledger do not define commercial terms. The only current Groble offer proposal is the canonical ["Groble 얼리버드 표시안 (성공 E2E 후 확정)" block](./operations-cost-model.md); it remains conditional on a successful E2E and Groble product review. Payment integration is outside this authorized E2E and remains on a separate branch.
