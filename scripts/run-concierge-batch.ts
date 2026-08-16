import { createHash } from 'node:crypto';
import { ApifyClient } from 'apify-client';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getAnalysisPlan } from '@/lib/domain/analysis/plan-catalog';
import type { InstagramFollower, InstagramPost, InstagramProfile } from '@/lib/types/instagram';
import type { ProviderCallContext } from '@/lib/services/instagram/providers/types';
import {
    APIFY_PROFILE_ACTOR_ID,
    makeApifyProvider,
    parseApifyProfileDataset,
} from '@/lib/services/instagram/providers/apify';
import {
    apifyInteractionAdapter,
    makeApifyInteractionAdapter,
} from '@/lib/services/instagram/providers/apify-interactions';
import { extractRawTargetInteractions } from '@/lib/services/analysis/v2-target-interactions';
import { instagramPostUrl, selectRecentInteractionPosts } from '@/lib/services/analysis/interaction-posts';
import { analysisV2CandidateId } from '@/lib/services/analysis/v2-ai-scoring-executors';
import {
    captureFirstPaymentConciergeAiBundle,
    firstPaymentConciergeEvaluationPolicy,
} from '@/lib/services/analysis/first-payment-concierge';
import { createReplayStagedAiAdapter } from '@/lib/services/analysis/replay/replay-staged-ai-adapter';
import { runAnalysisV2AiReplay, type ReplayAccountAiDetail } from '@/lib/services/analysis/replay/replay-runner';
import { analyzePrivateAccountNames } from '@/lib/services/ai/private-name-analysis';
import {
    createConciergeClassificationLedgerHash,
    createConciergeZeroPostEvidenceHash,
    parseConciergeClassificationCsv,
    type ConciergeClassificationLedger,
    type ConciergeClassificationRecord,
} from '@/lib/services/analysis/concierge-classification-import';
import {
    createConciergeBatchCasPublisher,
    runConciergeBatch,
    type ConciergeBatchOrder,
    type ConciergeBatchPreparedOrder,
    type ConciergeBatchStageContext,
} from '@/lib/services/analysis/concierge-batch-runner';
import type {
    ConciergeManualPublicationInput,
    ConciergeStoredReplayFeatures,
} from '@/lib/services/analysis/concierge-batch-publication';

const ORDER_ID = z.string().uuid();
const USERNAME = z.string().regex(/^[a-z0-9._]{1,30}$/);
const APPROVED_SLOTS = ['senary', 'tertiary', 'quinary', 'primary'] as const;
type ApprovedSlot = typeof APPROVED_SLOTS[number];
const EMPTY_MANUAL_CSV = 'username,instagram_url,ai_classification,ai_confidence/evidence_status,manual_gender,operator_note\n';

type OrderRow = ConciergeBatchOrder & {
    preflightId: string;
    targetFollowers: number | null;
    targetFollowing: number | null;
};

type ProviderRunRow = {
    operation_key: string;
    actor_id: string;
    credential_slot: string;
    run_id: string;
    status: string;
};

type CollectedOrder = {
    order: OrderRow;
    prepared: ConciergeBatchPreparedOrder;
    source: import('@/lib/services/analysis/first-payment-concierge-source').FirstPaymentConciergeSource;
    captured: Awaited<ReturnType<typeof captureFirstPaymentConciergeAiBundle>>;
    interaction: ConciergeStoredReplayFeatures['bidirectionalInteractions'];
};

type ClassifiedOrder = {
    input: ConciergeManualPublicationInput;
};

function canonical(value: unknown): string {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}

function hash(value: unknown): string {
    return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

function normalized(value: string): string {
    return USERNAME.parse(value.trim().replace(/^@/, '').toLowerCase());
}

function tokenFor(slot: ApprovedSlot): string | null {
    const value = process.env[`APIFY_${slot.toUpperCase()}_API_TOKEN`]?.trim();
    return value || null;
}

function providerEnv(slot: ApprovedSlot, token: string): Record<string, string | undefined> {
    return {
        ...process.env,
        APIFY_API_TOKEN: token,
        // Existing provider factories only use the legacy primary/secondary
        // selector for their static definition; the injected client and call
        // context carry the approved fallback slot for actual billing.
        APIFY_API_TOKEN_SLOT: 'primary',
        [`APIFY_${slot.toUpperCase()}_API_TOKEN`]: token,
        APIFY_PRIMARY_API_TOKEN: token,
        APIFY_ACTOR_CONCURRENCY: '2',
    };
}

function providerContext(requestId: string, slot: ApprovedSlot): ProviderCallContext {
    return {
        requestId,
        credentialSlot: slot,
        maxChargeUsd: 100,
        invocationWaitLimitSecs: 240,
        recordUsage: () => undefined,
    };
}

function retryableProviderError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : '';
    return message.includes('SCRAPING_PROVIDER_QUOTA_ERROR')
        || message.includes('SCRAPING_PROVIDER_START_REJECTED_ERROR')
        || message.includes('SCRAPING_INCOMPLETE_ERROR')
        || message.includes('SCRAPING_RUN_PENDING_ERROR');
}

