import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    attributedApifyProfileUsername,
    attributedProfileActorErrorUsername,
    parseApifyProfileDataset,
    parseApifyRelationshipDataset,
} from '@/lib/services/instagram/providers/apify';
import { createReplayReadonlyApifyClient } from '@/lib/services/analysis/replay/replay-live-source';
import { createAnalysisV2SelectedMediaNormalizer } from '@/lib/services/ai/image-preprocessing';
import { AI_STAGE_POLICY_V211_VERSION } from '@/lib/services/ai/stage-policy';
import {
    createReplayStagedAiAdapter,
} from '@/lib/services/analysis/replay/replay-staged-ai-adapter';
import { captureAnalysisV2ReplayBundle } from '@/lib/services/analysis/replay/replay-capture';
import {
    analysisV2ReplaySemanticInputFingerprint,
    type AnalysisV2ReplayBundle,
} from '@/lib/services/analysis/replay/replay-bundle';
import {
    FIRST_PAYMENT_BASIC_V211_CONCIERGE_CAPABILITY,
} from '@/lib/services/analysis/replay/replay-source-lineage';
import {
    runAnalysisV2AiReplay,
    type ReplayAccountAiDetail,
} from '@/lib/services/analysis/replay/replay-runner';
import {
    analysisV2CheckpointProfileSchema,
} from '@/lib/services/analysis/v2-profile-fetch-store';
import {
    buildCanonicalConciergeResult,
    deriveConciergePrivacyPartition,
    validateCanonicalConciergeCorrection,
    type ConciergeRelationshipEvidence,
} from '@/lib/services/analysis/concierge-basic-correction';
import type { InstagramProfile } from '@/lib/types/instagram';

const SAMPLE_START = '2026-08-12T09:07:00.000Z';
const SAMPLE_END = '2026-08-12T09:08:00.000Z';
const CANONICAL_WORKDIR = '/Users/youngminpark/Desktop/개발/ai baram detector/ai-baram-detector/.worktrees/final-main-20260725';
const BASIC_SOURCE_LINEAGE = Object.freeze({
    selectedPlanId: 'basic',
    policyVersions: {
        pipeline: 'v2',
        aiStage: AI_STAGE_POLICY_V211_VERSION,
        risk: 'risk-policy-v2.5',
        scheduler: 'ai-scheduler-v1',
    },
} as const);

const targetEvidenceRowSchema = z.object({
    actorUsername: z.string().trim().min(1).max(30),
    postId: z.string().min(1).max(255),
    signal: z.enum(['target_post_like', 'target_post_comment']),
    sourceInteractionId: z.string().min(1).max(255),
    occurredAt: z.string().datetime({ offset: true }).nullable().optional(),
    content: z.string().max(1_000).nullable().optional(),
}).strict();

const providerRunSchema = z.object({
    actor_id: z.string().min(3),
    credential_slot: z.string().min(3),
    run_id: z.string().min(8),
    operation_key: z.string().min(1),
    status: z.literal('succeeded'),
    job_key: z.string().min(1),
}).strict();

type ProviderRun = z.infer<typeof providerRunSchema>;

const conciergeEvaluationPolicy = Object.freeze({
    capability: FIRST_PAYMENT_BASIC_V211_CONCIERGE_CAPABILITY,
    aiStage: AI_STAGE_POLICY_V211_VERSION,
} as const);

function checkpointProfile(profile: InstagramProfile) {
    const latestPosts = profile.latestPosts === undefined
        ? undefined
        : [...profile.latestPosts]
            .sort((left, right) => (
                Date.parse(right.timestamp) - Date.parse(left.timestamp)
                || left.id.localeCompare(right.id)
            ))
            .slice(0, 8);
    return analysisV2CheckpointProfileSchema.parse({
        ...profile,
        ...(latestPosts === undefined ? {} : { latestPosts }),
    });
}

