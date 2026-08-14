import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ApifyClient } from 'apify-client';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    makeApifyProvider,
    parseApifyProfileDataset,
    parseApifyRelationshipDataset,
} from '@/lib/services/instagram/providers/apify';
import { createAnalysisV2SelectedMediaNormalizer } from '@/lib/services/ai/image-preprocessing';
import { AI_STAGE_POLICY_V211_VERSION } from '@/lib/services/ai/stage-policy';
import { createReplayStagedAiAdapter } from '@/lib/services/analysis/replay/replay-staged-ai-adapter';
import { captureAnalysisV2ReplayBundle } from '@/lib/services/analysis/replay/replay-capture';
import type { AnalysisV2ReplayBundle } from '@/lib/services/analysis/replay/replay-bundle';
import { FIRST_PAYMENT_BASIC_V211_CONCIERGE_CAPABILITY } from '@/lib/services/analysis/replay/replay-source-lineage';
import { runAnalysisV2AiReplay, type ReplayAccountAiDetail } from '@/lib/services/analysis/replay/replay-runner';
import {
    buildCanonicalConciergeResult,
    deriveConciergePrivacyPartition,
    validateCanonicalConciergeCorrection,
    type ConciergeTargetPostMentionEvidence,
    type ConciergeRelationshipEvidence,
} from '@/lib/services/analysis/concierge-basic-correction';
import { isAnalysisResultOperator, resolveAnalysisResultOwner } from '@/lib/services/analysis/result-operator-access';
import { requireActiveAccountClassification } from '@/lib/services/identity/account-principal-store';
import type { InstagramFollower, InstagramProfile } from '@/lib/types/instagram';

const SAMPLE_START = '2026-08-12T09:07:00.000Z';
const SAMPLE_END = '2026-08-12T09:08:00.000Z';
const RELATIONSHIP_LIMIT = 1_200;
const PROFILE_BATCH_SIZE = 30;
const PROFILE_HYDRATION_TARGET_COUNT = 19;
const CANONICAL_WORKDIR = '/private/tmp/fresh-admission-v3-supabase.yfdl1o';
const REVIEW_ARTIFACT_DIR = '/Users/youngminpark/orca/workspaces/ai-baram-detector/concierge-batch-delivery-20260814/output/manual-gender-review';
const ALL_PUBLIC_CLASSIFICATIONS_SHA256 = '47a657f1c534680043e24ca44f9e2eaa16854b55cd34ab65e3bb2a8dee7fa8cb';
const UNKNOWN_REVIEW_SHA256 = '1c66ac59cb97a18441c613178a77202f6a9501d22d5de85e561e0208a568e367';
const UNRESOLVED_PRIVATE_USERNAME = 'yan_e_0089';
const BASIC_SOURCE_LINEAGE = Object.freeze({
    selectedPlanId: 'basic',
    policyVersions: {
        pipeline: 'v2',
        aiStage: AI_STAGE_POLICY_V211_VERSION,
        risk: 'risk-policy-v2.5',
        scheduler: 'ai-scheduler-v1',
    },
} as const);
const conciergeEvaluationPolicy = Object.freeze({
    capability: FIRST_PAYMENT_BASIC_V211_CONCIERGE_CAPABILITY,
    aiStage: AI_STAGE_POLICY_V211_VERSION,
} as const);

const targetEvidenceRowSchema = z.object({
    actorUsername: z.string().trim().min(1).max(30),
    postId: z.string().min(1).max(255),
    signal: z.enum(['target_post_like', 'target_post_comment']),
    sourceInteractionId: z.string().min(1).max(255),
    occurredAt: z.string().datetime({ offset: true }).nullable().optional(),
    content: z.string().max(1_000).nullable().optional(),
}).strict();

type TargetEvidenceRow = z.infer<typeof targetEvidenceRowSchema>;
type ApifySlot = 'tertiary' | 'secondary' | 'primary';
type ProviderLineage = { slot: ApifySlot; runIds: string[] };
type FreshRelationship = {
    rows: readonly InstagramFollower[];
    uniqueCount: number;
    duplicateCount: number;
    lineage: ProviderLineage;
};

function normalizedUsername(value: string): string {
    return value.trim().replace(/^@/, '').toLowerCase();
}