async function withProvider<T>(
    requestId: string,
    context: ConciergeBatchStageContext,
    operation: (slot: ApprovedSlot, provider: ReturnType<typeof makeApifyProvider>, env: Record<string, string | undefined>) => Promise<T>,
): Promise<T> {
    let lastError: unknown = null;
    for (const slot of APPROVED_SLOTS) {
        const token = tokenFor(slot);
        if (!token) continue;
        const env = providerEnv(slot, token);
        const provider = makeApifyProvider({
            env,
            client: new ApifyClient({ token, maxRetries: 0 }),
        });
        try {
            return await context.withActorSlot(() => operation(slot, provider, env));
        } catch (error) {
            lastError = error;
            if (!retryableProviderError(error)) throw error;
        }
    }
    throw lastError instanceof Error ? lastError : new Error('CONCIERGE_PROVIDER_TOKEN_UNAVAILABLE');
}

async function withInteractions<T>(
    requestId: string,
    context: ConciergeBatchStageContext,
    operation: (slot: ApprovedSlot, adapter: typeof apifyInteractionAdapter, env: Record<string, string | undefined>) => Promise<T>,
): Promise<T> {
    let lastError: unknown = null;
    for (const slot of APPROVED_SLOTS) {
        const token = tokenFor(slot);
        if (!token) continue;
        const env = providerEnv(slot, token);
        const adapter = makeApifyInteractionAdapter({
            env,
            client: new ApifyClient({ token, maxRetries: 0 }),
        });
        try {
            return await context.withActorSlot(() => operation(slot, adapter, env));
        } catch (error) {
            lastError = error;
            if (!retryableProviderError(error)) throw error;
        }
    }
    throw lastError instanceof Error ? lastError : new Error('CONCIERGE_INTERACTION_TOKEN_UNAVAILABLE');
}

async function loadTargetProfileArtifact(order: OrderRow): Promise<InstagramProfile | null> {
    const { data, error } = await supabaseAdmin
        .from('analysis_preflight_provider_runs')
        .select('operation_key,actor_id,credential_slot,run_id,status')
        .eq('preflight_id', order.preflightId)
        .eq('status', 'succeeded')
        .like('operation_key', 'target-profile%');
    if (error) throw new Error('CONCIERGE_PROVIDER_ARTIFACT_LOOKUP_FAILED');
    const rows = (data ?? []) as ProviderRunRow[];
    const candidates = rows
        .filter(row => row.actor_id === APIFY_PROFILE_ACTOR_ID && /^[A-Za-z0-9]{8,64}$/.test(row.run_id))
        .sort((left, right) => right.operation_key.localeCompare(left.operation_key));
    const row = candidates[0];
    if (!row) return null;
    const slot = APPROVED_SLOTS.includes(row.credential_slot as ApprovedSlot)
        ? row.credential_slot as ApprovedSlot
        : null;
    const token = slot ? tokenFor(slot) : null;
    if (!token) return null;
    const client = new ApifyClient({ token, maxRetries: 0 });
    const run = await client.run(row.run_id).get();
    if (!run || run.id !== row.run_id || run.actId !== APIFY_PROFILE_ACTOR_ID || run.status !== 'SUCCEEDED' || !run.defaultDatasetId) {
        throw new Error('CONCIERGE_PROVIDER_ARTIFACT_INVALID');
    }
    const page = await client.dataset(run.defaultDatasetId).listItems({ limit: 2 });
    const parsed = parseApifyProfileDataset(page.items, [order.targetUsername]);
    if (parsed.datasetContaminated || parsed.failuresByUsername.size > 0 || parsed.notFoundUsernames.size > 0) {
        throw new Error('CONCIERGE_PROVIDER_ARTIFACT_INVALID');
    }
    return parsed.profilesByUsername.get(order.targetUsername) ?? null;
}

