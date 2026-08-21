import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { AccountContext, AppearanceGrade } from '@/lib/domain/analysis/risk-policy';
import { calculateV2FinalScores, calculateV2PreliminaryScores, hasCandidateTargetMention } from '@/lib/services/analysis/v2-candidate-scoring';
import { analysisV2CandidateId } from '@/lib/services/analysis/v2-ai-scoring-executors';
import { joinVerifiedFemaleTargetInteractions, summarizeCandidateTargetInteractions } from '@/lib/services/analysis/v2-target-interactions';
import { createAnalysisV2SelectedMediaNormalizer } from '@/lib/services/ai/image-preprocessing';
import { AI_STAGE_POLICY_V211_VERSION } from '@/lib/services/ai/stage-policy';
import { createReplayStagedAiAdapter } from '@/lib/services/analysis/replay/replay-staged-ai-adapter';
import { captureAnalysisV2ReplayBundle } from '@/lib/services/analysis/replay/replay-capture';
import { runAnalysisV2AiReplay, type ReplayAccountAiDetail } from '@/lib/services/analysis/replay/replay-runner';
import { FIRST_PAYMENT_BASIC_V211_CONCIERGE_CAPABILITY } from '@/lib/services/analysis/replay/replay-source-lineage';
import { analysisV2ProviderRunStore, createAnalysisV2ProviderInputHash, createAnalysisV2ProviderOperationKey, type StoredAnalysisV2ProviderRun } from '@/lib/services/analysis/v2-provider-run-store';
import { getProfilesBatchV2, type ProfilesBatchV2AttemptSnapshot } from '@/lib/services/instagram/scraper';
import { APIFY_PROFILE_ACTOR_ID } from '@/lib/services/instagram/providers/apify';
import { profileMaximumCharge } from '@/lib/services/analysis/v2-apify-operation-costs';
import { firstPaymentConciergeCheckpointProfile } from '@/lib/services/analysis/first-payment-concierge';
import type { InstagramProfile } from '@/lib/types/instagram';
import type { FeatureAnalysisResult } from '@/lib/services/ai/v2-staged-analysis';

const ORDER_ID = 'bb3ddb08-f8fa-42d9-b1f6-92621be18e38';
const OLD_REQUEST_ID = 'd88bf426-2295-44d9-b4b4-dcbf79b775b7';
const BATCH_SIZE = 30;
const EVALUATION_POLICY = {
    capability: FIRST_PAYMENT_BASIC_V211_CONCIERGE_CAPABILITY,
    aiStage: AI_STAGE_POLICY_V211_VERSION,
} as const;
const SOURCE_LINEAGE = {
    selectedPlanId: 'basic',
    policyVersions: {
        pipeline: 'v2',
        aiStage: AI_STAGE_POLICY_V211_VERSION,
        risk: 'risk-policy-v2.5',
        scheduler: 'ai-scheduler-v1',
    },
} as const;

const rowSchema = z.object({
    actorUsername: z.string().regex(/^[a-z0-9._]{1,30}$/),
    postId: z.string().min(1),
    signal: z.enum(['target_post_like', 'target_post_comment']),
    sourceInteractionId: z.string().min(1),
    occurredAt: z.string().datetime({ offset: true }).nullable(),
    content: z.string().nullable(),
}).strict();

type EvidenceRow = z.infer<typeof rowSchema>;
type ProfileEntry = { ordinal: number; profile: InstagramProfile };

function sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function die(code: string): never { throw new Error(code); }

function safeError(error: unknown): string {
    const text = error instanceof Error ? error.message : '';
    return /^([A-Z][A-Z0-9_]{2,119})/.exec(text)?.[1] ?? 'CONCIERGE_BASIC_FAILED';
}

function accountContext(feature: FeatureAnalysisResult, profile: InstagramProfile): AccountContext {
    if (feature.features.accountContext !== 'official_group_or_brand') return feature.features.accountContext;
    const bio = `${profile.fullName ?? ''} ${profile.bio ?? ''}`.toLowerCase();
    return /official|official account|공식|브랜드|brand|company|회사/.test(bio)
        ? 'official_group_or_brand'
        : 'personal';
}

function strongPartner(feature: FeatureAnalysisResult): boolean {
    return feature.features.partnerExclusionContext === 'none'
        && (feature.features.marriageEvidence === 'strong' || feature.features.partnerEvidence === 'strong');
}