function sha256(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function safeError(error: unknown): string {
    const message = error instanceof Error ? error.message : '';
    return /^([A-Z][A-Z0-9_]{2,119})/.exec(message)?.[1]
        ?? 'CONCIERGE_CORRECTION_FAILED';
}

function sqlString(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}

async function readDataset(
    client: ReturnType<typeof createReplayReadonlyApifyClient>,
    run: ProviderRun,
): Promise<readonly unknown[]> {
    const remote = await client.run(run.run_id).get();
    const expectedActorId = await client.resolveActorId(run.actor_id);
    if (
        remote?.id !== run.run_id
        || remote.actId !== expectedActorId
        || remote.status !== 'SUCCEEDED'
        || !remote.defaultDatasetId
    ) {
        throw new Error('CONCIERGE_EXISTING_PROVIDER_EVIDENCE_NOT_TERMINAL');
    }
    const result: unknown[] = [];
    let offset = 0;
    let total = 0;
    do {
        const page = await client.dataset(remote.defaultDatasetId).listItems({
            offset,
            limit: 1_000,
        });
        if (page.offset !== offset || page.count !== page.items.length || page.total < 0) {
            throw new Error('CONCIERGE_EXISTING_PROVIDER_DATASET_INVALID');
        }
        total = page.total;
        result.push(...page.items);
        offset += page.count;
    } while (offset < total);
    if (result.length !== total) throw new Error('CONCIERGE_EXISTING_PROVIDER_DATASET_INCOMPLETE');
    return Object.freeze(result);
}

async function loadProviderEvidence(input: {
    runs: readonly ProviderRun[];
    targetUsername: string;
}) {
    const token = process.env.APIFY_TERTIARY_API_TOKEN?.trim();
    if (!token) throw new Error('CONCIERGE_EXISTING_PROVIDER_TOKEN_MISSING');
    const client = createReplayReadonlyApifyClient(token);
    const datasets = new Map<ProviderRun, readonly unknown[]>();
    for (const run of input.runs) datasets.set(run, await readDataset(client, run));

    const profileRuns = input.runs.filter(run => run.job_key.startsWith('manual:concierge:profiles:'));
    if (profileRuns.length !== 3) throw new Error('CONCIERGE_PROFILE_RUN_SCOPE_CONFLICT');
    const profiles = new Map<string, InstagramProfile>();
    const failedProfileUsernames = new Set<string>();
    for (const run of profileRuns) {
        const items = datasets.get(run)!;
        const usernames = [...new Set(items.flatMap(item => {
            const username = attributedApifyProfileUsername(item)
                ?? attributedProfileActorErrorUsername(item);
            return username ? [username.toLowerCase()] : [];
        }))];
        const parsed = parseApifyProfileDataset(items, usernames);
        if (parsed.datasetContaminated || parsed.notFoundUsernames.size > 0) {
            throw new Error('CONCIERGE_PROFILE_DATASET_SCOPE_CONFLICT');
        }
        for (const [username, failure] of parsed.failuresByUsername) {
            if (!failure.message.startsWith('SCRAPING_INCOMPLETE_ERROR:')) {
                throw new Error('CONCIERGE_PROFILE_DATASET_SCOPE_CONFLICT');
            }
            failedProfileUsernames.add(username);
        }
        for (const [username, profile] of parsed.profilesByUsername) {
            if (profiles.has(username)) throw new Error('CONCIERGE_PROFILE_IDENTITY_CONFLICT');
            profiles.set(username, profile);
        }
    }
    for (const username of failedProfileUsernames) {
        if (profiles.has(username)) throw new Error('CONCIERGE_PROFILE_IDENTITY_CONFLICT');
    }
    if (profiles.size !== 79) throw new Error('CONCIERGE_PROFILE_COUNT_RECONCILIATION_FAILED');

    const relationshipRows: ConciergeRelationshipEvidence[] = [];
    for (const run of input.runs.filter(run => run.operation_key.startsWith('relationship-'))) {
        const side = run.operation_key.startsWith('relationship-followers')
            ? 'followers' as const
            : 'following' as const;
        const parsed = parseApifyRelationshipDataset(
            datasets.get(run)!.map(item => z.record(z.string(), z.unknown()).parse(item)),
            input.targetUsername,
            side,
            1_200,
        );
        relationshipRows.push(...parsed.map((row, index) => ({
            username: row.username,
            side: side === 'followers' ? 'follower' as const : 'following' as const,
            isPrivate: row.isPrivate,
            isVerified: row.isVerified,
            fullName: row.fullName ?? null,
            profilePicUrl: row.profilePicUrl ?? null,
            ordinal: index + 1,
        })));
    }
    if (
        !relationshipRows.some(row => row.side === 'follower')
        || !relationshipRows.some(row => row.side === 'following')
    ) throw new Error('CONCIERGE_RELATIONSHIP_EVIDENCE_MISSING');

    return {
        profiles: Object.freeze([...profiles.values()]),
        relationshipRows: Object.freeze(relationshipRows),
        datasets,
    };
}

function buildAtomicPublicationSql(input: {
    orderId: string;
    requestId: string;
    targetUsername: string;
    femaleRows: readonly unknown[];
    privateRows: readonly unknown[];
    counts: { male: number; female: number; unknown: number };
}): string {
    const payload = JSON.stringify({
        femaleRows: input.femaleRows,
        privateRows: input.privateRows,
    });
    const requestId = sqlString(input.requestId);
    const orderId = sqlString(input.orderId);
    const payloadSql = `${sqlString(payload)}::jsonb`;
    const genderStats = sqlString(JSON.stringify(input.counts)) + '::jsonb';
    return `BEGIN;
DO $guard$
DECLARE
  v_pointer uuid;
  v_order_status text;
  v_plan_id text;
  v_paid_at timestamptz;
  v_request_status text;
  v_pipeline_version text;
BEGIN
  SELECT result_request_id, status, plan_id, paid_at
    INTO v_pointer, v_order_status, v_plan_id, v_paid_at
    FROM public.earlybird_orders
   WHERE id = ${orderId}
   FOR SHARE;
  IF v_pointer IS DISTINCT FROM ${requestId}
     OR v_order_status <> 'completed'
     OR v_plan_id <> 'basic'
     OR v_paid_at < '${SAMPLE_START}'::timestamptz
     OR v_paid_at >= '${SAMPLE_END}'::timestamptz THEN
    RAISE EXCEPTION 'CONCIERGE_ATOMIC_SCOPE_CONFLICT';
  END IF;
  SELECT status, pipeline_version
    INTO v_request_status, v_pipeline_version
    FROM public.analysis_requests
   WHERE id = ${requestId}
   FOR UPDATE;
  IF v_request_status <> 'completed' OR v_pipeline_version <> 'v1' THEN
    RAISE EXCEPTION 'CONCIERGE_ATOMIC_REQUEST_SCOPE_CONFLICT';
  END IF;
END
$guard$;
DELETE FROM public.analysis_results WHERE request_id = ${requestId};
INSERT INTO public.analysis_results (
  request_id, rank, suspect_instagram_id, suspect_profile_image, suspect_full_name,
  bio, risk_score, photogenic_grade, exposure_level, is_tagged, risk_grade,
  gender_confidence, gender_status, is_unlocked, likes_count,
  intimate_comments_count, risk_analysis
)
SELECT ${requestId}, rank, suspect_instagram_id, suspect_profile_image, suspect_full_name,
  bio, risk_score, photogenic_grade, exposure_level, is_tagged, risk_grade,
  gender_confidence, gender_status, is_unlocked, likes_count,
  intimate_comments_count, risk_analysis
FROM jsonb_to_recordset(${payloadSql}->'femaleRows') AS rows(
  rank integer,
  suspect_instagram_id text,
  suspect_profile_image text,
  suspect_full_name text,
  bio text,
  risk_score integer,
  photogenic_grade integer,
  exposure_level text,
  is_tagged boolean,
  risk_grade text,
  gender_confidence double precision,
  gender_status text,
  is_unlocked boolean,
  likes_count integer,
  intimate_comments_count integer,
  risk_analysis jsonb
);
DELETE FROM public.private_accounts WHERE request_id = ${requestId};
INSERT INTO public.private_accounts (
  request_id, instagram_id, profile_image, full_name,
  name_female_score, name_is_name, name_confidence
)
SELECT ${requestId}, instagram_id, profile_image, full_name,
  name_female_score, name_is_name, name_confidence
FROM jsonb_to_recordset(${payloadSql}->'privateRows') AS rows(
  instagram_id text,
  profile_image text,
  full_name text,
  name_female_score double precision,
  name_is_name boolean,
  name_confidence double precision
);
UPDATE public.analysis_requests
   SET status = 'completed', progress = 100, progress_step = '분석 완료!',
       opposite_gender_count = ${input.counts.female},
       gender_stats = ${genderStats},
       current_step = 'completed', error_message = NULL,
       completed_at = now()
 WHERE id = ${requestId};
COMMIT;`;
}

function applyAtomicPublication(input: Parameters<typeof buildAtomicPublicationSql>[0]): void {
    const sql = buildAtomicPublicationSql(input);
    execFileSync('supabase', [
        '--workdir', CANONICAL_WORKDIR,
        'db', 'query', '--linked', '--agent=yes', '--output', 'json', sql,
    ], { stdio: 'pipe', encoding: 'utf8' });
}

function readLinkedProviderSource(requestId: string): {
    runs: readonly ProviderRun[];
    evidence: unknown;
} {
    const query = `SELECT json_build_object(
      'runs', COALESCE(json_agg(json_build_object(
        'actor_id', actor_id, 'credential_slot', credential_slot, 'run_id', run_id,
        'operation_key', operation_key, 'status', status, 'job_key', job_key
      ) ORDER BY job_key) FILTER (WHERE status = 'succeeded' AND run_id IS NOT NULL), '[]'::json),
      'evidence', public.load_analysis_v2_target_evidence(
        ${sqlString(requestId)}::uuid, 'track:target-evidence:collect'
      )
    ) AS source
    FROM public.analysis_v2_provider_runs
    WHERE request_id = ${sqlString(requestId)}::uuid;`;
    const stdout = execFileSync('supabase', [
        '--workdir', CANONICAL_WORKDIR,
        'db', 'query', '--linked', '--agent=yes', '--output', 'json', query,
    ], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    const parsed = z.object({
        rows: z.array(z.object({
            source: z.object({
                runs: z.array(z.unknown()),
                evidence: z.unknown(),
            }),
        })),
    }).parse(JSON.parse(stdout));
    const source = parsed.rows[0]?.source;
    if (!source) throw new Error('CONCIERGE_PROVIDER_RUN_LOOKUP_FAILED');
    return {
        runs: source.runs.map(row => providerRunSchema.parse(row)),
        evidence: source.evidence,
    };
}

async function main(): Promise<void> {
    const startedAt = Date.now();
    const { data: orders, error: orderError } = await supabaseAdmin
        .from('earlybird_orders')
        .select('id,user_id,target_instagram_id,result_request_id,status,plan_id,paid_at')
        .eq('plan_id', 'basic')
        .gte('paid_at', SAMPLE_START)
        .lt('paid_at', SAMPLE_END);
    if (orderError || !orders || orders.length !== 1) throw new Error('CONCIERGE_SAMPLE_ORDER_SCOPE_CONFLICT');
    const order = orders[0]!;
    if (
        order.status !== 'completed'
        || typeof order.result_request_id !== 'string'
        || typeof order.target_instagram_id !== 'string'
    ) throw new Error('CONCIERGE_SAMPLE_ORDER_NOT_READY');

    const { data: requests, error: requestError } = await supabaseAdmin
        .from('analysis_requests')
        .select('id,status,pipeline_version,gender_stats')
        .eq('user_id', order.user_id);
    if (requestError || !requests) throw new Error('CONCIERGE_SAMPLE_REQUEST_LOOKUP_FAILED');
    const request = requests.find(row => row.id === order.result_request_id);
    const sourceRequest = requests.find(row => row.pipeline_version === 'v2' && row.status === 'failed');
    if (!request || request.status !== 'completed' || request.pipeline_version !== 'v1' || !sourceRequest) {
        throw new Error('CONCIERGE_SAMPLE_REQUEST_SCOPE_CONFLICT');
    }
    const linkedSource = readLinkedProviderSource(sourceRequest.id);
    const runs = linkedSource.runs
        .filter(row => row.job_key.startsWith('manual:concierge:profiles:')
            || row.job_key === 'track:relationships:collect'
            || row.job_key === 'track:target-evidence:collect')
        .map(row => providerRunSchema.parse(row));
    if (runs.length !== 7) throw new Error('CONCIERGE_PROVIDER_RUN_SCOPE_CONFLICT');

    const evidencePayload = linkedSource.evidence as { rows?: unknown; manifest?: { interactorCount?: number } } | null;
    const evidenceRows = z.array(targetEvidenceRowSchema).parse(evidencePayload?.rows ?? []);
    if (evidenceRows.length !== 95 || evidencePayload?.manifest?.interactorCount !== 95) {
        throw new Error('CONCIERGE_TARGET_EVIDENCE_SCOPE_CONFLICT');
    }

    const provider = await loadProviderEvidence({
        runs,
        targetUsername: order.target_instagram_id,
    });
    const partition = deriveConciergePrivacyPartition({
        profiles: provider.profiles,
        relationshipRows: provider.relationshipRows,
    });
    const sourceFingerprint = sha256({
        request: sourceRequest.id,
        runs: runs.map(run => ({ operation: run.operation_key, run: run.run_id })),
        profiles: provider.profiles.map(profile => ({
            username: profile.username,
            isPrivate: profile.isPrivate,
            posts: profile.latestPosts?.map(post => post.id) ?? [],
        })),
        evidenceRows,
    });
    const profiles = provider.profiles
        .slice()
        .sort((left, right) => left.username.localeCompare(right.username))
        .map(checkpointProfile);
    const relationship = partition.relationshipRows.map(row => ({
        username: row.username,
        side: row.side,
        isPrivate: row.isPrivate,
        isVerified: row.isVerified,
        fullName: row.fullName,
        ordinal: row.ordinal,
    }));
    const targetInteractions = evidenceRows.map(row => ({
        actorUsername: row.actorUsername.toLowerCase(),
        postId: row.postId,
        signal: row.signal,
        sourceInteractionId: row.sourceInteractionId,
        ...(row.occurredAt ? { occurredAt: row.occurredAt } : {}),
        ...(row.content ? { content: row.content } : {}),
    }));
    const sourceEvidence: AnalysisV2ReplayBundle['evidence'] = {
        relationship,
        targetInteractions: targetInteractions.map(row => ({
            ...row,
            occurredAt: row.occurredAt ?? null,
            content: row.content ?? null,
        })),
        reverseInteractions: [],
    };
    const bundle = await captureAnalysisV2ReplayBundle({
        selector: { targetUsername: order.target_instagram_id },
        repository: {
            async findCompletedReplaySourceExact() {
                return {
                    requestFingerprint: sourceFingerprint,
                    sourceLineage: BASIC_SOURCE_LINEAGE,
                    completed: true,
                };
            },
            async loadReplaySource() {
                return {
                    profiles,
                    evidence: sourceEvidence,
                    providerRuns: [],
                };
            },
        },
        normalizeMedia: createAnalysisV2SelectedMediaNormalizer(),
        evaluationPolicy: conciergeEvaluationPolicy,
    });
    const details = new Map<number, ReplayAccountAiDetail>();
    const report = await runAnalysisV2AiReplay({
        bundle,
        runner: createReplayStagedAiAdapter(AI_STAGE_POLICY_V211_VERSION),
        mode: 'paid-ai',
        paidAiOptIn: true,
        evaluationPolicy: conciergeEvaluationPolicy,
        onAccountAnalyzed(detail) {
            details.set(detail.ordinal, detail);
        },
    });
    const profilesByOrdinal = new Map(bundle.profiles.map(profile => [profile.ordinal, profiles[profile.ordinal - 1]! ]));
    const result = buildCanonicalConciergeResult({
        targetUsername: order.target_instagram_id,
        profilesByOrdinal,
        details: [...details.values()],
        orderedMutualUsernames: partition.orderedMutualUsernames,
        targetInteractions,
        privateProfiles: partition.privateProfiles,
    });
    validateCanonicalConciergeCorrection({
        fetchedCount: provider.profiles.length,
        partition,
        result,
    });
    if (report.gender.male !== result.counts.male || report.gender.female !== result.counts.female) {
        throw new Error('CONCIERGE_GENDER_REPORT_RECONCILIATION_FAILED');
    }

    const { data: currentOrder, error: currentOrderError } = await supabaseAdmin
        .from('earlybird_orders')
        .select('id,result_request_id,status,plan_id,paid_at')
        .eq('id', order.id)
        .maybeSingle();
    if (
        currentOrderError
        || !currentOrder
        || currentOrder.result_request_id !== order.result_request_id
        || currentOrder.status !== 'completed'
        || currentOrder.plan_id !== 'basic'
    ) throw new Error('CONCIERGE_PUBLICATION_SCOPE_CHANGED');

    const beforeRows = await supabaseAdmin
        .from('analysis_results')
        .select('rank')
        .eq('request_id', order.result_request_id);
    const beforePrivateRows = await supabaseAdmin
        .from('private_accounts')
        .select('instagram_id')
        .eq('request_id', order.result_request_id);
    applyAtomicPublication({
        orderId: order.id,
        requestId: order.result_request_id,
        targetUsername: order.target_instagram_id,
        femaleRows: result.femaleRows,
        privateRows: result.privateRows,
        counts: {
            male: result.counts.male,
            female: result.counts.female,
            unknown: result.counts.unknown,
        },
    });

    const [afterRequest, afterResults, afterPrivate] = await Promise.all([
        supabaseAdmin.from('analysis_requests').select('status,progress,gender_stats,pipeline_version').eq('id', order.result_request_id).maybeSingle(),
        supabaseAdmin.from('analysis_results').select('rank,risk_score,risk_grade,risk_analysis,gender_status').eq('request_id', order.result_request_id).order('rank'),
        supabaseAdmin.from('private_accounts').select('instagram_id').eq('request_id', order.result_request_id),
    ]);
    if (
        afterRequest.error || !afterRequest.data
        || afterRequest.data.status !== 'completed'
        || afterRequest.data.progress !== 100
        || afterRequest.data.pipeline_version !== 'v1'
        || afterResults.error || !afterResults.data
        || afterResults.data.length !== result.femaleRows.length
        || afterResults.data.some(row => row.risk_score === null || row.risk_grade === null || row.gender_status !== 'confirmed')
        || afterPrivate.error || !afterPrivate.data
        || afterPrivate.data.length !== result.privateRows.length
    ) throw new Error('CONCIERGE_PUBLICATION_VERIFY_FAILED');
    const highRiskRows = afterResults.data.filter(row => row.risk_grade === 'high_risk');
    if (highRiskRows.some(row => !Array.isArray(row.risk_analysis) || row.risk_analysis.length !== 2)) {
        throw new Error('CONCIERGE_PUBLICATION_NARRATIVE_VERIFY_FAILED');
    }
    const semanticInputFingerprint = analysisV2ReplaySemanticInputFingerprint(bundle);
    console.log(JSON.stringify({
        state: 'completed',
        resultPath: `/result/${order.result_request_id}`,
        before: {
            resultRows: beforeRows.data?.length ?? 0,
            privateRows: beforePrivateRows.data?.length ?? 0,
            unresolved: (request.gender_stats as Record<string, number> | null)?.unknown ?? null,
        },
        after: {
            fetchedProfiles: provider.profiles.length,
            publicProfiles: partition.publicProfiles.length,
            privateProfiles: partition.privateProfiles.length,
            male: result.counts.male,
            female: result.counts.female,
            unknown: result.counts.unknown,
            resultRows: result.femaleRows.length,
            privateRows: result.privateRows.length,
            highRiskRows: highRiskRows.length,
            semanticInputFingerprint,
        },
        resolver: {
            ready: report.resolver.ready,
            applied: report.resolver.applied,
            inconclusive: report.resolver.inconclusive,
            cutoff: report.resolver.cutoff,
        },
        elapsedSeconds: Number(((Date.now() - startedAt) / 1_000).toFixed(1)),
        providerRecollection: false,
        targetEvidenceReused: true,
    }));
}

main().catch(error => {
    console.error(JSON.stringify({ state: 'failed', code: safeError(error) }));
    process.exitCode = 1;
});
