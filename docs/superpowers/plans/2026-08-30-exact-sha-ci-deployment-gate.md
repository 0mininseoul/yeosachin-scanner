# Exact-SHA CI Deployment Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan.

**Goal:** Make the script-controlled production Analysis V2 rollout fail closed unless the GitHub Actions `CI` workflow has completed successfully for the exact source commit being deployed.

**Architecture:** Add a small read-only GitHub Actions status checker with deterministic shell tests, then invoke it in apply mode immediately after `deploy-analysis-v2-worker.sh` resolves its source SHA and before any GCP authentication, lock acquisition, build, revision, traffic, scheduler, or secret mutation. Keep the existing revision-provenance and readiness checks as independent gates.

**Tech Stack:** Bash, GitHub CLI/API, `jq`, GitHub Actions, Google Cloud Run deployment scripts.

---

## Scope and ownership

- New `scripts/require-github-ci-success.sh`
- New `scripts/require-github-ci-success.test.sh`
- `scripts/deploy-analysis-v2-worker.sh`
- `scripts/test-analysis-v2-infra-scripts.sh` only if a focused integration assertion is necessary
- `docs/analysis-v2-production-operations.md`

Do not mutate GitHub, Vercel, GCP, Supabase, or provider state. Do not change the Vercel project, workflow secrets, Cloud Run traffic, or deployment settings during implementation.

## Task 1: Characterize the current release boundary

- [x] **Step 1: Inspect the controlled rollout path**

Confirm where `source_commit_sha` is resolved and prove which commands can mutate production after that point. Record the exact earliest mutation boundary in the worker handoff.

- [x] **Step 2: Inspect Vercel deployment ownership read-only**

Inspect repository configuration and available read-only Vercel project metadata to determine whether Git-connected Vercel deployments can promote before GitHub CI completes. Do not change project settings. Document this as either:

- `covered` by an existing required-check/promotion gate, with evidence; or
- `residual external setting`, with the exact setting or future workflow change needed.

Do not claim this shell gate controls Vercel if it only controls Cloud Run.

## Task 2: Add a fail-closed exact-SHA checker

- [x] **Step 1: Write failing focused tests**

The test harness must put fake `gh` behavior on a temporary `PATH` and prove these cases without network calls:

1. exact SHA, completed, success: exit 0;
2. no matching run: nonzero;
3. queued or in-progress run: nonzero;
4. completed failure, cancelled, or skipped: nonzero;
5. success for a different SHA: nonzero;
6. malformed or empty API response: nonzero;
7. missing `gh` or `jq`: nonzero;
8. GitHub API/auth failure: nonzero;
9. no token, authorization header, or raw response appears in output.

Run:

```bash
bash scripts/require-github-ci-success.test.sh
```

Expected before implementation: failure because the checker does not exist.

- [x] **Step 2: Implement the checker**

The checker must:

- accept one required 40-character lowercase source SHA;
- query repository `0mininseoul/yeosachin-scanner` and workflow `.github/workflows/ci.yml` through `gh api` using an explicit GET request;
- filter and validate the exact `head_sha` locally with `jq`, even if the API query also supplies it;
- require `status == "completed"` and `conclusion == "success"`;
- fail closed on absence, ambiguity, pending state, parsing failure, missing dependency, or API failure;
- print only sanitized status and the short SHA;
- contain no bypass or fail-open environment variable.

Do not embed credentials or rely on a caller-provided repository name.

- [x] **Step 3: Make focused tests pass**

```bash
bash scripts/require-github-ci-success.test.sh
```

Expected: all scenarios pass.

## Task 3: Wire the gate before rollout mutation

- [x] **Step 1: Add a deployment-script regression assertion**

Extend the smallest suitable shell test so it proves:

- apply mode calls the checker with exactly `source_commit_sha`;
- a rejected checker exits before the first `gcloud auth`, deploy-lock, build, revision, traffic, scheduler, or secret-mutating call;
- dry-run remains read-only and clearly reports whether the CI query was intentionally skipped or evaluated;
- no environment flag bypasses the gate.

- [x] **Step 2: Invoke the checker**

Call the checker immediately after the source SHA validation and before the existing `gcloud auth list` boundary. Preserve all existing source-archive, provenance-label, deploy-lock, revision-readiness, and traffic-promotion gates.

- [x] **Step 3: Run shell suites**

```bash
bash scripts/require-github-ci-success.test.sh
bash scripts/test-analysis-v2-infra-scripts.sh
```

Expected: both pass without external mutations.

## Task 4: Document the release rule and verify

- [x] **Step 1: Update the operations source of truth**

Document:

- local full quality must pass before push;
- GitHub `CI` must be green for the exact pushed SHA;
- only then may the script-controlled Cloud Run rollout run;
- staged/final revisions must retain the same source SHA label;
- Vercel coverage or the exact residual external setting from Task 1;
- no-spend canaries are distinct from paid E2E/provider starts.

- [ ] **Step 2: Run repository checks**

```bash
git diff --check
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Expected: zero failures.

- [x] **Step 3: Commit**

Commit only owned files with:

```bash
git commit -m "ci: require exact sha before worker rollout"
```

Return the commit SHA, exact test results, the proven pre-mutation boundary, and the Vercel coverage classification. Do not push or deploy.