function sourcePosts(profile: InstagramProfile): readonly InstagramPost[] {
    return profile.latestPosts ?? [];
}

async function collectOrder(
    order: OrderRow,
    prepared: ConciergeBatchPreparedOrder,
    context: ConciergeBatchStageContext,
): Promise<CollectedOrder> {
    const targetProfile = await (await loadTargetProfileArtifact(order))
        ?? await withProvider(prepared.sourceRequestId, context, async (slot, provider) => {
            const profile = await provider.getProfile?.(order.targetUsername, providerContext(prepared.sourceRequestId, slot));
            if (!profile) throw new Error('CONCIERGE_TARGET_PROFILE_UNAVAILABLE');
            return profile;
        });
    if (targetProfile.isPrivate) throw new Error('CONCIERGE_TARGET_PROFILE_PRIVATE');

    const plan = getAnalysisPlan(order.planId);
    const followersLimit = Math.min(
        plan.relationshipCapacity.followers,
        Math.max(targetProfile.followersCount, order.targetFollowers ?? 0),
    );
    const followingLimit = Math.min(
        plan.relationshipCapacity.following,
        Math.max(targetProfile.followingCount, order.targetFollowing ?? 0),
    );
    const [followers, following] = await Promise.all([
        withProvider(prepared.sourceRequestId, context, async (slot, provider) => {
            if (!provider.getFollowers) throw new Error('CONCIERGE_RELATIONSHIP_PROVIDER_UNAVAILABLE');
            return provider.getFollowers(
                order.targetUsername,
                followersLimit,
                providerContext(prepared.sourceRequestId, slot),
            );
        }),
        withProvider(prepared.sourceRequestId, context, async (slot, provider) => {
            if (!provider.getFollowing) throw new Error('CONCIERGE_RELATIONSHIP_PROVIDER_UNAVAILABLE');
            return provider.getFollowing(
                order.targetUsername,
                followingLimit,
                providerContext(prepared.sourceRequestId, slot),
            );
        }),
    ]);
    const followerByUsername = new Map(followers.map(row => [normalized(row.username), row]));
    const mutualRows = following.flatMap((row: InstagramFollower, index) => {
        const username = normalized(row.username);
        const follower = followerByUsername.get(username);
        if (!follower) return [];
        return [{
            username,
            fullName: row.fullName ?? follower.fullName ?? null,
            profilePicUrl: row.profilePicUrl ?? follower.profilePicUrl ?? null,
            isPrivate: row.isPrivate || follower.isPrivate,
            isVerified: row.isVerified || follower.isVerified,
            mutualOrdinal: index + 1,
        }];
    });
    const publicMutuals = mutualRows.filter(row => !row.isPrivate);
    const privateRows = mutualRows.filter(row => row.isPrivate);
    const selectedPublic = publicMutuals.slice(0, plan.detailedMutualLimit);
    const selectedNames = selectedPublic.map(row => row.username);
    const hydrated = new Map<string, InstagramProfile>();
    for (let index = 0; index < selectedNames.length; index += 30) {
        const batch = selectedNames.slice(index, index + 30);
        const outcomes = await withProvider(prepared.sourceRequestId, context, async (slot, provider) => {
            if (!provider.getProfilesBatchOutcomes) throw new Error('CONCIERGE_PROFILE_BATCH_UNAVAILABLE');
            return provider.getProfilesBatchOutcomes(
                batch,
                batch.length,
                providerContext(prepared.sourceRequestId, slot),
            );
        });
        for (const outcome of outcomes) {
            if (outcome.outcome.status === 'success' && 'profile' in outcome) {
                hydrated.set(normalized(outcome.profile.username), outcome.profile);
            }
        }
    }
    const publicProfiles = selectedPublic.flatMap(row => {
        const profile = hydrated.get(row.username);
        return profile ? [{ ordinal: row.mutualOrdinal, profile }] : [];
    });
    const publicUnavailableRows = selectedPublic.filter(row => !hydrated.has(row.username));
    const targetPosts = sourcePosts(targetProfile);
    let targetInteraction: ReturnType<typeof extractRawTargetInteractions> = {
        evidence: [], observedUsernames: [], likerCoverage: [], commentCoverage: [],
    };
    if (targetPosts.length > 0) {
        const likerPosts = selectRecentInteractionPosts([...targetPosts], 4);
        const commentPosts = selectRecentInteractionPosts([...targetPosts], 6);
        const [likers, comments] = await Promise.all([
            withInteractions(prepared.sourceRequestId, context, async (slot, adapter) => adapter.getPostLikers(
                likerPosts.map(instagramPostUrl), 150, providerContext(prepared.sourceRequestId, slot),
            )),
            withInteractions(prepared.sourceRequestId, context, async (slot, adapter) => adapter.getPostComments(
                commentPosts.map(instagramPostUrl), 15, providerContext(prepared.sourceRequestId, slot),
            )),
        ]);
        targetInteraction = extractRawTargetInteractions({
            targetPosts,
            likers,
            comments,
            excludedUsernames: [order.targetUsername],
        });
    }
    const hydratedNames = new Set(publicProfiles.map(item => normalized(item.profile.username)));
    const retainedTargetEvidence = targetInteraction.evidence.filter(row => hydratedNames.has(normalized(row.actorUsername)));
    const retainedObservedNames = [...new Set(retainedTargetEvidence.map(row => normalized(row.actorUsername)))];
    targetInteraction = {
        ...targetInteraction,
        evidence: retainedTargetEvidence,
        observedUsernames: retainedObservedNames,
    };
    const targetInputHash = hash({ target: targetProfile, targetPosts });
    const candidateInputHash = hash([...publicProfiles].map(item => item.profile));
    const reverseLikeInputHash = hash({ reverse: 'not_collected', usernames: selectedNames });
    const coverageHash = hash({ target: targetInteraction.likerCoverage, comments: targetInteraction.commentCoverage });
    const interaction = {
        targetToCandidate: {
            status: targetPosts.length > 0 ? 'collected' as const : 'not_collected' as const,
            evidence: targetInteraction.evidence,
            observedUsernames: targetInteraction.observedUsernames,
            likerCoverage: targetInteraction.likerCoverage,
            commentCoverage: targetInteraction.commentCoverage,
        },
        candidateToTarget: { status: 'not_collected' as const, evidence: [], coverage: [] },
        targetPosts,
        candidatePostsByUsername: new Map(publicProfiles.map(item => [item.profile.username, sourcePosts(item.profile)])),
        reverseLikeStatusByUsername: new Map(publicProfiles.map(item => [item.profile.username, 'not_collected' as const])),
        targetInputHash,
        candidateInputHash,
        reverseLikeInputHash,
        coverageHash,
    } satisfies ConciergeStoredReplayFeatures['bidirectionalInteractions'];
    const descriptorHash = hash({ orderId: order.orderId, preflightId: order.preflightId, target: order.targetUsername });
    const source = {
        descriptorHash,
        targetProfile,
        followersDeclared: Math.max(targetProfile.followersCount, followers.length),
        followersCollected: followers.length,
        followingDeclared: Math.max(targetProfile.followingCount, following.length),
        followingCollected: following.length,
        mutualRows,
        publicProfiles,
        publicUnavailableRows,
        privateRows,
        targetInteractions: targetInteraction.evidence,
    } satisfies import('@/lib/services/analysis/first-payment-concierge-source').FirstPaymentConciergeSource;
    const captured = await captureFirstPaymentConciergeAiBundle({ source });
    if (captured.mediaUnavailableOrdinals.length > 0) throw new Error('CONCIERGE_MEDIA_CAPTURE_INCOMPLETE');
    return { order, prepared, source, captured, interaction };
}