function weakPartner(feature: FeatureAnalysisResult): boolean {
    return feature.features.partnerExclusionContext === 'none'
        && !strongPartner(feature)
        && (feature.features.marriageEvidence === 'possible' || feature.features.partnerEvidence === 'weak');
}

function exposureLevel(score: number): 'high' | 'medium' | 'low' {
    return score >= 0.66 ? 'high' : score >= 0.33 ? 'medium' : 'low';
}

async function rpc<T>(name: string, params: Record<string, unknown> = {}): Promise<T> {
    const { data, error } = await supabaseAdmin.rpc(name, params);
    if (error) die(`CONCIERGE_BASIC_RPC_${name.toUpperCase()}_FAILED`);
    return data as T;
}

async function loadOrder(): Promise<{ userId: string; targetUsername: string }> {
    const { data, error } = await supabaseAdmin.from('earlybird_orders')
        .select('id,user_id,plan_id,status,paid_at,target_instagram_id,target_followers_count,target_following_count,result_request_id')
        .eq('id', ORDER_ID).maybeSingle();
    if (error || !data) die('CONCIERGE_BASIC_ORDER_NOT_FOUND');
    if (data.plan_id !== 'basic' || data.status !== 'analysis_in_progress'
        || Date.parse(data.paid_at) < Date.parse('2026-08-12T18:07:00+09:00')
        || Date.parse(data.paid_at) >= Date.parse('2026-08-12T18:08:00+09:00')) {
        die('CONCIERGE_BASIC_ORDER_SCOPE_CONFLICT');
    }
    if (data.result_request_id !== OLD_REQUEST_ID) die('CONCIERGE_BASIC_REQUEST_SCOPE_CONFLICT');
    return { userId: data.user_id, targetUsername: data.target_instagram_id.toLowerCase() };
}

async function ensureManualProfileJob(batch: number, usernames: readonly string[]) {
    const jobKey = `manual:concierge:profiles:${batch}`;
    const inputHash = sha256(['concierge-basic-profile-v1', OLD_REQUEST_ID, batch, ...usernames].join('\n'));
    const { data: existing, error: readError } = await supabaseAdmin.from('analysis_pipeline_jobs')
        .select('job_key,input_hash,status,lease_token,lease_expires_at')
        .eq('request_id', OLD_REQUEST_ID).eq('job_key', jobKey).maybeSingle();
    if (readError) die('CONCIERGE_BASIC_JOB_READ_FAILED');
    if (existing) {
        if (existing.input_hash !== inputHash || existing.status !== 'processing' || !existing.lease_token) {
            die('CONCIERGE_BASIC_JOB_IDENTITY_CONFLICT');
        }
        return { jobKey, inputHash, claimToken: existing.lease_token as string };
    }
    const claimToken = randomUUID();
    const reservationToken = randomUUID();
    const now = new Date();
    const lease = new Date(now.getTime() + 45 * 60_000);
    const row = {
        request_id: OLD_REQUEST_ID, job_key: jobKey, track: 'manual_concierge', kind: 'profile_fetch', batch,
        input_hash: inputHash, required_job_keys: [], status: 'processing', dispatch_state: 'delivered',
        dispatch_generation: 1, dispatch_reservation_token: reservationToken, dispatch_reserved_at: now.toISOString(),
        dispatched_at: now.toISOString(), dispatch_task_name: `manual-concierge/${batch}`, delivered_at: now.toISOString(),
        lease_token: claimToken, lease_expires_at: lease.toISOString(), attempt_count: 1,
        first_started_at: now.toISOString(), created_at: now.toISOString(), updated_at: now.toISOString(),
    };
    const { error } = await supabaseAdmin.from('analysis_pipeline_jobs').insert(row);
    if (error) die('CONCIERGE_BASIC_JOB_CREATE_FAILED');
    return { jobKey, inputHash, claimToken };
}

