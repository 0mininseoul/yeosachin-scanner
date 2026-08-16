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
    assertConciergeRelationshipCoverage,
    isConciergeBatchRelationshipCoverageError,
    runConciergeBatch,
    selectConciergeBatchRetryOrders,
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
const APPROVED_SLOTS = ['septenary', 'secondary', 'quinary', 'primary'] as const;
type ApprovedSlot = typeof APPROVED_SLOTS[number];
const EMPTY_MANUAL_CSV = 'username,instagram_url,ai_classification,ai_confidence/evidence_status,manual_gender,operator_note\n';
const RETRY_CODE_PATTERN = /^CONCIERGE_[A-Z0-9_]{2,100}$/;
const PROTECTED_RETRY_CODES = new Set([
    'CONCIERGE_PROVIDER_ARTIFACT_INVALID',
    'CONCIERGE_TARGET_PROFILE_PRIVATE',
]);

type OrderRow = ConciergeBatchOrder & {
    preflightId: string;
    targetFollowers: number | null;
    targetFollowing: number | null;
    retryCode?: string | null;
};

type FrozenCohort = {
    manifestHash: string;
    total: number;
    published: number;
    running: number;
    excluded: number;
    orders: OrderRow[];
    evidenceHashByOrder: ReadonlyMap<string, string>;
};