function pass(profile: InstagramProfile, evidenceHash: string) {
    const declared = Math.max(0, profile.postsCount);
    const collected = (profile.latestPosts ?? []).length;
    return {
        status: 'collected' as const,
        fullNamePresent: Boolean(profile.fullName),
        profilePicPresent: Boolean(profile.profilePicUrl),
        feedDeclared: declared,
        feedCollected: Math.min(declared, collected),
        completeMedia: true,
        evidenceHash: declared === 0 ? createConciergeZeroPostEvidenceHash() : evidenceHash,
        ...(declared === 0 ? { evidenceMarker: 'zero-post-complete-v1' as const } : {}),
    };
}

async function classifyOrder(collected: CollectedOrder): Promise<ClassifiedOrder> {
    const details: ReplayAccountAiDetail[] = [];
    await runAnalysisV2AiReplay({
        bundle: collected.captured.bundle,
        runner: createReplayStagedAiAdapter('ai-stage-policy-v2.11'),
        mode: 'paid-ai',
        paidAiOptIn: true,
        evaluationPolicy: firstPaymentConciergeEvaluationPolicy,
        onAccountAnalyzed(detail) { details.push(detail); },
    });
    const detailsByOrdinal = new Map(details.map(detail => [detail.ordinal, detail]));
    const publicByOrdinal = new Map(collected.source.publicProfiles.map(item => [item.ordinal, item.profile]));
    const records: ConciergeClassificationRecord[] = collected.source.mutualRows.map(row => {
        if (row.isPrivate) {
            return {
                candidateId: analysisV2CandidateId(row.username), instagramId: row.username,
                mutualOrdinal: row.mutualOrdinal, partition: 'private', profileFetchStatus: 'success',
                firstPass: { status: 'not_applicable', fullNamePresent: null, profilePicPresent: null, feedDeclared: null, feedCollected: null, completeMedia: null, evidenceHash: null },
                secondPass: { status: 'not_applicable', fullNamePresent: null, profilePicPresent: null, feedDeclared: null, feedCollected: null, completeMedia: null, evidenceHash: null },
                originalAiClassification: null, effectiveClassification: null, confidence: null, evidenceCoverage: null,
                classifier: null, modelName: null, promptVersion: null, schemaVersion: null, classificationOperationKey: null, classificationResultHash: null,
                classificationSource: 'not_applicable', manualOverride: null,
            };
        }
        const profile = publicByOrdinal.get(row.mutualOrdinal);
        const detail = detailsByOrdinal.get(row.mutualOrdinal);
        if (!profile || !detail) {
            const evidenceHash = hash({ row, status: 'unavailable' });
            return {
                candidateId: analysisV2CandidateId(row.username), instagramId: row.username,
                mutualOrdinal: row.mutualOrdinal, partition: 'unresolved', profileFetchStatus: 'unavailable',
                firstPass: { status: 'failed', fullNamePresent: null, profilePicPresent: null, feedDeclared: null, feedCollected: null, completeMedia: null, evidenceHash },
                secondPass: { status: 'failed', fullNamePresent: null, profilePicPresent: null, feedDeclared: null, feedCollected: null, completeMedia: null, evidenceHash },
                originalAiClassification: 'unknown', effectiveClassification: 'unknown', confidence: 'low', evidenceCoverage: null,
                classifier: 'gemini-v2.14', modelName: 'gemini-v2.14', promptVersion: 'ai-stage-policy-v2.11', schemaVersion: 'concierge-batch-v1',
                classificationOperationKey: `concierge:classification:${row.mutualOrdinal}`, classificationResultHash: hash({ row, status: 'unresolved' }),
                classificationSource: 'ai', manualOverride: null,
                sourceSnapshot: { instagramUrl: `https://instagram.com/${row.username}`, originalAiClassification: 'unknown', confidenceEvidence: 'confidence=low;evidence=unavailable', operatorNote: '' },
            };
        }
        const classification = detail.finalClassification === 'verified_female'
            ? 'female' as const
            : detail.finalClassification === 'verified_non_female' ? 'male' as const : 'unknown' as const;
        const confidence = detail.triage?.assessment.confidence ?? 'low';
        const evidenceHash = hash({ profile, detail });
        return {
            candidateId: analysisV2CandidateId(row.username), instagramId: row.username,
            mutualOrdinal: row.mutualOrdinal, partition: 'public', profileFetchStatus: 'success',
            firstPass: pass(profile, evidenceHash), secondPass: pass(profile, evidenceHash),
            originalAiClassification: classification, effectiveClassification: classification, confidence,
            evidenceCoverage: { declared: profile.postsCount, collected: (profile.latestPosts ?? []).length, selected: Math.min(8, (profile.latestPosts ?? []).length), complete: true, basisPoints: 10_000, hash: evidenceHash },
            classifier: 'gemini-v2.14', modelName: 'gemini-v2.14', promptVersion: 'ai-stage-policy-v2.11', schemaVersion: 'concierge-batch-v1',
            classificationOperationKey: `concierge:classification:${row.mutualOrdinal}`, classificationResultHash: hash({ row, detail }),
            classificationSource: 'ai', manualOverride: null,
            sourceSnapshot: { instagramUrl: `https://instagram.com/${row.username}`, originalAiClassification: classification, confidenceEvidence: `confidence=${confidence};evidence=gemini_v214`, operatorNote: '' },
        };
    });
    const publicRecords = records.filter(record => record.partition === 'public');
    const privateProfiles = collected.source.privateRows.map(row => ({
        username: row.username, isPrivate: true, fullName: row.fullName, profilePicUrl: row.profilePicUrl,
        followersCount: 0, followingCount: 0, postsCount: 0, latestPosts: [],
        isVerified: false,
    } as InstagramProfile));
    const privateNameResults = await analyzePrivateAccountNames(privateProfiles.map(profile => ({
        id: analysisV2CandidateId(profile.username), username: profile.username, fullName: profile.fullName ?? undefined,
    })));
    const relationshipResultHash = hash({ source: collected.source.mutualRows, followers: collected.source.followersCollected, following: collected.source.followingCollected });
    const ledger: ConciergeClassificationLedger = {
        revision: 1,
        relationshipResultHash,
        partitionHash: hash(records.map(record => ({ username: record.instagramId, partition: record.partition, ordinal: record.mutualOrdinal }))),
        mutualCount: records.length,
        hydratedPublicCount: publicRecords.length,
        hydratedPrivateCount: records.filter(record => record.partition === 'private').length,
        unresolvedCount: records.filter(record => record.partition === 'unresolved').length,
        records,
    };
    createConciergeClassificationLedgerHash(ledger);
    const manualImport = parseConciergeClassificationCsv(
        EMPTY_MANUAL_CSV,
        collected.order.orderId,
        collected.prepared.requestId,
        relationshipResultHash,
        hash('concierge-batch-service-role'),
        new Date().toISOString(),
    );
    const classificationByOrdinal = new Map(records
        .filter(record => record.partition !== 'private')
        .map(record => [record.mutualOrdinal, {
            originalAiClassification: record.originalAiClassification!,
            confidence: record.confidence!, classifier: record.classifier!, modelName: record.modelName!, promptVersion: record.promptVersion!, schemaVersion: record.schemaVersion!,
            classificationOperationKey: record.classificationOperationKey!, classificationResultHash: record.classificationResultHash!, secondPassStatus: record.secondPass.status, secondPassCompleteMedia: record.secondPass.completeMedia,
        }]));
    const replay: ConciergeStoredReplayFeatures = {
        profilesByOrdinal: new Map(collected.source.publicProfiles.flatMap(item => detailsByOrdinal.has(item.ordinal) ? [[item.ordinal, item.profile] as const] : [])),
        details,
        orderedMutualUsernames: collected.source.mutualRows.map(row => row.username),
        targetInteractions: collected.source.targetInteractions,
        bidirectionalInteractions: collected.interaction,
        classificationByOrdinal,
        privateProfiles,
        privateNameResults,
        fetchedCount: records.length,
        hydratedPublicCount: publicRecords.length,
        hydratedPrivateCount: privateProfiles.length,
        analyzedPublicCount: details.length,
        unresolvedCount: ledger.unresolvedCount,
    };
    const input: ConciergeManualPublicationInput = {
        orderId: collected.order.orderId,
        requestId: collected.prepared.requestId,
        resultRequestId: collected.prepared.requestId,
        ownerId: collected.order.ownerId,
        targetUsername: collected.order.targetUsername,
        targetInputHash: hash({ target: collected.source.targetProfile, order: collected.order.orderId }),
        sourceRequestId: collected.prepared.sourceRequestId,
        replayLineageHash: hash({ descriptorHash: collected.source.descriptorHash, semantic: collected.captured.bundle.capture }),
        relationshipManifestHash: relationshipResultHash,
        expectedMutualCount: records.length,
        expectedHydratedCount: publicRecords.length + privateProfiles.length,
        expectedVersion: 0,
        expectedResultHash: null,
        currentPublication: { version: 0, resultHash: null, resultUrl: `/result/${collected.prepared.requestId}` },
        ledger,
        manualImport,
        replay,
    };
    return { input };
}