async function collectProfiles(targetUsername: string, rows: readonly EvidenceRow[]) {
    if (!process.env.APIFY_TERTIARY_API_TOKEN?.trim()) die('CONCIERGE_BASIC_TERTIARY_TOKEN_REQUIRED');
    const usernames = [...new Set(rows.map(row => row.actorUsername).filter(value => value !== targetUsername))];
    const profiles = new Map<string, ProfileEntry>();
    const unavailable = new Set<string>();
    let batchIndex = 0;
    for (let offset = 0; offset < usernames.length; offset += BATCH_SIZE) {
        const batch = usernames.slice(offset, offset + BATCH_SIZE);
        const job = await ensureManualProfileJob(batchIndex, batch);
        const operationInput = ['concierge-basic-profile-batch-v1', OLD_REQUEST_ID, batchIndex, ...batch].join('\n');
        const operationKey = createAnalysisV2ProviderOperationKey('profile-fallback', operationInput);
        const providerInputHash = createAnalysisV2ProviderInputHash(operationInput);
        const binding = await analysisV2ProviderRunStore.bindAdapterCheckpoint({
            requestId: OLD_REQUEST_ID, jobKey: job.jobKey, claimToken: job.claimToken,
            operationKey, inputHash: providerInputHash,
            logicalProvider: 'apify', actorId: APIFY_PROFILE_ACTOR_ID,
            credentialSlot: 'tertiary', maxChargeUsd: profileMaximumCharge(batch.length, process.env),
        });
        let snapshot: ProfilesBatchV2AttemptSnapshot | null = null;
        const result = await getProfilesBatchV2(batch, {
            requestId: OLD_REQUEST_ID,
            freshApifyOnly: true,
            providerRun: binding.checkpoint,
            persistAttemptOutcomes: async value => { snapshot = value; },
        });
        if (!snapshot) die('CONCIERGE_BASIC_PROFILE_CHECKPOINT_MISSING');
        for (const outcome of result.results) {
            if (outcome.outcome.status === 'success' && 'profile' in outcome) {
                profiles.set(outcome.outcome.requestedUsername, { ordinal: rows.findIndex(row => row.actorUsername === outcome.outcome.requestedUsername) + 1, profile: outcome.profile });
            } else {
                unavailable.add(outcome.outcome.requestedUsername);
            }
        }
        batchIndex++;
    }
    if (profiles.size === 0) die('CONCIERGE_BASIC_NO_PROFILE_DATA');
    return { profiles, unavailable, requested: usernames.length, batches: batchIndex };
}

async function reconcileProfileRuns(): Promise<void> {
    const { data, error } = await supabaseAdmin.rpc('list_analysis_v2_unreconciled_provider_runs', { p_limit: 64 });
    if (error || !Array.isArray(data)) return;
    for (const run of data as StoredAnalysisV2ProviderRun[]) {
        if (run.requestId !== OLD_REQUEST_ID || !String(run.jobKey).startsWith('manual:concierge:profiles:')) continue;
        if (!run.runId || !['succeeded', 'failed', 'aborted', 'timed_out'].includes(run.status)) continue;
        await analysisV2ProviderRunStore.reconcileUsage({
            reservationToken: run.reservationToken, runId: run.runId,
            logicalProvider: run.logicalProvider, actorId: run.actorId,
            credentialSlot: run.credentialSlot, maxChargeUsd: Number(run.maxChargeUsd),
            status: run.status as 'succeeded' | 'failed' | 'aborted' | 'timed_out',
            actualUsageUsd: Number(run.actualUsageUsd ?? 0),
        }).catch(() => undefined);
    }
}