function sha256(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function safeError(error: unknown): string {
    const message = error instanceof Error ? error.message : '';
    return /^([A-Z][A-Z0-9_]{2,119})/.exec(message)?.[1] ?? 'CONCIERGE_EXACT_CORRECTION_FAILED';
}

type ReviewedGender = 'male' | 'female' | 'unknown';

function readReviewedGenderArtifacts(): {
    classifications: ReadonlyMap<string, ReviewedGender>;
    allPublicHash: string;
    unknownReviewHash: string;
} {
    const allPublicPath = `${REVIEW_ARTIFACT_DIR}/all-public-classifications.csv`;
    const unknownPath = `${REVIEW_ARTIFACT_DIR}/unknown-review.csv`;
    const allPublicCsv = readFileSync(allPublicPath);
    const unknownCsv = readFileSync(unknownPath);
    const allPublicHash = createHash('sha256').update(allPublicCsv).digest('hex');
    const unknownReviewHash = createHash('sha256').update(unknownCsv).digest('hex');
    if (allPublicHash !== ALL_PUBLIC_CLASSIFICATIONS_SHA256
        || unknownReviewHash !== UNKNOWN_REVIEW_SHA256) {
        throw new Error('CONCIERGE_REVIEW_ARTIFACT_HASH_CONFLICT');
    }
    const parse = (csv: Buffer, hasManualGender: boolean): Array<[string, ReviewedGender]> => {
        const lines = csv.toString('utf8').trim().split(/\r?\n/);
        if (lines[0] !== 'username,instagram_url,ai_classification,ai_confidence/evidence_status,manual_gender,operator_note') {
            throw new Error('CONCIERGE_REVIEW_ARTIFACT_SCHEMA_CONFLICT');
        }
        return lines.slice(1).map(line => {
            const fields = line.split(',');
            const username = normalizedUsername(fields[0] ?? '');
            const aiClassification = fields[2];
            const manualGender = fields[4];
            if (!username || !['male', 'female', 'unknown'].includes(aiClassification ?? '')) {
                throw new Error('CONCIERGE_REVIEW_ARTIFACT_SCHEMA_CONFLICT');
            }
            const selected = hasManualGender ? manualGender : aiClassification;
            if (!['male', 'female', 'unknown'].includes(selected ?? '')) {
                throw new Error('CONCIERGE_REVIEW_ARTIFACT_SCHEMA_CONFLICT');
            }
            return [username, selected as ReviewedGender];
        });
    };
    const entries = parse(allPublicCsv, false);
    const unknownEntries = parse(unknownCsv, true);
    const classifications = new Map<string, ReviewedGender>();
    for (const [username, gender] of entries) {
        if (classifications.has(username)) throw new Error('CONCIERGE_REVIEW_ARTIFACT_DUPLICATE');
        classifications.set(username, gender);
    }
    for (const [username, gender] of unknownEntries) {
        if (classifications.get(username) !== 'unknown') {
            throw new Error('CONCIERGE_REVIEW_ARTIFACT_SCOPE_CONFLICT');
        }
        classifications.set(username, gender);
    }
    const counts = [...classifications.values()].reduce<Record<ReviewedGender, number>>(
        (acc, gender) => ({ ...acc, [gender]: acc[gender] + 1 }),
        { male: 0, female: 0, unknown: 0 },
    );
    if (classifications.size !== 53 || counts.female !== 16 || counts.male !== 31 || counts.unknown !== 6) {
        throw new Error('CONCIERGE_REVIEW_ARTIFACT_AGGREGATE_CONFLICT');
    }
    return { classifications, allPublicHash, unknownReviewHash };
}

function sqlString(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}

function checkpointProfile(profile: InstagramProfile) {
    const latestPosts = profile.latestPosts === undefined
        ? undefined
        : [...profile.latestPosts]
            .sort((left, right) => (
                Date.parse(right.timestamp) - Date.parse(left.timestamp)
                || left.id.localeCompare(right.id)
            ))
            .slice(0, 8);
    return {
        ...profile,
        ...(latestPosts === undefined ? {} : { latestPosts }),
    };
}

function isQuotaError(error: unknown): boolean {
    return error instanceof Error && error.message.includes('SCRAPING_PROVIDER_QUOTA_ERROR');
}

function tokenFor(slot: ApifySlot): string | null {
    return process.env[`APIFY_${slot.toUpperCase()}_API_TOKEN`]?.trim() || null;
}

function makeDirectProvider(slot: ApifySlot, token: string) {
    // The relationship adapter accepts only primary/secondary as its legacy static
    // definition, while the client itself is explicitly pinned to the selected token.
    // This keeps the incident's tertiary-first priority without changing production code.
    const adapterSlot = slot === 'secondary' ? 'secondary' : 'primary';
    const env = {
        APIFY_API_TOKEN_SLOT: adapterSlot,
        APIFY_API_TOKEN: token,
        APIFY_SECONDARY_API_TOKEN: token,
        APIFY_RELATIONSHIP_BUILD: '0.0.71',
    };
    return makeApifyProvider({
        env,
        client: new ApifyClient({ token, maxRetries: 0 }),
    });
}

type DurableProviderRun = {
    operation_key: string;
    run_id: string;
    status: string;
    logical_provider: string;
    credential_slot: string;
};

function durableProviderRuns(sourceRequestId: string, operationPrefix: string): DurableProviderRun[] {
    const sql = `SELECT operation_key, run_id, status, logical_provider, credential_slot
        FROM public.analysis_v2_provider_runs
        WHERE request_id = '${sourceRequestId.replaceAll("'", "''")}'::uuid
          AND operation_key LIKE '${operationPrefix.replaceAll("'", "''")}%'
        ORDER BY operation_key`;
    const output = execFileSync('supabase', [
        '--workdir', CANONICAL_WORKDIR, 'db', 'query', '--linked', '--agent=yes', '--output', 'json', sql,
    ], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
    const parsed = JSON.parse(output) as { rows?: unknown };
    if (!Array.isArray(parsed.rows)) throw new Error('CONCIERGE_PROVIDER_LEDGER_LOOKUP_FAILED');
    return parsed.rows.filter((row): row is DurableProviderRun => (
        Boolean(row) && typeof row === 'object'
        && typeof (row as DurableProviderRun).operation_key === 'string'
        && typeof (row as DurableProviderRun).run_id === 'string'
        && typeof (row as DurableProviderRun).status === 'string'
        && typeof (row as DurableProviderRun).logical_provider === 'string'
        && typeof (row as DurableProviderRun).credential_slot === 'string'
    ));
}

async function durableRelationshipSide(
    targetUsername: string,
    side: 'followers' | 'following',
    sourceRequestId: string,
): Promise<FreshRelationship | null> {
    const rows = durableProviderRuns(sourceRequestId, `relationship-${side}:`)
        .filter(row => row.status === 'succeeded'
            && row.logical_provider === 'apify'
            && row.credential_slot === 'tertiary'
            && row.run_id.trim());
    if (rows.length !== 1) return null;
    const [run] = rows;
    if (!run) return null;
    const token = tokenFor('tertiary');
    if (!token) throw new Error('CONCIERGE_APIFY_TOKEN_UNAVAILABLE');
    const info = await new ApifyClient({ token, maxRetries: 0 }).run(run.run_id).get();
    const datasetId = info?.defaultDatasetId;
    if (!datasetId) throw new Error('CONCIERGE_RELATIONSHIP_ARTIFACT_MISSING');
    const items = (await new ApifyClient({ token, maxRetries: 0 })
        .dataset(datasetId).listItems({ limit: RELATIONSHIP_LIMIT + 1 })).items;
    const parsed = parseApifyRelationshipDataset(
        items as Array<Record<string, unknown>>,
        targetUsername,
        side,
        RELATIONSHIP_LIMIT,
    );
    const seen = new Set<string>();
    let duplicateCount = 0;
    const normalizedRows = parsed.flatMap(row => {
        const username = normalizedUsername(row.username);
        if (!username || seen.has(username)) {
            duplicateCount++;
            return [];
        }
        seen.add(username);
        return [{ ...row, username }];
    });
    return {
        rows: Object.freeze(normalizedRows),
        uniqueCount: seen.size,
        duplicateCount,
        lineage: { slot: 'tertiary', runIds: [run.run_id] },
    };
}

async function collectRelationshipSide(
    targetUsername: string,
    side: 'followers' | 'following',
    sourceRequestId: string,
): Promise<FreshRelationship> {
    if (process.env.CONCIERGE_FORCE_FRESH_RELATIONSHIPS !== '1') {
        const durable = await durableRelationshipSide(targetUsername, side, sourceRequestId);
        if (durable) return durable;
    }
    const slots: ApifySlot[] = ['tertiary', 'secondary', 'primary'];
    let lastError: unknown;
    for (const slot of slots) {
        const token = tokenFor(slot);
        if (!token) continue;
        const runIds: string[] = [];
        try {
            const provider = makeDirectProvider(slot, token);
            const context = {
                credentialSlot: slot === 'secondary' ? 'secondary' as const : 'primary' as const,
                maxChargeUsd: 1.5,
                recordUsage: () => undefined,
                onRunStarted: (runId: string) => { runIds.push(runId); },
            };
            const rows = side === 'followers'
                ? await provider.getFollowers!(targetUsername, RELATIONSHIP_LIMIT, context)
                : await provider.getFollowing!(targetUsername, RELATIONSHIP_LIMIT, context);
            const seen = new Set<string>();
            let duplicateCount = 0;
            const normalizedRows = rows.flatMap(row => {
                const username = normalizedUsername(row.username);
                if (!username || seen.has(username)) {
                    duplicateCount++;
                    return [];
                }
                seen.add(username);
                return [{ ...row, username }];
            });
            return {
                rows: Object.freeze(normalizedRows),
                uniqueCount: seen.size,
                duplicateCount,
                lineage: { slot, runIds },
            };
        } catch (error) {
            lastError = error;
            if (!isQuotaError(error)) throw error;
        }
    }
    throw lastError instanceof Error ? lastError : new Error('CONCIERGE_APIFY_TOKEN_UNAVAILABLE');
}

async function hydrateExactMutualProfiles(
    usernames: readonly string[],
    publicUsernames: readonly string[],
    sourceRequestId: string,
): Promise<{ profiles: readonly InstagramProfile[]; unresolved: readonly string[]; lineage: ProviderLineage }> {
    const profiles = new Map<string, InstagramProfile>();
    const runIds: string[] = [];
    const durableRuns = durableProviderRuns(sourceRequestId, 'profile-fallback:')
        .filter(row => row.status === 'succeeded'
            && row.logical_provider === 'apify'
            && row.credential_slot === 'tertiary'
            && row.run_id.trim());
    const token = tokenFor('tertiary');
    if (!token) throw new Error('CONCIERGE_PROFILE_TOKEN_UNAVAILABLE');
    const client = new ApifyClient({ token, maxRetries: 0 });
    for (const durableRun of durableRuns) {
        const run = await client.run(durableRun.run_id).get();
        const datasetId = run?.defaultDatasetId;
        if (!datasetId) continue;
        const items = (await client.dataset(datasetId).listItems({ limit: PROFILE_BATCH_SIZE })).items;
        const requested = [...new Set(items
            .map(item => item && typeof item === 'object' && typeof item.username === 'string'
                ? normalizedUsername(item.username) : null)
            .filter((value): value is string => value !== null))];
        if (!requested.length) continue;
        const parsed = parseApifyProfileDataset(items, requested);
        for (const [username, profile] of parsed.profilesByUsername) profiles.set(username, profile);
        runIds.push(durableRun.run_id);
    }
    const missingPublic = publicUsernames.filter(username => !profiles.has(username));
    if (missingPublic.length > 0) {
        if (missingPublic.length !== PROFILE_HYDRATION_TARGET_COUNT) {
            throw new Error('CONCIERGE_PROFILE_ARTIFACT_SCOPE_CONFLICT');
        }
        const provider = makeDirectProvider('tertiary', token);
        const outcomes = await provider.getProfilesBatchOutcomes!(
            [...missingPublic], PROFILE_BATCH_SIZE, {
                credentialSlot: 'primary' as const,
                maxChargeUsd: 0.12,
                recordUsage: () => undefined,
                onRunStarted: (runId: string) => { runIds.push(runId); },
            },
        );
        for (const outcome of outcomes) {
            if (outcome.outcome.status === 'success' && 'profile' in outcome) {
                profiles.set(normalizedUsername(outcome.profile.username), outcome.profile);
            }
        }
    }
    const unresolved = publicUsernames.filter(username => !profiles.has(username));
    return {
        profiles: Object.freeze([...profiles.values()].filter(profile => publicUsernames.includes(normalizedUsername(profile.username)))),
        unresolved: Object.freeze(unresolved),
        lineage: { slot: 'tertiary', runIds },
    };
}

type ReviewedTargetSnapshot = {
    targetPosts: readonly ConciergeTargetPostMentionEvidence[];
    persistedTargetPosts: readonly Readonly<{
        id: string;
        taggedUsers: readonly string[];
        mentionedUsers: readonly string[];
    }>[];
    targetEvidence: readonly TargetEvidenceRow[];
    lineage: ProviderLineage;
    manifestHash: string;
};

/** Reads the already-frozen 95-row likes/comments manifest; no new interaction calls. */
async function loadReviewedTargetSnapshot(sourceRequestId: string): Promise<ReviewedTargetSnapshot> {
    const { data, error } = await supabaseAdmin.rpc('load_analysis_v2_target_evidence', {
        p_request_id: sourceRequestId,
        p_job_key: 'track:target-evidence:collect',
    });
    if (error || !data || !Array.isArray(data.rows) || data.rows.length !== 95
        || typeof data.manifest?.resultHash !== 'string') {
        throw new Error('CONCIERGE_TARGET_EVIDENCE_SNAPSHOT_INCOMPLETE');
    }
    const targetEvidence = parseReviewedTargetEvidence(data.rows);
    return {
        targetPosts: Object.freeze([]),
        persistedTargetPosts: Object.freeze([]),
        targetEvidence,
        lineage: { slot: 'tertiary', runIds: [] },
        manifestHash: data.manifest.resultHash,
    };
}

export function parseReviewedTargetEvidence(value: unknown): readonly TargetEvidenceRow[] {
    if (!Array.isArray(value)) {
        throw new Error('CONCIERGE_TARGET_EVIDENCE_UNAVAILABLE');
    }
    const parsed = z.array(targetEvidenceRowSchema).safeParse(value);
    if (!parsed.success || parsed.data.length !== 95) {
        throw new Error('CONCIERGE_TARGET_EVIDENCE_UNAVAILABLE');
    }
    return Object.freeze(parsed.data.map(row => Object.freeze(row)));
}

function relationshipEvidence(
    side: 'followers' | 'following',
    rows: readonly InstagramFollower[],
): ConciergeRelationshipEvidence[] {
    return rows.map((row, index) => ({
        username: normalizedUsername(row.username),
        side: side === 'followers' ? 'follower' : 'following',
        isPrivate: row.isPrivate,
        isVerified: row.isVerified,
        fullName: row.fullName ?? null,
        profilePicUrl: row.profilePicUrl ?? null,
        ordinal: index + 1,
    }));
}

type LegacyPublicationInput = {
    orderId: string;
    requestId: string;
    femaleRows: readonly unknown[];
    privateRows: readonly unknown[];
    counts: { male: number; female: number; unknown: number };
    mutualFollows: number;
    lineage: Record<string, unknown>;
    reviewedSource: {
        sourceRequestId: string;
        ownerId: string;
        targetUsername: string;
        resultRequestId: string;
        targetPosts: readonly unknown[];
        targetEvidence: readonly unknown[];
    };
};

function buildLegacyPublicationSql(input: LegacyPublicationInput): string {
    const sourceFingerprint = input.lineage.sourceFingerprint;
    if (typeof sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(sourceFingerprint)) {
        throw new Error('CONCIERGE_REVIEWED_SOURCE_FINGERPRINT_INVALID');
    }
    if (input.reviewedSource.resultRequestId !== input.requestId) {
        throw new Error('CONCIERGE_REVIEWED_SOURCE_SCOPE_CONFLICT');
    }
    const payloadSql = `${sqlString(JSON.stringify({ femaleRows: input.femaleRows, privateRows: input.privateRows }))}::jsonb`;
    const lineageSql = `${sqlString(JSON.stringify(input.lineage))}::jsonb`;
    const targetPostsSql = `${sqlString(JSON.stringify(input.reviewedSource.targetPosts))}::jsonb`;
    const targetEvidenceSql = `${sqlString(JSON.stringify(input.reviewedSource.targetEvidence))}::jsonb`;
    const sourceFingerprintSql = sqlString(sourceFingerprint);
    const resultHash = sha256({ schema: 'concierge-result-publication-v1', sourceFingerprint, femaleRows: input.femaleRows, privateRows: input.privateRows, counts: input.counts, mutualFollows: input.mutualFollows });
    const resultHashSql = sqlString(resultHash);
    const genderStatsSql = `${sqlString(JSON.stringify(input.counts))}::jsonb`;
    return `BEGIN;
SELECT pg_catalog.set_config('app.earlybird_v211_concierge_reviewed_source_register', '0', TRUE);
SELECT pg_catalog.set_config('app.earlybird_v211_concierge_publication_marker', '0', TRUE);
SELECT pg_catalog.set_config('app.earlybird_v211_concierge_publication_skip', '0', TRUE);
DO $guard$
DECLARE v_replay RECORD; v_order RECORD; v_request RECORD;
BEGIN
  SELECT * INTO v_order FROM public.earlybird_orders WHERE id = ${sqlString(input.orderId)}::uuid FOR UPDATE;
  SELECT * INTO v_request FROM public.analysis_requests WHERE id = ${sqlString(input.requestId)}::uuid FOR UPDATE;
  IF v_order.result_request_id IS DISTINCT FROM ${sqlString(input.requestId)}::uuid
     OR v_order.status IS DISTINCT FROM 'completed' OR v_order.plan_id IS DISTINCT FROM 'basic' THEN
    RAISE EXCEPTION 'CONCIERGE_ATOMIC_SCOPE_CONFLICT';
  END IF;
  IF v_request.status IS DISTINCT FROM 'completed' OR v_request.pipeline_version IS DISTINCT FROM 'v1' THEN
    RAISE EXCEPTION 'CONCIERGE_ATOMIC_REQUEST_SCOPE_CONFLICT';
  END IF;
  IF v_order.user_id IS DISTINCT FROM ${sqlString(input.reviewedSource.ownerId)}::uuid
     OR v_request.user_id IS DISTINCT FROM v_order.user_id
     OR lower(btrim(v_request.target_instagram_id)) IS DISTINCT FROM lower(btrim(v_order.target_instagram_id)) THEN
    RAISE EXCEPTION 'CONCIERGE_ATOMIC_IDENTITY_SCOPE_CONFLICT';
  END IF;
  IF COALESCE(((${lineageSql})->'relationship'->>'completenessProven')::boolean, FALSE) IS NOT TRUE THEN
    RAISE EXCEPTION 'CONCIERGE_RELATIONSHIP_SNAPSHOT_INCOMPLETE';
  END IF;
  SELECT * INTO v_replay FROM public.earlybird_v211_concierge_replays WHERE order_id = ${sqlString(input.orderId)}::uuid FOR UPDATE;
  IF v_replay.reviewed_source_fingerprint IS NOT NULL AND v_replay.reviewed_source_fingerprint <> ${sourceFingerprintSql} THEN
    RAISE EXCEPTION 'CONCIERGE_PUBLICATION_CAS_CONFLICT';
  END IF;
  IF v_replay.published_source_fingerprint IS NOT NULL THEN
    IF v_replay.published_source_fingerprint = ${sourceFingerprintSql} AND v_replay.published_result_hash = ${resultHashSql} THEN
      PERFORM pg_catalog.set_config('app.earlybird_v211_concierge_publication_skip', '1', TRUE);
    ELSE
      RAISE EXCEPTION 'CONCIERGE_PUBLICATION_CAS_CONFLICT';
    END IF;
  END IF;
END $guard$;
SELECT pg_catalog.set_config('app.earlybird_v211_concierge_reviewed_source_register', '1', TRUE);
SELECT public.register_earlybird_v211_concierge_reviewed_source(
  ${sqlString(input.orderId)}::uuid, ${sqlString(input.reviewedSource.sourceRequestId)}::uuid,
  ${sqlString(input.requestId)}::uuid, ${sqlString(input.reviewedSource.ownerId)}::uuid,
  ${sqlString(input.reviewedSource.targetUsername)}, ${sourceFingerprintSql},
  ${targetPostsSql}, ${targetEvidenceSql}
);
DO $publish$
DECLARE v_fingerprint text; v_hash text;
BEGIN
  IF pg_catalog.current_setting('app.earlybird_v211_concierge_publication_skip', TRUE) = '1' THEN RETURN; END IF;
  SELECT published_source_fingerprint, published_result_hash INTO v_fingerprint, v_hash
    FROM public.earlybird_v211_concierge_replays WHERE order_id = ${sqlString(input.orderId)}::uuid FOR UPDATE;
  IF v_fingerprint IS NOT NULL OR v_hash IS NOT NULL THEN RAISE EXCEPTION 'CONCIERGE_PUBLICATION_CAS_CONFLICT'; END IF;
  PERFORM pg_catalog.set_config('app.earlybird_v211_concierge_publication_marker', '1', TRUE);
  UPDATE public.earlybird_v211_concierge_replays SET published_source_fingerprint = ${sourceFingerprintSql}, published_result_hash = ${resultHashSql}, published_at = now() WHERE order_id = ${sqlString(input.orderId)}::uuid;
END $publish$;
DO $write$
BEGIN
  IF pg_catalog.current_setting('app.earlybird_v211_concierge_publication_skip', TRUE) = '1' THEN RETURN; END IF;
  DELETE FROM public.analysis_results WHERE request_id = ${sqlString(input.requestId)}::uuid;
  INSERT INTO public.analysis_results (request_id,rank,suspect_instagram_id,suspect_profile_image,suspect_full_name,bio,risk_score,photogenic_grade,exposure_level,is_tagged,risk_grade,gender_confidence,gender_status,is_unlocked,likes_count,intimate_comments_count,one_line_overview,risk_analysis)
  SELECT ${sqlString(input.requestId)}::uuid, rank, suspect_instagram_id, suspect_profile_image, suspect_full_name, bio, risk_score, photogenic_grade, exposure_level, is_tagged, risk_grade, gender_confidence, gender_status, is_unlocked, likes_count, intimate_comments_count, one_line_overview, risk_analysis
    FROM jsonb_to_recordset(${payloadSql}->'femaleRows') AS rows(rank integer,suspect_instagram_id text,suspect_profile_image text,suspect_full_name text,bio text,risk_score integer,photogenic_grade integer,exposure_level text,is_tagged boolean,risk_grade text,gender_confidence double precision,gender_status text,is_unlocked boolean,likes_count integer,intimate_comments_count integer,one_line_overview text,risk_analysis jsonb);
  UPDATE public.analysis_requests SET mutual_follows = ${input.mutualFollows}, opposite_gender_count = ${input.counts.female}, gender_stats = ${genderStatsSql}, step_data = jsonb_set(CASE WHEN jsonb_typeof(step_data)='object' THEN step_data ELSE '{}'::jsonb END, '{conciergeEvidence}', ${lineageSql}, TRUE), current_step='completed', completed_at=now() WHERE id = ${sqlString(input.requestId)}::uuid;
END $write$;
COMMIT;`;
}

type NewPublicationInput = {
    orderId: string;
    ownerId: string;
    sourceRequestId: string;
    firstRelationshipRequestId: string;
    secondRelationshipRequestId: string;
    failedPreflightId: string;
    rearmedPreflightId: string;
    requestId: string;
    targetUsername: string;
    counts: { male: number; female: number; unknown: number };
    mutualFollows: number;
    hydration: { exactMutual: number; hydrated: number; public: number; private: number; unresolved: number };
    sourceFingerprint: string;
    targetEvidenceManifest: string;
    artifactHashes: Record<string, string>;
    followers: readonly unknown[];
    following: readonly unknown[];
    targetEvidence: readonly unknown[];
    femaleRows: readonly unknown[];
    privateRows: readonly unknown[];
    unresolvedUsernames: readonly string[];
};

export function buildAtomicPublicationSql(input: LegacyPublicationInput): string;
export function buildAtomicPublicationSql(input: NewPublicationInput): string;
export function buildAtomicPublicationSql(input: LegacyPublicationInput | NewPublicationInput): string {
    if ('lineage' in input) return buildLegacyPublicationSql(input);
    if (!/^[a-f0-9]{64}$/.test(input.sourceFingerprint)) {
        throw new Error('CONCIERGE_REVIEWED_SOURCE_FINGERPRINT_INVALID');
    }
    const resultHash = sha256({
        schema: 'concierge-result-publication-v1',
        sourceFingerprint: input.sourceFingerprint,
        femaleRows: input.femaleRows,
        privateRows: input.privateRows,
        counts: input.counts,
        mutualFollows: input.mutualFollows,
    });
    const artifactHashes = {
        ...input.artifactHashes,
        sourceFingerprint: input.sourceFingerprint,
        resultHash,
        targetEvidenceManifest: input.targetEvidenceManifest,
    };
    const publicationPayload = {
        sourceFingerprint: input.sourceFingerprint,
        resultHash,
        publicGender: input.counts,
        femaleRows: input.femaleRows,
        privateRows: input.privateRows,
        unresolvedUsernames: input.unresolvedUsernames,
    };
    const args = [
        `${sqlString(input.orderId)}::uuid`, `${sqlString(input.ownerId)}::uuid`,
        `${sqlString(input.sourceRequestId)}::uuid`, `${sqlString(input.firstRelationshipRequestId)}::uuid`,
        `${sqlString(input.secondRelationshipRequestId)}::uuid`, `${sqlString(input.failedPreflightId)}::uuid`,
        `${sqlString(input.rearmedPreflightId)}::uuid`, `${sqlString(input.requestId)}::uuid`,
        sqlString(input.targetUsername), sqlString('analysis_in_progress'), '2::smallint',
        `${input.hydration.exactMutual}::integer`, `${input.hydration.hydrated}::integer`,
        `${input.hydration.public}::integer`, `${input.hydration.private}::integer`,
        `${input.hydration.unresolved}::integer`, sqlString(input.sourceFingerprint),
        sqlString(resultHash), `${sqlString(JSON.stringify(artifactHashes))}::jsonb`,
        `${sqlString(JSON.stringify(input.followers))}::jsonb`,
        `${sqlString(JSON.stringify(input.following))}::jsonb`,
        `${sqlString(JSON.stringify(input.targetEvidence))}::jsonb`,
        `${sqlString(JSON.stringify(publicationPayload))}::jsonb`,
    ];
    return `BEGIN;
SELECT public.bootstrap_earlybird_v211_concierge_first_order(${args.join(',')}) AS result;
COMMIT;`;
}

function applyAtomicPublication(input: Parameters<typeof buildAtomicPublicationSql>[0]): void {
    execFileSync('supabase', [
        '--workdir', CANONICAL_WORKDIR, 'db', 'query', '--linked', '--agent=yes', '--output', 'json',
        buildAtomicPublicationSql(input),
    ], { stdio: 'pipe', encoding: 'utf8' });
}

async function verifyAuthorization(order: { userId: string }, requestId: string): Promise<void> {
    const owner = await resolveAnalysisResultOwner(requestId, 'v1');
    if (owner !== order.userId) throw new Error('CONCIERGE_BUYER_OWNER_AUTHORIZATION_FAILED');
    await requireActiveAccountClassification(order.userId);
    const users = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1_000 });
    const admin = users.data.users.find(user => user.email?.trim().toLowerCase() === 'ym1113@kakao.com');
    if (!admin || !isAnalysisResultOperator({ id: admin.id, email: admin.email })) {
        throw new Error('CONCIERGE_ADMIN_ALLOWLIST_AUTHORIZATION_FAILED');
    }
    await requireActiveAccountClassification(admin.id);
}