async function loadCohort(): Promise<OrderRow[]> {
    const [{ data: orders, error: orderError }, { data: fulfillments, error: fulfillmentError }] = await Promise.all([
        supabaseAdmin.from('earlybird_orders').select('id,user_id,preflight_id,target_instagram_id,plan_id,status,result_request_id,target_followers_count,target_following_count'),
        supabaseAdmin.from('earlybird_fulfillments').select('order_id,status'),
    ]);
    if (orderError || fulfillmentError) throw new Error('CONCIERGE_COHORT_READ_FAILED');
    const fulfillmentByOrder = new Map((fulfillments ?? []).map(row => [String(row.order_id), String(row.status)]));
    const candidates = (orders ?? []).filter(row => (
        ['paid', 'analysis_in_progress'].includes(String(row.status))
        && fulfillmentByOrder.has(String(row.id))
    ));
    const requestIds = candidates.flatMap(row => typeof row.result_request_id === 'string' ? [row.result_request_id] : []);
    const { data: requests, error: requestError } = requestIds.length > 0
        ? await supabaseAdmin.from('analysis_requests').select('id,status').in('id', requestIds)
        : { data: [], error: null };
    if (requestError) throw new Error('CONCIERGE_COHORT_REQUEST_READ_FAILED');
    const requestStatus = new Map((requests ?? []).map(row => [String(row.id), String(row.status)]));
    const selected = candidates.flatMap(row => {
        const fulfillment = fulfillmentByOrder.get(String(row.id));
        const awaiting = row.status === 'paid' && fulfillment === 'awaiting_operator';
        const canary = row.status === 'analysis_in_progress' && fulfillment === 'analysis_in_progress'
            && typeof row.result_request_id === 'string' && requestStatus.get(row.result_request_id) === 'failed';
        if (!awaiting && !canary) return [];
        const targetUsername = normalized(String(row.target_instagram_id));
        const planId: OrderRow['planId'] | null = row.plan_id === 'standard' ? 'standard' : row.plan_id === 'basic' ? 'basic' : null;
        if (!planId || !ORDER_ID.safeParse(row.id).success || !ORDER_ID.safeParse(row.user_id).success || !ORDER_ID.safeParse(row.preflight_id).success) throw new Error('CONCIERGE_COHORT_SCOPE_CONFLICT');
        return [{
            orderId: String(row.id), ownerId: String(row.user_id), targetUsername, planId,
            cohort: canary ? 'failed_canary' as const : 'awaiting_operator' as const,
            preflightId: String(row.preflight_id),
            targetFollowers: typeof row.target_followers_count === 'number' ? row.target_followers_count : null,
            targetFollowing: typeof row.target_following_count === 'number' ? row.target_following_count : null,
        }];
    });
    if (selected.length !== 30 || selected.filter(row => row.cohort === 'awaiting_operator').length !== 27 || selected.filter(row => row.cohort === 'failed_canary').length !== 3) throw new Error('CONCIERGE_COHORT_COUNT_CONFLICT');
    return selected;
}