async function main(): Promise<void> {
    const startedAt = Date.now();
    const order = await loadOrder();
    const evidencePayload = await rpc<{
        rows?: unknown;
        manifest?: { interactorCount?: number; resultHash?: string };
    }>('load_analysis_v2_target_evidence', {
        p_request_id: OLD_REQUEST_ID, p_job_key: 'track:target-evidence:collect',
    });
    const rows = z.array(rowSchema).parse(evidencePayload?.rows ?? []);
    if (rows.length !== 95 || evidencePayload?.manifest?.interactorCount !== 95) die('CONCIERGE_BASIC_TARGET_EVIDENCE_SCOPE_CONFLICT');
    const collected = await collectProfiles(order.targetUsername, rows);
    await reconcileProfileRuns();
    const orderedProfiles = [...collected.profiles.values()].sort((a, b) => a.ordinal - b.ordinal)
        .map(entry => ({ ordinal: entry.ordinal, profile: firstPaymentConciergeCheckpointProfile(entry.profile) }));
    const evidence = {
        relationship: rows.map((row, index) => ({ username: row.actorUsername, side: 'follower' as const, isPrivate: false, isVerified: false, fullName: null, ordinal: index + 1 })),
        targetInteractions: rows.map(row => ({ actorUsername: row.actorUsername, postId: row.postId, signal: row.signal, sourceInteractionId: row.sourceInteractionId, occurredAt: row.occurredAt, content: row.content })),
        reverseInteractions: [],
    };
    if (!evidencePayload.manifest?.resultHash) die('CONCIERGE_BASIC_TARGET_EVIDENCE_SCOPE_CONFLICT');
    const descriptorHash = sha256(['concierge-basic-descriptor-v1', OLD_REQUEST_ID, evidencePayload.manifest.resultHash].join('\n'));
    const bundle = await captureAnalysisV2ReplayBundle({
        selector: { targetUsername: order.targetUsername },
        repository: {
            async findCompletedReplaySourceExact() { return { requestFingerprint: descriptorHash, sourceLineage: SOURCE_LINEAGE, completed: true }; },
            async loadReplaySource() { return { profiles: orderedProfiles.map(entry => entry.profile), evidence, providerRuns: [] }; },
        },
        normalizeMedia: createAnalysisV2SelectedMediaNormalizer(),
        evaluationPolicy: EVALUATION_POLICY,
    });
    const details = new Map<number, ReplayAccountAiDetail>();
    const report = await runAnalysisV2AiReplay({
        bundle, runner: createReplayStagedAiAdapter(AI_STAGE_POLICY_V211_VERSION), mode: 'paid-ai', paidAiOptIn: true,
        evaluationPolicy: EVALUATION_POLICY,
        onAccountAnalyzed(detail) { details.set(detail.ordinal, detail); },
    });
    const profileByOrdinal = new Map(orderedProfiles.map(entry => [entry.ordinal, entry.profile]));
    const female = [...details.values()].filter(detail => detail.finalClassification === 'verified_female' && detail.feature);
    if (female.length === 0) die('CONCIERGE_BASIC_NO_RANKED_CANDIDATES');
    const femaleUsernames = female.map(detail => profileByOrdinal.get(detail.ordinal)!.username);
    const joined = joinVerifiedFemaleTargetInteractions({ evidence: rows.map(row => ({ ...row, occurredAt: row.occurredAt ?? undefined, content: row.content ?? undefined })), verifiedFemaleUsernames: femaleUsernames, excludedUsername: null });
    const interactionByUsername = new Map(summarizeCandidateTargetInteractions(joined).map(summary => [summary.candidateUsername, summary]));
    const candidates = female.map(detail => {
        const profile = profileByOrdinal.get(detail.ordinal)!;
        const feature = detail.feature!;
        const username = profile.username.toLowerCase();
        const interaction = interactionByUsername.get(username);
        const mention = hasCandidateTargetMention({ targetUsername: order.targetUsername, candidateUsername: username, targetPosts: [], candidatePosts: profile.latestPosts ?? [] });
        return { candidateId: analysisV2CandidateId(username), username, appearanceGrade: feature.features.appearanceGrade as AppearanceGrade, exposureScore: feature.features.exposureScore, accountContext: accountContext(feature, profile), hasWeakPartnerEvidence: weakPartner(feature), hasStrongPartnerEvidence: strongPartner(feature), uniqueTargetPostsLikedByCandidate: interaction?.uniqueTargetPostsLikedByCandidate ?? 0, boundedCandidateCommentsOnTarget: interaction?.boundedCandidateCommentsOnTarget ?? 0, hasCandidateToTargetTagOrCaptionMention: mention.candidateToTargetTagOrCaptionMention, hasTargetToCandidateTagOrCaptionMention: mention.targetToCandidateTagOrCaptionMention };
    });
    const preliminary = calculateV2PreliminaryScores({ candidates, orderedMutualUsernames: rows.map(row => row.actorUsername), excludedUsername: null, riskPolicyVersion: 'risk-policy-v2.5' });
    const finalScores = calculateV2FinalScores({ preliminary, observedReverseLikeCandidateIds: new Set(), notCollectedCandidateIds: new Set(preliminary.map(row => row.candidateId)), riskPolicyVersion: 'risk-policy-v2.5' }).sort((a, b) => b.displayScore - a.displayScore || a.candidateId.localeCompare(b.candidateId));
    const femaleDetailById = new Map(female.map(detail => [analysisV2CandidateId(profileByOrdinal.get(detail.ordinal)!.username), { detail, profile: profileByOrdinal.get(detail.ordinal)! }]));
    const resultRows = finalScores.map((score, index) => {
        const retained = femaleDetailById.get(score.candidateId)!;
        const interaction = interactionByUsername.get(retained.profile.username.toLowerCase());
        return { request_id: '', rank: index + 1, suspect_instagram_id: retained.profile.username.toLowerCase(), suspect_profile_image: retained.profile.profilePicUrl ?? null, suspect_full_name: retained.profile.fullName ?? null, bio: retained.profile.bio ?? null, risk_score: Math.round(score.displayScore * 10), photogenic_grade: retained.detail.feature!.features.appearanceGrade, exposure_level: exposureLevel(retained.detail.feature!.features.exposureScore), is_tagged: score.hasCandidateToTargetTagOrCaptionMention, risk_grade: score.riskBand, gender_confidence: retained.detail.triage?.assessment.confidence === 'high' ? 0.9 : retained.detail.triage?.assessment.confidence === 'medium' ? 0.6 : 0.3, gender_status: 'confirmed', is_unlocked: true, likes_count: interaction?.uniqueTargetPostsLikedByCandidate ?? 0, intimate_comments_count: interaction?.boundedCandidateCommentsOnTarget ?? 0, risk_analysis: [] };
    });
    const now = new Date().toISOString();
    const femaleCount = female.length;
    const maleCount = report.gender.male;
    const unknownCount = Math.max(0, collected.profiles.size - femaleCount - maleCount);
    // The original V2 request remains untouched at the job/stage level. Mark it
    // superseded so the owner-readable legacy result request can be created under
    // the same account without violating the one-active-request index.
    const { error: supersedeError } = await supabaseAdmin.from('analysis_requests').update({
        status: 'failed', current_step: 'failed', background_processing: false,
        error_message: 'Superseded by concierge result publication.', completed_at: now,
    }).eq('id', OLD_REQUEST_ID).eq('status', 'processing');
    if (supersedeError) die('CONCIERGE_BASIC_OLD_REQUEST_SUPERSEDE_FAILED');
    const existing = await supabaseAdmin.from('analysis_requests').select('id,status').eq('idempotency_key', `concierge-basic-v1:${ORDER_ID}`).maybeSingle();
    if (existing.error) die('CONCIERGE_BASIC_RESULT_REQUEST_LOOKUP_FAILED');
    let requestId = existing.data?.id as string | undefined;
    if (requestId && existing.data?.status !== 'completed') die('CONCIERGE_BASIC_RESULT_REQUEST_CONFLICT');
    if (!requestId) requestId = randomUUID();
    const requestError = requestId === existing.data?.id ? null : (await supabaseAdmin.from('analysis_requests').insert({
        id: requestId, user_id: order.userId, target_instagram_id: order.targetUsername, target_gender: 'male',
        status: 'completed', progress: 100, progress_step: '분석 완료!', total_followers: 158, mutual_follows: rows.length,
        opposite_gender_count: femaleCount, confidence_score: 1, plan_type: 'basic',
        gender_stats: { male: maleCount, female: femaleCount, unknown: unknownCount }, current_step: 'completed', step_data: {},
        share_enabled: false, idempotency_key: `concierge-basic-v1:${ORDER_ID}`, background_processing: false,
        retry_count: 0, pipeline_version: 'v1', created_at: now, completed_at: now,
    })).error;
    if (requestError) die('CONCIERGE_BASIC_RESULT_REQUEST_CREATE_FAILED');
    const { error: resultResetError } = await supabaseAdmin.from('analysis_results').delete().eq('request_id', requestId);
    if (resultResetError) die('CONCIERGE_BASIC_RESULT_RESET_FAILED');
    const insertRows = resultRows.map(row => ({ ...row, request_id: requestId }));
    const { error: resultError } = await supabaseAdmin.from('analysis_results').insert(insertRows);
    if (resultError) {
        console.error(JSON.stringify({ dbCode: resultError.code, dbMessage: resultError.message }));
        die('CONCIERGE_BASIC_RESULT_ROWS_CREATE_FAILED');
    }
    const { data: verify, error: verifyError } = await supabaseAdmin.from('analysis_results').select('rank,risk_score,risk_grade').eq('request_id', requestId).order('rank');
    if (verifyError || !verify?.length || verify.some(row => row.risk_score === null || row.risk_grade === null)) die('CONCIERGE_BASIC_RESULT_VERIFY_FAILED');
    console.log(JSON.stringify({ state: 'completed', resultUrl: `/result/${requestId}`, targetEvidenceCount: rows.length, requestedProfiles: collected.requested, profileBatches: collected.batches, profilesAvailable: collected.profiles.size, profilesUnavailable: collected.unavailable.size, rankedCandidates: verify.length, gender: { male: maleCount, female: femaleCount, unknown: unknownCount }, orderBinding: 'not_updated_existing_order_pointer_guard', elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(1)) }));
}

main().catch(error => { console.error(JSON.stringify({ state: 'failed', code: safeError(error) })); process.exitCode = 1; });
