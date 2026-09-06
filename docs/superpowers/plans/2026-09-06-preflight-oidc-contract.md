# Preflight OIDC Contract Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make active preflight capacity deployment checks fail closed unless
the currently serving Vercel producer's independently reported configuration
fingerprint, every observed Cloud Tasks delivery (when present), dedicated
receiver, and exact Cloud Run service-level IAM agree with the reviewed
manifest.

**Architecture:** The public readiness route is an active-runtime evidence
boundary. It computes a versioned SHA-256 fingerprint from its own preflight
producer tuple and exposes only the digest/version/readiness booleans. The
capacity deploy wrapper first binds that response to the selected READY Vercel
deployment's source SHA and alias, then compares the digest to the reviewed
manifest-derived expectation. It separately verifies the complete Vercel v10
next-deploy environment response with exactly `envs` and
`hiddenProductionEnvCount`, requiring zero hidden Production values and
retaining only key/target metadata. It observes every task returned by the
complete Cloud Tasks list when the queue is non-empty. An empty queue relies on
the
deployment-bound active-runtime fingerprint, never on a caller-provided probe
identity. Paid and bootstrap behavior otherwise stays unchanged.

**Tech Stack:** Bash, `gcloud`, `curl`, `jq`, SHA-256 (`sha256sum` or
`shasum`), TypeScript, Vitest, existing fake Cloud Run/Cloud Tasks/Vercel
harness.

---

### Task 1: Amend and self-review the approved intent docs

**Files:**
- Modify: `docs/superpowers/specs/2026-09-06-preflight-oidc-contract-design.md`
- Modify: `docs/superpowers/plans/2026-09-06-preflight-oidc-contract.md`

- [ ] **Step 1: Replace the rejected producer evidence model**

Document the distinction between the currently serving READY Vercel
deployment and project Production env values used by a future deployment.
Document the exact readiness DTO fields, canonical fingerprint serialization,
invalid/missing fail-closed behavior, complete queue observation rule, exact
Vercel v10 next-deploy response shape and hidden-value check, and identity
separation. Remove every plain probe-env and role-manifest-as-active-producer
claim.

- [ ] **Step 2: Self-review the docs before implementation**

Run:

```bash
git diff --check
rg -n "OIDC_PROBE|caller-provided|role manifest.*active|production.*producer" \
  docs/superpowers/specs/2026-09-06-preflight-oidc-contract-design.md \
  docs/superpowers/plans/2026-09-06-preflight-oidc-contract.md
```

Confirm that any matching text is a deliberate rejection/non-goal, not an
accepted contract. Amend the existing docs-only commit before any
implementation commit; leave unrelated `package-lock.json` changes unstaged.

### Task 2: Add the active-runtime fingerprint DTO with TDD

**Files:**
- Modify: `lib/services/analysis/legacy-analysis-public-readiness.ts`
- Modify: `lib/services/analysis/legacy-analysis-public-readiness.test.ts`

- [ ] **Step 1: Add failing readiness assertions**

Extend the existing readiness fixture with fake preflight tuple values and
assert the exact DTO keys, version string, lower-case 64-hex fingerprint,
`preflightProducerConfigReady: true`, and overall `ready: true`. Add tests for
missing tuple values and invalid target/audience that assert null fingerprint,
false producer readiness, and overall `ready: false`.

- [ ] **Step 2: Capture RED**

Run:

```bash
npx vitest run lib/services/analysis/legacy-analysis-public-readiness.test.ts
```

Record the expected failure before changing the implementation.

- [ ] **Step 3: Implement the smallest pure fingerprint contract**

Use a fixed version such as `preflight-producer-config-v1`. Normalize only
strict HTTPS producer URLs: lowercase the host, remove the default HTTPS port,
require the exact worker path for the target, and require an origin-only
audience. Lowercase the validated service-account identity. Hash the version,
identity, normalized target, and normalized audience joined by newlines. Return
only the digest/version/readiness fields; never include the tuple values.

- [ ] **Step 4: Capture GREEN**

Re-run the focused readiness test and inspect the exact-key assertion.

### Task 3: Extend the capacity harness and add the RED regression

**Files:**
- Modify: `scripts/automatic-analysis-capacity-infra.test.ts`

- [ ] **Step 1: Add fake active-runtime and next-deploy fixtures**

Add a fake public readiness DTO containing the expected fingerprint, a
`publicFreeze` override, and a complete Vercel v10 next-deploy fixture with
more than one hundred key/target entries plus `hiddenProductionEnvCount: 0`.
Keep project env fixtures key-only and fake-only; never store tuple values or
credentials in them. Keep the complete queue fixture with fake
target/audience/identity and route queue calls separately from the legacy
freeze queue.