async function main(): Promise<void> {
    const cohort = await loadCohort();
    const bootstrap = {
        async prepare(order: ConciergeBatchOrder) {
            const row = cohort.find(candidate => candidate.orderId === order.orderId)!;
            const response = await supabaseAdmin.rpc('prepare_concierge_batch_order', { p_order_id: row.orderId });
            if (response.error || !response.data || typeof response.data !== 'object') throw new Error('CONCIERGE_BATCH_BOOTSTRAP_FAILED');
            const value = response.data as Record<string, unknown>;
            if (value.orderId !== row.orderId || value.ownerId !== row.ownerId || value.targetUsername !== row.targetUsername || value.planId !== row.planId) throw new Error('CONCIERGE_BATCH_BOOTSTRAP_SCOPE_CONFLICT');
            return { sourceRequestId: String(value.sourceRequestId), requestId: String(value.requestId), preflightId: typeof value.preflightId === 'string' ? value.preflightId : null };
        },
    };
    const casPublish = createConciergeBatchCasPublisher();
    const result = await runConciergeBatch(cohort, {
        prepare: bootstrap.prepare,
        async collect(order, context, prepared) {
            if (!prepared) throw new Error('CONCIERGE_BATCH_BOOTSTRAP_REQUIRED');
            return collectOrder(cohort.find(candidate => candidate.orderId === order.orderId)!, prepared, context);
        },
        async classify(collected) { return classifyOrder(collected); },
        async publish(classified) {
            await casPublish(classified.input);
            return { status: 'completed' as const };
        },
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(() => {
        process.stderr.write('{"status":"failed","code":"CONCIERGE_BATCH_FAILED"}\n');
        process.exitCode = 1;
    });
}