async function main(): Promise<void> {
    const startedAt = Date.now();
    const { data: orders, error: orderError } = await supabaseAdmin
        .from('earlybird_orders')
        .select('id,user_id,preflight_id,target_instagram_id,target_followers_count,target_following_count,result_request_id,status,plan_id,paid_at')
        .eq('plan_id', 'basic').gte('paid_at', SAMPLE_START).lt('paid_at', SAMPLE_END);
    if (orderError || !orders || orders.length !== 1) throw new Error('CONCIERGE_SAMPLE_ORDER_SCOPE_CONFLICT');
    const order = orders[0]!;
    if (order.status !== 'completed' || typeof order.result_request_id !== 'string' || typeof order.target_instagram_id !== 'string') {
        throw new Error('CONCIERGE_SAMPLE_ORDER_NOT_READY');
    }
    const { data: requests, error: requestError } = await supabaseAdmin
        .from('analysis_requests')
        .select('id,user_id,target_instagram_id,status,pipeline_version,preflight_id')
        .eq('user_id', order.user_id);
    if (requestError || !requests) throw new Error('CONCIERGE_SAMPLE_REQUEST_LOOKUP_FAILED');
    const request = requests.find(row => row.id === order.result_request_id);
    const sourceCandidates = requests.filter(candidate => (
        candidate.id !== order.result_request_id
        && candidate.user_id === order.user_id
        && normalizedUsername(candidate.target_instagram_id) === normalizedUsername(order.target_instagram_id)
        && candidate.pipeline_version === 'v2'
        && candidate.status === 'failed'
    ));
    const sourceRequest = sourceCandidates.length === 1 ? sourceCandidates[0] : null;
    if (!request || !sourceRequest || !sourceRequest.preflight_id) {
        throw new Error('CONCIERGE_SAMPLE_REQUEST_SCOPE_CONFLICT');
    }
    if (request.status !== 'completed' || request.pipeline_version !== 'v1') {
        throw new Error('CONCIERGE_SAMPLE_REQUEST_SCOPE_CONFLICT');
    }
    const reviewedArtifacts = readReviewedGenderArtifacts();
    const targetSnapshot = await loadReviewedTargetSnapshot(sourceRequest.id);
    const targetPosts = targetSnapshot.targetPosts;
    const targetEvidence = targetSnapshot.targetEvidence;
    const followers = await collectRelationshipSide(order.target_instagram_id, 'followers', sourceRequest.id);
    const following = await collectRelationshipSide(order.target_instagram_id, 'following', sourceRequest.id);
    const followerNames = followers.rows.map(row => normalizedUsername(row.username));
    const followingNames = following.rows.map(row => normalizedUsername(row.username));
    const followerSet = new Set(followerNames);
    const orderedMutualUsernames = followingNames.filter(username => followerSet.has(username));
    if (new Set(orderedMutualUsernames).size !== orderedMutualUsernames.length) {
        throw new Error('CONCIERGE_MUTUAL_IDENTITY_CONFLICT');
    }
    const exactMutualCount = orderedMutualUsernames.length;
    if (exactMutualCount !== 149 || followers.rows.length !== 157 || following.rows.length !== 361) {
        if (process.env.CONCIERGE_RELATIONSHIP_ONLY === '1') {
            console.log(JSON.stringify({
                state: 'relationship_only', followers: followers.rows.length,
                following: following.rows.length, exactMutual: exactMutualCount,
            }));
            return;
        }
        throw new Error('CONCIERGE_RELATIONSHIP_SNAPSHOT_INCOMPLETE');
    }
    if (process.env.CONCIERGE_RELATIONSHIP_ONLY === '1') {
        console.log(JSON.stringify({
            state: 'relationship_only', followers: followers.rows.length,
            following: following.rows.length, exactMutual: exactMutualCount,
        }));
        return;
    }
    const publicUsernames = [...reviewedArtifacts.classifications.keys()]
        .filter(username => orderedMutualUsernames.includes(username));
    if (publicUsernames.length !== 53) throw new Error('CONCIERGE_REVIEW_ARTIFACT_SCOPE_CONFLICT');
    const hydration = await hydrateExactMutualProfiles(publicUsernames, publicUsernames, sourceRequest.id);
    const { data: rawPrivateRows, error: privateError } = await supabaseAdmin
        .from('private_accounts')
        .select('instagram_id,profile_image,full_name')
        .eq('request_id', order.result_request_id);
    if (privateError || !rawPrivateRows || rawPrivateRows.length !== 96) {
        throw new Error('CONCIERGE_PRIVATE_PROFILE_ARTIFACT_MISSING');
    }
    const excludedPrivateRows = rawPrivateRows.filter(row => normalizedUsername(row.instagram_id) === UNRESOLVED_PRIVATE_USERNAME);
    const privateRows = rawPrivateRows.filter(row => normalizedUsername(row.instagram_id) !== UNRESOLVED_PRIVATE_USERNAME);
    if (excludedPrivateRows.length !== 1 || privateRows.length !== 95) {
        throw new Error('CONCIERGE_PRIVATE_PROFILE_ARTIFACT_MISSING');
    }
    const privateProfiles: InstagramProfile[] = privateRows.map(row => ({
        username: normalizedUsername(row.instagram_id),
        fullName: row.full_name ?? undefined,
        profilePicUrl: row.profile_image ?? undefined,
        followersCount: 0,
        followingCount: 0,
        postsCount: 0,
        isPrivate: true,
        isVerified: false,
    }));
    const allProfiles = [...hydration.profiles, ...privateProfiles];
    const relationshipRows = [
        ...relationshipEvidence('followers', followers.rows),
        ...relationshipEvidence('following', following.rows),
    ];
    const partition = deriveConciergePrivacyPartition({
        profiles: allProfiles,
        relationshipRows,
        requireExactMutual: true,
    });
    if (hydration.unresolved.length !== 0
        || partition.unresolvedUsernames.length !== 1
        || partition.unresolvedUsernames[0] !== UNRESOLVED_PRIVATE_USERNAME) {
        throw new Error('CONCIERGE_UNRESOLVED_RECONCILIATION_FAILED');
    }
    if (partition.profiles.length !== 148 || partition.publicProfiles.length !== 53
        || partition.privateProfiles.length !== 95 || partition.unresolvedUsernames.length !== 1) {
        throw new Error('CONCIERGE_PROFILE_ARTIFACT_MISSING');
    }
    const sourceFingerprint = sha256({
        sourceRequest: sourceRequest.id,
        failedPreflight: sourceRequest.preflight_id,
        ownerId: order.user_id,
        orderId: order.id,
        resultRequestId: order.result_request_id,
        targetUsername: normalizedUsername(order.target_instagram_id),
        relationship: {
            followers: followers.rows,
            following: following.rows,
            followerLineage: followers.lineage,
            followingLineage: following.lineage,
        },
        profiles: allProfiles.map(profile => ({
            username: normalizedUsername(profile.username), isPrivate: profile.isPrivate,
            posts: profile.latestPosts?.map(post => post.id) ?? [],
        })),
        unresolvedUsernames: partition.unresolvedUsernames,
        targetPosts: targetSnapshot.persistedTargetPosts,
        targetEvidence,
        targetEvidenceManifest: targetSnapshot.manifestHash,
        targetProviderLineage: targetSnapshot.lineage,
        reviewedGenderArtifacts: {
            allPublicHash: reviewedArtifacts.allPublicHash,
            unknownReviewHash: reviewedArtifacts.unknownReviewHash,
            classifications: [...reviewedArtifacts.classifications.entries()],
        },
    });
    const profileByUsername = new Map(allProfiles.map(profile => [normalizedUsername(profile.username), profile]));
    const replayProfiles = orderedMutualUsernames
        .filter(username => profileByUsername.has(username))
        .map(username => checkpointProfile(profileByUsername.get(username)!));
    const sourceEvidence: AnalysisV2ReplayBundle['evidence'] = {
        relationship: relationshipRows.map(row => ({
            username: row.username, side: row.side, isPrivate: row.isPrivate,
            isVerified: row.isVerified, fullName: row.fullName, ordinal: row.ordinal,
        })),
        targetInteractions: targetEvidence.map(row => ({
            actorUsername: normalizedUsername(row.actorUsername), postId: row.postId,
            signal: row.signal, sourceInteractionId: row.sourceInteractionId,
            occurredAt: row.occurredAt ?? null, content: row.content ?? null,
        })),
        reverseInteractions: [],
    };
    const bundle = await captureAnalysisV2ReplayBundle({
        selector: { targetUsername: order.target_instagram_id },
        repository: {
            async findCompletedReplaySourceExact() {
                return { requestFingerprint: sourceFingerprint, sourceLineage: BASIC_SOURCE_LINEAGE, completed: true };
            },
            async loadReplaySource() {
                return { profiles: replayProfiles, evidence: sourceEvidence, providerRuns: [] };
            },
        },
        normalizeMedia: createAnalysisV2SelectedMediaNormalizer(),
        evaluationPolicy: conciergeEvaluationPolicy,
    });
    const details = new Map<number, ReplayAccountAiDetail>();
    await runAnalysisV2AiReplay({
        bundle, runner: createReplayStagedAiAdapter(AI_STAGE_POLICY_V211_VERSION), mode: 'paid-ai',
        paidAiOptIn: true, evaluationPolicy: conciergeEvaluationPolicy,
        onAccountAnalyzed(detail) { details.set(detail.ordinal, detail); },
    });
    const profilesByOrdinal = new Map(bundle.profiles.map(profile => [
        profile.ordinal,
        profileByUsername.get(normalizedUsername(profile.username))!,
    ]));
    const targetInteractions = targetEvidence.map(row => ({
        actorUsername: normalizedUsername(row.actorUsername), postId: row.postId,
        signal: row.signal, sourceInteractionId: row.sourceInteractionId,
        ...(row.occurredAt ? { occurredAt: row.occurredAt } : {}),
        ...(row.content ? { content: row.content } : {}),
    }));
    const reviewedDetails = [...details.values()].map(detail => {
        const profile = profilesByOrdinal.get(detail.ordinal);
        const username = profile ? normalizedUsername(profile.username) : null;
        const reviewedGender = username ? reviewedArtifacts.classifications.get(username) : undefined;
        if (!reviewedGender) throw new Error('CONCIERGE_REVIEW_ARTIFACT_SCOPE_CONFLICT');
        if (reviewedGender === 'female' && !detail.feature) {
            throw new Error('CONCIERGE_REVIEWED_FEMALE_FEATURE_MISSING');
        }
        return {
            ...detail,
            finalClassification: reviewedGender === 'female'
                ? 'verified_female' as const
                : reviewedGender === 'male'
                    ? 'verified_non_female' as const
                    : 'unresolved' as const,
            classificationSource: reviewedGender === 'unknown' ? 'unknown' as const : 'feature' as const,
        };
    });
    const result = buildCanonicalConciergeResult({
        targetUsername: order.target_instagram_id,
        profilesByOrdinal,
        details: reviewedDetails,
        orderedMutualUsernames,
        targetInteractions,
        targetPosts,
        privateProfiles: partition.privateProfiles,
    });
    validateCanonicalConciergeCorrection({
        fetchedCount: exactMutualCount,
        partition,
        result,
    });
    if (result.femaleRows.length === 0) {
        throw new Error('CONCIERGE_NO_CANONICAL_RANKED_RESULT');
    }
    if (result.counts.male !== 31 || result.counts.female !== 16 || result.counts.unknown !== 6) {
        throw new Error('CONCIERGE_PUBLIC_GENDER_REPORT_RECONCILIATION_FAILED');
    }
    const currentOrder = await supabaseAdmin.from('earlybird_orders')
        .select('id,result_request_id,status,plan_id,paid_at').eq('id', order.id).maybeSingle();
    if (currentOrder.error || !currentOrder.data || currentOrder.data.result_request_id !== order.result_request_id
        || currentOrder.data.status !== 'completed' || currentOrder.data.plan_id !== 'basic') {
        throw new Error('CONCIERGE_PUBLICATION_SCOPE_CHANGED');
    }
    const beforeRows = await supabaseAdmin.from('analysis_results').select('rank').eq('request_id', order.result_request_id);
    const beforePrivate = await supabaseAdmin.from('private_accounts').select('instagram_id').eq('request_id', order.result_request_id);
    const completenessProven = followers.rows.length === 157 && following.rows.length === 361;
    if (!completenessProven) {
        throw new Error('CONCIERGE_RELATIONSHIP_SNAPSHOT_INCOMPLETE');
    }
    await verifyAuthorization({ userId: order.user_id }, order.result_request_id);
    if (process.env.CONCIERGE_DRY_RUN === '1') {
        console.log(JSON.stringify({
            state: 'dry_run_ready',
            followers: followers.rows.length,
            following: following.rows.length,
            exactMutual: exactMutualCount,
            hydrated: partition.profiles.length,
            public: partition.publicProfiles.length,
            private: partition.privateProfiles.length,
            unresolved: partition.unresolvedUsernames.length,
            targetEvidence: targetEvidence.length,
            publicGender: result.counts,
            rankedCandidates: result.femaleRows.length,
        }));
        return;
    }
    applyAtomicPublication({
        orderId: order.id, ownerId: order.user_id,
        sourceRequestId: sourceRequest.id,
        firstRelationshipRequestId: sourceRequest.id,
        secondRelationshipRequestId: sourceRequest.id,
        failedPreflightId: sourceRequest.preflight_id,
        rearmedPreflightId: order.preflight_id,
        requestId: order.result_request_id,
        targetUsername: order.target_instagram_id,
        counts: { male: result.counts.male, female: result.counts.female, unknown: result.counts.unknown },
        mutualFollows: exactMutualCount,
        hydration: {
            exactMutual: exactMutualCount,
            hydrated: partition.profiles.length,
            public: partition.publicProfiles.length,
            private: partition.privateProfiles.length,
            unresolved: partition.unresolvedUsernames.length,
        },
        sourceFingerprint,
        targetEvidenceManifest: targetSnapshot.manifestHash,
        artifactHashes: {
            allPublicClassifications: reviewedArtifacts.allPublicHash,
            unknownReviewCsv: reviewedArtifacts.unknownReviewHash,
        },
        followers: followers.rows,
        following: following.rows,
        targetEvidence,
        femaleRows: result.femaleRows,
        privateRows: result.privateRows,
        unresolvedUsernames: partition.unresolvedUsernames,
    });
    const [afterRequest, afterResults, afterPrivate] = await Promise.all([
        supabaseAdmin.from('analysis_requests').select('status,progress,gender_stats,pipeline_version').eq('id', order.result_request_id).maybeSingle(),
        supabaseAdmin.from('analysis_results').select('rank,risk_score,risk_grade,one_line_overview,risk_analysis,gender_status').eq('request_id', order.result_request_id).order('rank'),
        supabaseAdmin.from('private_accounts').select('instagram_id').eq('request_id', order.result_request_id),
    ]);
    if (afterRequest.error || !afterRequest.data || afterRequest.data.status !== 'completed'
        || afterRequest.data.progress !== 100 || afterRequest.data.pipeline_version !== 'v1'
        || afterResults.error || !afterResults.data || afterResults.data.length !== result.femaleRows.length
        || afterResults.data.some(row => row.risk_score === null || row.risk_grade === null
            || row.gender_status !== 'confirmed'
            || typeof row.one_line_overview !== 'string'
            || row.one_line_overview.length === 0 || row.one_line_overview.length > 180)
        || afterPrivate.error || !afterPrivate.data || afterPrivate.data.length !== result.privateRows.length) {
        throw new Error('CONCIERGE_PUBLICATION_VERIFY_FAILED');
    }
    const highRiskRows = afterResults.data.filter(row => row.risk_grade === 'high_risk');
    if (highRiskRows.some(row => !Array.isArray(row.risk_analysis) || row.risk_analysis.length !== 2)) {
        throw new Error('CONCIERGE_PUBLICATION_NARRATIVE_VERIFY_FAILED');
    }
    const overviewRows = afterResults.data.filter(row => row.risk_grade !== 'high_risk');
    if (overviewRows.some(row => typeof row.one_line_overview !== 'string'
        || row.one_line_overview.length === 0 || row.one_line_overview.length > 180)) {
        throw new Error('CONCIERGE_PUBLICATION_OVERVIEW_VERIFY_FAILED');
    }
    const genderStats = afterRequest.data.gender_stats as Record<string, number> | null;
    if (!genderStats
        || genderStats.male !== result.counts.male
        || genderStats.female !== result.counts.female
        || genderStats.unknown !== result.counts.unknown
        || genderStats.male + genderStats.female + genderStats.unknown !== partition.publicProfiles.length) {
        throw new Error('CONCIERGE_PUBLIC_GENDER_STATS_VERIFY_FAILED');
    }
    console.log(JSON.stringify({
        state: 'completed',
        before: { resultRows: beforeRows.data?.length ?? 0, privateRows: beforePrivate.data?.length ?? 0 },
        after: {
            followerSnapshot: order.target_followers_count, followingSnapshot: order.target_following_count,
            followersCollected: followers.rows.length, followingCollected: following.rows.length,
            followersUnique: followers.uniqueCount, followingUnique: following.uniqueCount,
            exactIntersection: exactMutualCount, hydrated: partition.profiles.length,
            public: partition.publicProfiles.length, private: partition.privateProfiles.length,
            unresolved: partition.unresolvedUsernames.length,
            publicGender: { male: result.counts.male, female: result.counts.female, unknown: result.counts.unknown },
            resultRows: result.femaleRows.length, highRiskRows: highRiskRows.length,
        },
        authorization: { buyerOwner: true, configuredAdminAllowlist: true },
        elapsedSeconds: Number(((Date.now() - startedAt) / 1_000).toFixed(1)),
    }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main().catch(error => {
        console.error(JSON.stringify({ state: 'failed', code: safeError(error) }));
        process.exitCode = 1;
    });
}