- [ ] **Step 2: Add the RED regression before shell changes**

Add a test where the manifest and complete queue agree but the active public
readiness fingerprint is drifted. Assert nonzero status and no `run deploy`.
Add a test where the active fingerprint is missing/false while the manifest is
complete, proving the manifest or project env listing alone cannot pass.

- [ ] **Step 3: Run and capture RED**

Run:

```bash
npx vitest run scripts/automatic-analysis-capacity-infra.test.ts \
  -t "active Vercel|runtime fingerprint|manifest-only"
```

The new cases must fail before the shell guard changes; do not weaken their
assertions.

### Task 4: Implement the deployment-contract guard and capture GREEN

**Files:**
- Modify: `scripts/deploy-analysis-capacity-workers.sh`

- [ ] **Step 1: Compute the reviewed-manifest fingerprint**

Add a pure shell helper with the exact serialization and URL normalization
documented above. Use `sha256sum` or `shasum` via stdin and never log tuple
values or the digest. Compute from `manifest_value` results, after strict
manifest validation.

- [ ] **Step 2: Bind active Vercel readiness to the selected deployment**

Keep the existing READY deployment source-SHA and URL/alias checks. After that
binding, fetch the public readiness DTO and require the exact fingerprint
version, valid digest, and `preflightProducerConfigReady: true` to match the
manifest-derived digest. The DTO's overall readiness and exact existing route
fields remain required. Do not read/decrypt Vercel env values as producer
evidence. Require exactly one read-only Vercel v10 project environment
response with the exact top-level `envs` and `hiddenProductionEnvCount` keys,
integer hidden count `0`, valid key/target metadata, and exactly one
Production entry for each required key; fail closed on malformed, hidden,
duplicate, paginated, direct-single-env, or legacy response variants.

- [ ] **Step 3: Require independent queue evidence**

Remove the caller-provided probe identity variable entirely. For a non-empty
queue, require every returned task's URL, normalized audience, and
OIDC service-account identity to match the reviewed receiver contract. For an
empty queue, accept only the already verified active-runtime fingerprint. Call
this helper after Vercel deployment/readiness binding in check, pre-deploy,
pre-promotion, and post-promotion paths.

- [ ] **Step 4: Capture GREEN**

Run the focused fingerprint, empty-queue, queue-drift, and next-env tests. Then
run the full capacity harness:

```bash
npx vitest run scripts/automatic-analysis-capacity-infra.test.ts
```

Expected: all selected cases pass, with no `run deploy` on rejected evidence.

### Task 5: Update existing exact-key readiness checks and verify scope

**Files:**
- Modify: `scripts/check-analysis-v2-release-readiness.sh`
- Modify: `scripts/test-analysis-v2-release-readiness.sh`
- Modify: `lib/services/analysis/legacy-analysis-public-readiness.test.ts`

- [ ] **Step 1: Update public DTO exact-key assertions**

Require the three version/digest/readiness fields in the release checker and
update its fake response. Keep the check structural where no reviewed
preflight manifest is available; do not print the digest.

- [ ] **Step 2: Review safety and scope**

Run:

```bash
git diff --check
rg -n "OIDC_PROBE|caller-provided probe identity" scripts docs lib app || true
```

Confirm the probe env is absent, role manifests are never described as active
producer evidence, and no credential, decrypted project value, task body,
identity address, or unrelated UX/application change was added. Confirm
`--dry-run` remains non-observing and `--check`/reconcile paths remain
non-mutating for rejected contracts.

### Task 6: Run proportionate repository verification and commit logical changes

- [ ] **Step 1: Run focused and shell checks**

```bash
bash -n scripts/deploy-analysis-capacity-workers.sh
npx vitest run lib/services/analysis/legacy-analysis-public-readiness.test.ts
npx vitest run scripts/automatic-analysis-capacity-infra.test.ts
bash scripts/test-analysis-v2-release-readiness.sh
bash scripts/test-analysis-v2-infra-scripts.sh
```

- [ ] **Step 2: Run static checks**

```bash
npm run lint
npx tsc --noEmit
npm run build
git diff --check
```

If an environment-only dependency or external service blocks a command, record
the exact command failure without claiming success.

- [ ] **Step 3: Commit only clean logical changes**

Preserve commits `94fe6a25` and `75b03b16`, then create one follow-up commit
containing only the deployment guard, docs, and capacity harness changes.
Leave `package-lock.json` clean. Do not merge, deploy, mutate production, or
open a PR.
