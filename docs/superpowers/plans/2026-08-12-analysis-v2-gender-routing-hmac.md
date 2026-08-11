# Analysis V2 Gender-Routing HMAC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reproducible, dedicated Secret Manager lifecycle and Cloud Run injection for `ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET` without altering normal production or Plus behavior.

**Architecture:** The existing secret lifecycle script owns the new `ai-baram-v2-gender-routing-hmac` resource, its outside-source value validation, explicit numeric version pin, and exact runtime-identity IAM. The worker deployment script owns a single Secret Manager injection and validates the full service/serving-revision contract; an existing service may have the ref absent only before its initial addition, while malformed or partially-added refs fail closed.

**Tech Stack:** Bash, gcloud Secret Manager/Cloud Run contracts, jq, Node dotenv parsing, shell fixture tests.

---

### Task 1: Specify the new lifecycle in failing shell fixtures

**Files:**
- Modify: `scripts/test-analysis-v2-secret-scripts.sh`
- Modify: `scripts/test-analysis-v2-infra-scripts.sh`

- [x] **Step 1: Add secret-lifecycle assertions before implementation**

Extend the fake Secret Manager dispatcher with a dedicated `ai-baram-v2-gender-routing-hmac` payload case and add the new source-only fixture key plus its version pin. Assert initial apply creates the resource/version/IAM, dry-run prints only the logical key, and output/manifests never contain its fixture value.

```bash
assert_contains "$temp_dir/missing-apply.out" \
  "pin: ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET_VERSION=1"
assert_not_contains "$temp_dir/missing-apply.out" "$gender_routing_hmac_fixture"
```

- [x] **Step 2: Add deployment contract failures before implementation**

Make the fake Cloud Run service expose the new reference in its default healthy fixture, then add `--check` cases for zero, wrong-name, duplicate, plaintext, `latest`, and mismatched numeric version refs. Keep an apply/dry-run fixture whose active and latest revisions are both absent to prove first injection remains possible.

```bash
if env "${deploy_env[@]}" FAKE_GCLOUD_SERVICE_STATE=gender-hmac-plaintext \
  bash "$script_dir/deploy-analysis-v2-worker.sh" --check >"$temp_dir/gender-hmac-plaintext.out" 2>&1; then
  fail "plaintext gender-routing HMAC reference was accepted"
fi
```

- [x] **Step 3: Run the focused shell tests to verify RED**

Run: `bash scripts/test-analysis-v2-secret-scripts.sh && bash scripts/test-analysis-v2-infra-scripts.sh`

Expected: the new expectations fail because neither script currently models the fifth secret or Cloud Run ref.

### Task 2: Implement dedicated Secret Manager lifecycle

**Files:**
- Modify: `scripts/configure-analysis-v2-secrets.sh`
- Modify: `.env.example`

- [x] **Step 1: Add the dedicated identity, source key, pin, and rotation target**

Define only `GENDER_ROUTING_HMAC_SECRET_ID="ai-baram-v2-gender-routing-hmac"`; add `ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET` and `ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET_VERSION` to the documented lifecycle; and call the existing `process_secret` helper with the logical target `gender-routing-hmac`. Add an explicit `gender-routing-hmac` rotation target, never reuse an existing ID.

```bash
process_secret \
  gender-routing-hmac \
  "$GENDER_ROUTING_HMAC_SECRET_ID" \
  ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET \
  "${ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET_VERSION:-}" \
  ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET_VERSION
```

- [x] **Step 2: Strengthen the source value validator**

Treat the gender-routing HMAC exactly like the preflight identity HMAC: allow only base64/base64url text that decodes canonically to at least 32 bytes, reject whitespace/newlines/empty values, and retain streaming directly from the outside-source dotenv to stdin. Add the corresponding non-secret guidance and numeric pin placeholder to `.env.example`.

```javascript
if (key === "ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET"
  || key === "ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET") {
  // canonical base64/base64url and >= 32 decoded bytes
}
```

- [x] **Step 3: Run the lifecycle fixture to verify GREEN**

Run: `bash scripts/test-analysis-v2-secret-scripts.sh`

Expected: `Analysis V2 Secret Manager and manifest generator tests passed` and no fixture secret value in output.

### Task 3: Inject and verify the Cloud Run reference

**Files:**
- Modify: `scripts/deploy-analysis-v2-worker.sh`
- Modify: `scripts/test-analysis-v2-infra-scripts.sh`

- [x] **Step 1: Require and validate the new numeric deployment pin**

Add the secret ID constant, required environment-variable entry, readonly resolved version, and positive numeric validation. Append exactly one `--set-secrets` assignment for `ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET` using the dedicated ID and pin.

```bash
"--set-secrets=...,ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET=$GENDER_ROUTING_HMAC_SECRET_ID:$gender_routing_hmac_secret_version..."
```

- [x] **Step 2: Preserve revision invariants while permitting the initial safe addition**

Extend the runtime verifier and plaintext detector to require exactly one non-plaintext, canonical numeric gender-routing ref in the deployed template and serving revision. Before a deploy, allow only the pair state where both latest/active revisions have no such ref (initial rollout) or both have the exact same requested canonical ref; reject wrong IDs, duplicate refs, plaintext values, unpinned values, mismatched versions, and one-sided partial additions.

```jq
def gender_ref_state($secret; $version):
  [env[] | select(.name == "ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET")]
  as $entries
  | if ($entries | length) == 0 then "absent"
    elif ($entries | length) == 1
      and ($entries[0] | has("value") | not)
      and $entries[0].valueFrom.secretKeyRef.name == $secret
      and (($entries[0].valueFrom.secretKeyRef.key | tostring) == $version)
    then "exact" else error("invalid gender HMAC ref") end;
```

- [x] **Step 3: Run the deployment fixture to verify GREEN**

Run: `bash scripts/test-analysis-v2-infra-scripts.sh`

Expected: `Analysis V2 infrastructure script tests passed`, including each new fail-closed reference fixture and the first-addition dry run.

### Task 4: Document the operator rollout and validate the complete change

**Files:**
- Modify: `docs/analysis-v2-production-operations.md`
- Modify: `.env.example`
- Test: `scripts/test-analysis-v2-secret-scripts.sh`
- Test: `scripts/test-analysis-v2-infra-scripts.sh`

- [x] **Step 1: Add concise operations instructions**

Document the sequence: put a generated dedicated HMAC only in the outside-source dotenv, run the secret lifecycle command and record the emitted numeric pin, then run worker dry-run/apply/check with that exact pin. State that the ref is immutable in an existing service and that normal production/Plus requests do not consume it.

- [x] **Step 2: Run full targeted verification**

Run: `bash scripts/test-analysis-v2-secret-scripts.sh && bash scripts/test-analysis-v2-infra-scripts.sh && npm run lint && npm test -- scripts/deploy-analysis-v2-result-image-secrets-contract.test.ts`

Expected: both shell suites, lint, and the focused TypeScript contract test exit 0.

- [x] **Step 3: Inspect the patch and commit**

Run: `git diff --check && git status --short && git diff --stat`

Expected: only the dedicated secret lifecycle, worker wiring, tests, env example, and operations documentation are modified. Commit with `git commit -m "fix: wire gender routing HMAC rollout"`.