const frozenCohortMemberSchema = z.object({
    orderId: ORDER_ID,
    ownerId: ORDER_ID,
    targetUsername: USERNAME,
    planId: z.enum(['basic', 'standard']),
    cohort: z.enum(['awaiting_operator', 'failed_canary']),
    preflightId: ORDER_ID,
    originalResultRequestId: ORDER_ID.nullable(),
    targetFollowersCount: z.number().int().min(0).max(10_000_000),
    targetFollowingCount: z.number().int().min(0).max(10_000_000),
    snapshotOrderStatus: z.enum(['paid', 'analysis_in_progress']),
    snapshotFulfillmentStatus: z.enum(['awaiting_operator', 'analysis_in_progress']),
    snapshotRequestStatus: z.literal('failed').nullable(),
    snapshotErrorCode: z.enum([
        'SCRAPING_INCOMPLETE_ERROR',
        'SCRAPING_PROVIDER_QUOTA_ERROR',
        'SCRAPING_PROVIDER_START_REJECTED_ERROR',
        'ANALYSIS_V2_JOB_HANDLER_FAILED',
        'ANALYSIS_V2_STAGE_SCHEMA_VALIDATION_ERROR',
    ]).nullable(),
    paymentIdFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    expectedAmountKrw: z.number().int().positive(),
    expectedProductId: z.string().min(1),
    actualAmountKrw: z.number().int().nullable(),
    actualProductId: z.string().nullable(),
    paidAt: z.string().min(1),
    evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
    frozenAt: z.string().min(1),
    currentOrderStatus: z.enum([
        'paid', 'analysis_in_progress', 'completed', 'cancelled', 'refund_pending',
        'refunded', 'payment_failed', 'overflow_refund_required',
    ]),
    currentFulfillmentStatus: z.string().min(1),
    currentRequestStatus: z.enum(['pending', 'processing', 'completed', 'failed']).nullable(),
    published: z.boolean(),
}).strict();

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
    return isConciergeBatchRelationshipCoverageError(error)
        || message.includes('SCRAPING_PROVIDER_QUOTA_ERROR')
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
    const { data, error } = await supabaseAdmin.rpc(
        'list_concierge_batch_target_profile_artifacts',
        { p_preflight_id: order.preflightId },
    );
    if (error || !Array.isArray(data)) throw new Error('CONCIERGE_PROVIDER_ARTIFACT_LOOKUP_FAILED');
    const rows = data as ProviderRunRow[];
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
            const followers = await provider.getFollowers(
                order.targetUsername,
                followersLimit,
                providerContext(prepared.sourceRequestId, slot),
            );
            assertConciergeRelationshipCoverage('followers', followersLimit, followers.length);
            return followers;
        }),
        withProvider(prepared.sourceRequestId, context, async (slot, provider) => {
            if (!provider.getFollowing) throw new Error('CONCIERGE_RELATIONSHIP_PROVIDER_UNAVAILABLE');
            const following = await provider.getFollowing(
                order.targetUsername,
                followingLimit,
                providerContext(prepared.sourceRequestId, slot),
            );
            assertConciergeRelationshipCoverage('following', followingLimit, following.length);
            return following;
        }),
    ]);
    assertConciergeRelationshipCoverage('followers', followersLimit, followers.length);
    assertConciergeRelationshipCoverage('following', followingLimit, following.length);
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
        if (!profile) return [];
        // Relationship rows are an already-collected authoritative source for
        // the display name. Retain it when profile hydration omits the same
        // non-sensitive field so sparse concierge copy can stay evidence-bound
        // without recollecting the profile.
        const fullName = profile.fullName ?? row.fullName ?? undefined;
        return [{
            ordinal: row.mutualOrdinal,
            profile: fullName === undefined ? profile : { ...profile, fullName },
        }];
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
    // The replay bundle intentionally records media-terminal ordinals. They
    // remain unresolved in the concierge ledger; rejecting the whole order
    // here would discard valid relationship/profile artifacts.
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
    // A resolver can legally verify gender after feature analysis is
    // unavailable. Concierge scoring still needs a feature bundle, so retain
    // those accounts as unresolved instead of treating them as publishable
    // female rows.
    const replayDetails = details.filter(detail => detail.feature !== null);
    const replayDetailsByOrdinal = new Map(replayDetails.map(detail => [detail.ordinal, detail]));
    const publicByOrdinal = new Map(collected.source.publicProfiles.map(item => [item.ordinal, item.profile]));
    const replayPublicNames = new Set(
        [...replayDetailsByOrdinal.keys()]
            .map(ordinal => publicByOrdinal.get(ordinal)?.username)
            .filter((username): username is string => typeof username === 'string')
            .map(normalized),
    );
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
        if (!profile || !detail || !detail.feature) {
            const evidenceHash = hash({
                row,
                status: profile && detail ? 'feature_unavailable' : 'unavailable',
            });
            return {
                candidateId: analysisV2CandidateId(row.username), instagramId: row.username,
                mutualOrdinal: row.mutualOrdinal, partition: 'unresolved', profileFetchStatus: 'unavailable',
                firstPass: { status: 'failed', fullNamePresent: null, profilePicPresent: null, feedDeclared: null, feedCollected: null, completeMedia: null, evidenceHash },
                secondPass: { status: 'failed', fullNamePresent: null, profilePicPresent: null, feedDeclared: null, feedCollected: null, completeMedia: null, evidenceHash },
                originalAiClassification: 'unknown', effectiveClassification: 'unknown', confidence: 'low',
                evidenceCoverage: { declared: 0, collected: 0, selected: 0, complete: false, basisPoints: 0, hash: evidenceHash },
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
        id: normalized(profile.username), username: profile.username, fullName: profile.fullName ?? undefined,
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
        profilesByOrdinal: new Map(collected.source.publicProfiles.flatMap(item => replayDetailsByOrdinal.has(item.ordinal) ? [[item.ordinal, item.profile] as const] : [])),
        details: replayDetails,
        orderedMutualUsernames: collected.source.mutualRows.map(row => row.username),
        targetInteractions: collected.source.targetInteractions,
        bidirectionalInteractions: {
            ...collected.interaction,
            targetToCandidate: {
                ...collected.interaction.targetToCandidate,
                evidence: collected.interaction.targetToCandidate.evidence
                    .filter(row => replayPublicNames.has(normalized(row.actorUsername))),
                observedUsernames: collected.interaction.targetToCandidate.observedUsernames
                    .filter(username => replayPublicNames.has(normalized(username))),
            },
            candidatePostsByUsername: new Map(
                [...collected.interaction.candidatePostsByUsername.entries()]
                    .filter(([username]) => replayPublicNames.has(normalized(username))),
            ),
            reverseLikeStatusByUsername: new Map(
                [...collected.interaction.reverseLikeStatusByUsername.entries()]
                    .filter(([username]) => replayPublicNames.has(normalized(username))),
            ),
        },
        classificationByOrdinal,
        privateProfiles,
        privateNameResults,
        fetchedCount: records.length,
        hydratedPublicCount: publicRecords.length,
        hydratedPrivateCount: privateProfiles.length,
        analyzedPublicCount: replayDetails.length,
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

function retryCodeAllowlist(): ReadonlySet<string> {
    const raw = process.env.CONCIERGE_BATCH_RETRY_CODES?.trim();
    if (!raw) throw new Error('CONCIERGE_BATCH_RETRY_ALLOWLIST_REQUIRED');
    const values = [...new Set(raw.split(',').map(value => value.trim()).filter(Boolean))];
    if (values.length === 0 || values.some(value => (
        !RETRY_CODE_PATTERN.test(value) || PROTECTED_RETRY_CODES.has(value)
    ))) {
        throw new Error('CONCIERGE_BATCH_RETRY_ALLOWLIST_INVALID');
    }
    return new Set(values);
}

type ConciergeRetryRequestRow = {
    id: string;
    status: string;
    error_message: string | null;
    step_data: unknown;
};

async function loadRetryCodeByOrder(
    orderIds: readonly string[],
): Promise<ReadonlyMap<string, string | null>> {
    const { data: orderRows, error: orderError } = await supabaseAdmin
        .from('earlybird_orders')
        .select('id,result_request_id')
        .in('id', [...orderIds]);
    if (orderError || !Array.isArray(orderRows) || orderRows.length !== orderIds.length) {
        throw new Error('CONCIERGE_BATCH_RETRY_STATE_LOOKUP_FAILED');
    }
    const requestIdByOrder = new Map<string, string | null>(
        orderRows.map(row => [String(row.id), typeof row.result_request_id === 'string' ? row.result_request_id : null]),
    );
    const requestIds = [...new Set(
        orderRows
            .map(row => row.result_request_id)
            .filter((value): value is string => typeof value === 'string'),
    )];
    const requestById = new Map<string, ConciergeRetryRequestRow>();
    if (requestIds.length > 0) {
        const { data: requests, error: requestError } = await supabaseAdmin
            .from('analysis_requests')
            .select('id,status,error_message,step_data')
            .in('id', requestIds);
        if (requestError || !Array.isArray(requests) || requests.length !== requestIds.length) {
            throw new Error('CONCIERGE_BATCH_RETRY_STATE_LOOKUP_FAILED');
        }
        for (const request of requests as ConciergeRetryRequestRow[]) {
            requestById.set(request.id, request);
        }
    }
    const result = new Map<string, string | null>();
    for (const orderId of orderIds) {
        const requestId = requestIdByOrder.get(orderId);
        const request = requestId ? requestById.get(requestId) : undefined;
        const stepData = request?.step_data;
        const retry = stepData && typeof stepData === 'object' && !Array.isArray(stepData)
            ? (stepData as Record<string, unknown>).conciergeBatchRetry
            : null;
        const code = retry && typeof retry === 'object' && !Array.isArray(retry)
            && (retry as Record<string, unknown>).eligible === true
            && typeof (retry as Record<string, unknown>).code === 'string'
            && RETRY_CODE_PATTERN.test((retry as Record<string, unknown>).code as string)
            && request?.status === 'failed'
            && request.error_message === 'CONCIERGE_BATCH_RETRYABLE'
            ? (retry as Record<string, unknown>).code as string
            : null;
        result.set(orderId, code);
    }
    return result;
}

async function loadCohort(): Promise<FrozenCohort> {
    const expectedManifestHash = process.env.CONCIERGE_BATCH_EXPECTED_MANIFEST_HASH?.trim();
    if (!expectedManifestHash || !/^[a-f0-9]{64}$/.test(expectedManifestHash)) {
        throw new Error('CONCIERGE_COHORT_EXPECTED_HASH_REQUIRED');
    }
    const { data, error } = await supabaseAdmin.rpc('freeze_concierge_batch_cohort', {
        p_expected_manifest_hash: expectedManifestHash,
    });
    if (error || !data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('CONCIERGE_COHORT_FREEZE_FAILED');
    }
    const root = data as Record<string, unknown>;
    if (root.cohortKey !== 'concierge-fallback-20260816'
        || typeof root.manifestHash !== 'string'
        || !/^[a-f0-9]{64}$/.test(root.manifestHash)
        || !Array.isArray(root.members)
        || root.members.length !== 30) {
        throw new Error('CONCIERGE_COHORT_MANIFEST_INVALID');
    }
    const members = root.members.map(member => frozenCohortMemberSchema.parse(member));
    const hashes = new Set(members.map(member => member.manifestHash));
    if (hashes.size !== 1 || [...hashes][0] !== root.manifestHash
        || new Set(members.map(member => member.orderId)).size !== 30
        || members.filter(member => member.cohort === 'awaiting_operator').length !== 27
        || members.filter(member => member.cohort === 'failed_canary').length !== 3) {
        throw new Error('CONCIERGE_COHORT_MANIFEST_INVALID');
    }
    const allowlist = retryCodeAllowlist();
    const retryCodeByOrder = await loadRetryCodeByOrder(members.map(member => member.orderId));
    let published = 0;
    let running = 0;
    let terminalExcluded = 0;
    const candidateOrders: OrderRow[] = [];
    for (const member of members) {
        if (['cancelled', 'refund_pending', 'refunded', 'payment_failed', 'overflow_refund_required'].includes(member.currentOrderStatus)) {
            // Payment-terminal rows are permanently out of scope. Read the
            // live snapshot and exclude them before any bootstrap/provider
            // call; never reverse or reinterpret a refund/payment guard.
            terminalExcluded += 1;
            continue;
        }
        if (member.published) {
            published += 1;
            continue;
        }
        if (member.currentRequestStatus === 'processing') {
            running += 1;
            continue;
        }
        if (member.currentOrderStatus === 'completed') {
            throw new Error('CONCIERGE_COHORT_PUBLICATION_STATE_CONFLICT');
        }
        if (member.currentRequestStatus !== null
            && member.currentRequestStatus !== 'pending'
            && member.currentRequestStatus !== 'failed') {
            throw new Error('CONCIERGE_COHORT_RETRY_STATE_CONFLICT');
        }
        candidateOrders.push({
            orderId: member.orderId,
            ownerId: member.ownerId,
            targetUsername: member.targetUsername,
            planId: member.planId,
            cohort: member.cohort,
            preflightId: member.preflightId,
            targetFollowers: member.targetFollowersCount,
            targetFollowing: member.targetFollowingCount,
            retryCode: retryCodeByOrder.get(member.orderId) ?? null,
        });
    }
    const orders = selectConciergeBatchRetryOrders(candidateOrders, allowlist);
    if (orders.length === 0) throw new Error('CONCIERGE_BATCH_RETRY_SUBSET_EMPTY');
    return {
        manifestHash: root.manifestHash,
        total: members.length,
        published,
        running,
        excluded: terminalExcluded + candidateOrders.length - orders.length,
        orders,
        evidenceHashByOrder: new Map(members.map(member => [member.orderId, member.evidenceHash])),
    };
}

function retryableFailureCode(error: unknown): string {
    const message = error instanceof Error ? error.message : '';
    const candidate = message.match(/^[A-Z][A-Z0-9_]{2,100}/)?.[0];
    return candidate && candidate.startsWith('CONCIERGE_')
        ? candidate
        : 'CONCIERGE_BATCH_RETRYABLE';
}

async function main(): Promise<void> {
    const frozen = await loadCohort();
    if (process.env.CONCIERGE_BATCH_DRY_RUN === 'true') {
        process.stdout.write(`${JSON.stringify({
            status: 'dry_run',
            total: frozen.total,
            eligible: frozen.orders.length,
            published: frozen.published,
            running: frozen.running,
            excluded: frozen.excluded,
        })}\n`);
        return;
    }
    const cohort = frozen.orders;
    const preparedByOrder = new Map<string, ConciergeBatchPreparedOrder>();
    const bootstrap = {
        async prepare(order: ConciergeBatchOrder) {
            const row = cohort.find(candidate => candidate.orderId === order.orderId)!;
            if (!row) throw new Error('CONCIERGE_BATCH_SCOPE_CONFLICT');
            const response = await supabaseAdmin.rpc('prepare_concierge_batch_order', { p_order_id: row.orderId });
            if (response.error || !response.data || typeof response.data !== 'object') throw new Error('CONCIERGE_BATCH_BOOTSTRAP_FAILED');
            const value = response.data as Record<string, unknown>;
            if (value.orderId !== row.orderId
                || value.ownerId !== row.ownerId
                || value.targetUsername !== row.targetUsername
                || value.planId !== row.planId
                || value.manifestHash !== frozen.manifestHash
                || value.evidenceHash !== frozen.evidenceHashByOrder.get(row.orderId)) {
                throw new Error('CONCIERGE_BATCH_BOOTSTRAP_SCOPE_CONFLICT');
            }
            const prepared = {
                sourceRequestId: String(value.sourceRequestId),
                requestId: String(value.requestId),
                preflightId: typeof value.preflightId === 'string' ? value.preflightId : null,
            } satisfies ConciergeBatchPreparedOrder;
            preparedByOrder.set(row.orderId, prepared);
            return prepared;
        },
    };
    const casPublish = createConciergeBatchCasPublisher();
    const result = await runConciergeBatch(cohort, {
        prepare: bootstrap.prepare,
        async collect(order, context, prepared) {
            if (!prepared) throw new Error('CONCIERGE_BATCH_BOOTSTRAP_REQUIRED');
            const row = cohort.find(candidate => candidate.orderId === order.orderId);
            if (!row) throw new Error('CONCIERGE_BATCH_SCOPE_CONFLICT');
            return collectOrder(row, prepared, context);
        },
        async classify(collected) { return classifyOrder(collected); },
        async publish(classified) {
            await casPublish(classified.input);
            return { status: 'completed' as const };
        },
        async onFailure(order, error) {
            const prepared = preparedByOrder.get(order.orderId);
            if (!prepared) return;
            const { data: current, error: readError } = await supabaseAdmin
                .from('analysis_requests')
                .select('status,step_data')
                .eq('id', prepared.requestId)
                .maybeSingle();
            if (readError || !current || !['pending', 'processing', 'failed'].includes(String(current.status))) {
                throw new Error('CONCIERGE_BATCH_FAILURE_NOT_DURABLE');
            }
            const existingStepData = current.step_data && typeof current.step_data === 'object' && !Array.isArray(current.step_data)
                ? current.step_data as Record<string, unknown>
                : {};
            const { data: updated, error: updateError } = await supabaseAdmin
                .from('analysis_requests')
                .update({
                    status: 'failed',
                    progress: 100,
                    progress_step: 'concierge batch retryable failure',
                    current_step: 'failed',
                    error_message: 'CONCIERGE_BATCH_RETRYABLE',
                    completed_at: null,
                    step_data: {
                        ...existingStepData,
                        conciergeBatchRetry: {
                            eligible: true,
                            code: retryableFailureCode(error),
                            recordedAt: new Date().toISOString(),
                        },
                    },
                })
                .eq('id', prepared.requestId)
                .in('status', ['pending', 'processing', 'failed'])
                .select('id,status')
                .maybeSingle();
            if (updateError || !updated || updated.status !== 'failed') {
                throw new Error('CONCIERGE_BATCH_FAILURE_NOT_DURABLE');
            }
        },
    });
    process.stdout.write(`${JSON.stringify({
        status: result.failed === 0 && frozen.running === 0 ? 'completed' : 'partial',
        total: frozen.total,
        attempted: result.total,
        completed: frozen.published + result.completed,
        failed: result.failed,
        running: frozen.running,
        excluded: frozen.excluded,
    })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(() => {
        process.stderr.write('{"status":"failed","code":"CONCIERGE_BATCH_FAILED"}\n');
        process.exitCode = 1;
    });
}
