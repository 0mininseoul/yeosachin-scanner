import { createHash } from 'node:crypto';
import { getAnalysisPlan } from '@/lib/domain/analysis/plan-catalog';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type {
    ProfileAttemptResult,
    ProviderCallContext,
    ProviderRunCheckpoint,
    SelfHostedAuthRunReceipt,
} from '@/lib/services/instagram/providers/types';
import {
    APIFY_COMMENTS_ACTOR_ID,
    APIFY_LIKERS_ACTOR_ID,
    apifyInteractionAdapter,
    type ApifyInteractionAdapter,
    type ApifyPostComment,
    type ApifyPostLiker,
} from '@/lib/services/instagram/providers/apify-interactions';
import {
    isApifyQueuedStartCancellation,
} from '@/lib/services/instagram/providers/apify-relationship';
import { selfHostedAuthInteractionAdapter } from '@/lib/services/instagram/providers/selfhosted-auth';
import {
    parseSelfHostedAuthCommentItems,
    parseSelfHostedAuthLikerItems,
    parseSelfHostedAuthRelationshipItems,
} from '@/lib/services/instagram/providers/selfhosted-auth/client';
import { APIFY_RELATIONSHIP_ACTOR_ID } from '@/lib/services/instagram/providers/apify';
import { REPLACEMENT_PROFILE_ACTOR } from '@/lib/services/instagram/providers/apify-profile-details';
import {
    getFollowers,
    getFollowing,
    getProfilesBatchV2,
    type ProfilesBatchV2AttemptSnapshot,
} from '@/lib/services/instagram/scraper';
import {
    assertAnalysisV2FreshProvenanceConfiguration,
    getAnalysisV2PaidCollectionProvider,
} from '@/lib/services/instagram/config';
import type { InstagramFollower, InstagramPost, InstagramProfile } from '@/lib/types/instagram';
import { instagramPostUrl, selectRecentInteractionPosts } from './interaction-posts';
import {
    ANALYSIS_V2_PROFILE_BATCH_LIMIT,
    ANALYSIS_V2_PRIVATE_NAME_BATCH_LIMIT,
    type AnalysisV2DagBatchManifest,
} from './v2-dag-planner';
import { ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY } from './v2-coordinator';
import {
    analysisV2EvidenceStore,
    createAnalysisV2RelationshipNotApplicableInputHash,
    type AnalysisV2EvidenceStore,
    type AnalysisV2RelationshipRowInput,
    type AnalysisV2TargetEvidenceSourceInput,
} from './v2-evidence-store';
import {
    analysisV2ProfileFetchCheckpointStore,
    deriveRepairUsernames,
    type AnalysisV2CheckpointProfile,
    type AnalysisV2CheckpointResult,
    type AnalysisV2ProfileAttemptResultInput,
    type AnalysisV2ProfileFetchCheckpointIdentity,
    type AnalysisV2ProfileFetchCheckpointStore,
    type AnalysisV2ProfileFetchResume,
} from './v2-profile-fetch-store';
import { selectAnalysisV2ProgressCandidateMedia } from './progress-candidate-media';
import {
    runAnalysisV2ProfileRepair,
    profileRepairIdentity,
    profileRepairMaximumCharge,
} from './v2-profile-repair';
import {
    analysisV2ProviderRunStore,
    createAnalysisV2ProviderInputHash,
    createAnalysisV2ProviderOperationKey,
    type AnalysisV2ProviderRunStore,
    type StoredAnalysisV2ProviderRun,
} from './v2-provider-run-store';
import {
    analysisV2ProviderRunAdoptionStore,
    bindAdoptedProviderRunOrFallback,
    type AnalysisV2ProviderRunAdoptionStore,
} from './v2-provider-run-adoption-store';
import {
    analysisV2CollectionRequestContextStore,
    type AnalysisV2CollectionJobClaim,
    type AnalysisV2CollectionRequestContext,
    type AnalysisV2CollectionRequestContextStore,
} from './v2-request-context';
import {
    canonicalProviderInput,
    lengthPrefixed,
} from './v2-provider-identity';
import {
    ANALYSIS_V2_TARGET_COMMENT_LIMIT as TARGET_COMMENT_LIMIT,
    ANALYSIS_V2_TARGET_COMMENT_POST_LIMIT as TARGET_COMMENT_POST_LIMIT,
    ANALYSIS_V2_TARGET_LIKER_LIMIT as TARGET_LIKER_LIMIT,
    ANALYSIS_V2_TARGET_LIKER_POST_LIMIT as TARGET_LIKER_POST_LIMIT,
    interactionMaximumCharge,
    profileMaximumCharge,
    relationshipMaximumCharge,
} from './v2-apify-operation-costs';
export {
    interactionMaximumCharge,
    profileMaximumCharge,
    relationshipMaximumCharge,
} from './v2-apify-operation-costs';
import { extractRawTargetInteractions } from './v2-target-interactions';
import {
    analysisV2TargetProfileReuseStore,
    type AnalysisV2TargetProfileReuseStore,
} from './v2-target-profile-reuse';
import type {
    AnalysisV2StageExecutor,
    AnalysisV2StageExecutorRegistry,
} from './v2-worker';
import {
    resolveAnalysisV2ApifyProviderBinding,
    type ProviderPolicyOperationKind,
} from './authorized-test-provider-policy';
import {
    analysisV2SelfHostedAuthRunStore,
    createAnalysisV2SelfHostedAuthWorkerIdentity,
    type AnalysisV2SelfHostedAuthRunStore,
} from './v2-selfhosted-auth-run-store';
import { GENDER_ROUTING_CAPS, GenderRoutingError } from './gender-routing';
import {
    analysisV2GenderRoutingManifestStore,
    type AnalysisV2GenderRoutingManifestStore,
} from './gender-routing-manifest-store';
import {
    routeAndPersistRevenueGenderCandidates,
    usesRevenueGenderRouting,
    type RevenueGenderRoutingInputPreparer,
} from './revenue-routing-runtime';
import type {
    RevenueGenderRoutingAssessor,
    RevenueGenderRoutingAssessorFactory,
} from './revenue-gender-routing-assessor';
import { RevenueCostOperationStore } from './revenue-cost-operation-store';
import {
    analysisRevenueFreshProvenanceStore,
    type FreshProvenanceStore,
} from './fresh-provenance-store';
import {
    withAnalysisProviderAdmissionCheckpoint,
} from './provider-admission-checkpoint';
import type { AnalysisProviderAdmissionStore } from './provider-admission-store';

const PROFILE_ACTOR_ID = 'apify/instagram-profile-scraper';
const analysisV2RevenueCostOperationStore = new RevenueCostOperationStore(supabaseAdmin);

type RelationshipGetter = typeof getFollowers;
type ProfileBatchFetcher = typeof getProfilesBatchV2;
type ProfileRepairRunner = typeof runAnalysisV2ProfileRepair;
export interface AnalysisV2CollectionExecutorDependencies {
    requestContextStore?: AnalysisV2CollectionRequestContextStore;
    evidenceStore?: AnalysisV2EvidenceStore;
    profileCheckpointStore?: AnalysisV2ProfileFetchCheckpointStore;
    providerRunStore?: AnalysisV2ProviderRunStore;
    providerAdmissionStore?: AnalysisProviderAdmissionStore;
    revenueCostOperationStore?: RevenueCostOperationStore;
    freshProvenanceStore?: FreshProvenanceStore;
    providerRunAdoptionStore?: AnalysisV2ProviderRunAdoptionStore;
    selfHostedAuthRunStore?: AnalysisV2SelfHostedAuthRunStore;
    targetProfileReuseStore?: AnalysisV2TargetProfileReuseStore;
    getFollowers?: RelationshipGetter;
    getFollowing?: RelationshipGetter;
    getProfilesBatchV2?: ProfileBatchFetcher;
    runProfileRepair?: ProfileRepairRunner;
    interactionAdapter?: ApifyInteractionAdapter;
    selfHostedAuthInteractionAdapter?: ApifyInteractionAdapter;
    genderRoutingManifestStore?: AnalysisV2GenderRoutingManifestStore;
    revenueGenderRoutingInputPreparer?: RevenueGenderRoutingInputPreparer;
    /** Created only after the strict request/job lineage is proven in the relationships executor. */
    revenueGenderRoutingAssessorFactory?: RevenueGenderRoutingAssessorFactory;
    revenueGenderRoutingAssessor?: RevenueGenderRoutingAssessor;
    env?: Record<string, string | undefined>;
}

interface ResolvedDependencies {
    requestContextStore: AnalysisV2CollectionRequestContextStore;
    evidenceStore: AnalysisV2EvidenceStore;
    profileCheckpointStore: AnalysisV2ProfileFetchCheckpointStore;
    providerRunStore: AnalysisV2ProviderRunStore;
    providerAdmissionStore?: AnalysisProviderAdmissionStore;
    revenueCostOperationStore: RevenueCostOperationStore;
    /** Deliberately absent for normal/Plus production requests. */
    freshProvenanceStore?: FreshProvenanceStore;
    providerRunAdoptionStore: AnalysisV2ProviderRunAdoptionStore | null;
    selfHostedAuthRunStore: AnalysisV2SelfHostedAuthRunStore;
    targetProfileReuseStore: AnalysisV2TargetProfileReuseStore;
    getFollowers: RelationshipGetter;
    getFollowing: RelationshipGetter;
    getProfilesBatchV2: ProfileBatchFetcher;
    runProfileRepair: ProfileRepairRunner;
    interactionAdapter: ApifyInteractionAdapter;
    selfHostedAuthInteractionAdapter: ApifyInteractionAdapter;
    genderRoutingManifestStore: AnalysisV2GenderRoutingManifestStore;
    revenueGenderRoutingInputPreparer: RevenueGenderRoutingInputPreparer | undefined;
    revenueGenderRoutingAssessorFactory: RevenueGenderRoutingAssessorFactory | null;
    revenueGenderRoutingAssessor: RevenueGenderRoutingAssessor | null;
    env: Record<string, string | undefined>;
}

function deps(input: AnalysisV2CollectionExecutorDependencies): ResolvedDependencies {
    return {
        requestContextStore: input.requestContextStore ?? analysisV2CollectionRequestContextStore,
        evidenceStore: input.evidenceStore ?? analysisV2EvidenceStore,
        profileCheckpointStore:
            input.profileCheckpointStore ?? analysisV2ProfileFetchCheckpointStore,
        providerRunStore: input.providerRunStore ?? analysisV2ProviderRunStore,
        providerAdmissionStore: input.providerAdmissionStore,
        revenueCostOperationStore:
            input.revenueCostOperationStore ?? analysisV2RevenueCostOperationStore,
        freshProvenanceStore: input.freshProvenanceStore,
        providerRunAdoptionStore: input.providerRunAdoptionStore
            ?? (input.providerRunStore ? null : analysisV2ProviderRunAdoptionStore),
        selfHostedAuthRunStore:
            input.selfHostedAuthRunStore ?? analysisV2SelfHostedAuthRunStore,
        targetProfileReuseStore:
            input.targetProfileReuseStore ?? analysisV2TargetProfileReuseStore,
        getFollowers: input.getFollowers ?? getFollowers,
        getFollowing: input.getFollowing ?? getFollowing,
        getProfilesBatchV2: input.getProfilesBatchV2 ?? getProfilesBatchV2,
        runProfileRepair: input.runProfileRepair ?? runAnalysisV2ProfileRepair,
        interactionAdapter: input.interactionAdapter ?? apifyInteractionAdapter,
        selfHostedAuthInteractionAdapter:
            input.selfHostedAuthInteractionAdapter ?? selfHostedAuthInteractionAdapter,
        genderRoutingManifestStore:
            input.genderRoutingManifestStore ?? analysisV2GenderRoutingManifestStore,
        revenueGenderRoutingInputPreparer: input.revenueGenderRoutingInputPreparer,
        revenueGenderRoutingAssessorFactory: input.revenueGenderRoutingAssessorFactory ?? null,
        revenueGenderRoutingAssessor: input.revenueGenderRoutingAssessor ?? null,
        env: input.env ?? process.env,
    };
}

async function awaitSettledBranches<const T extends readonly unknown[]>(
    branches: { readonly [K in keyof T]: (signal: AbortSignal) => Promise<T[K]> }
): Promise<T> {
    const controller = new AbortController();
    const pending = branches.map(branch => Promise.resolve()
        .then(() => branch(controller.signal))
        .catch((error: unknown) => {
            if (!isApifyQueuedStartCancellation(error)) controller.abort();
            throw error;
        }));
    const results = await Promise.allSettled(pending);
    const failure = results.find(result => (
        result.status === 'rejected'
        && !isApifyQueuedStartCancellation(result.reason)
    )) ?? results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    const values: unknown[] = [];
    for (const result of results) {
        if (result.status === 'fulfilled') values.push(result.value);
    }
    return values as unknown as T;
}

function sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function collectionClaim(context: {
    claim: { requestId: string; jobKey: string; claimToken: string; inputHash: string };
}): AnalysisV2CollectionJobClaim {
    return {
        requestId: context.claim.requestId,
        jobKey: context.claim.jobKey,
        claimToken: context.claim.claimToken,
        jobInputHash: context.claim.inputHash,
    };
}

function isBetaFreePoolRequest(request: AnalysisV2CollectionRequestContext): boolean {
    return request.providerExecutionPolicy?.mode === 'betatest_free_pool';
}

function isRevenueCostLedgerRequest(
    request: AnalysisV2CollectionRequestContext,
): request is AnalysisV2CollectionRequestContext & {
    accessMode: 'test_entitlement';
    planId: 'basic' | 'standard';
    providerExecutionPolicy: NonNullable<AnalysisV2CollectionRequestContext['providerExecutionPolicy']>;
} {
    return request.accessMode === 'test_entitlement'
        && (request.planId === 'basic' || request.planId === 'standard')
        && request.providerExecutionPolicy?.mode === 'test_operation_split'
        && request.providerExecutionPolicy.policyVersion === 'authorized-free-e2e-v1';
}

function isAuthorizedTestOperationRequest(
    request: AnalysisV2CollectionRequestContext,
): boolean {
    return request.accessMode === 'test_entitlement'
        && request.providerExecutionPolicy?.mode === 'test_operation_split';
}

function isRevenueGenderRoutingRequest(
    request: AnalysisV2CollectionRequestContext,
): request is AnalysisV2CollectionRequestContext & {
    accessMode: 'test_entitlement';
    planId: 'basic' | 'standard';
    providerExecutionPolicy: NonNullable<AnalysisV2CollectionRequestContext['providerExecutionPolicy']>;
} {
    return isRevenueCostLedgerRequest(request)
        && usesRevenueGenderRouting({ accessMode: request.accessMode, planId: request.planId });
}

function assertFreshRevenueCollectionRuntime(
    request: AnalysisV2CollectionRequestContext,
    dependencies: ResolvedDependencies
): void {
    if (!isRevenueCostLedgerRequest(request)) return;
    assertAnalysisV2FreshProvenanceConfiguration(dependencies.env);
}

function revenueGenderRoutingSecret(dependencies: ResolvedDependencies): string {
    const secret = dependencies.env.ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET;
    if (!secret || secret.length < 32) {
        throw new Error('ANALYSIS_V2_GENDER_ROUTING_SECRET_MISSING');
    }
    return secret;
}

function collectionProviderForRequest(
    request: AnalysisV2CollectionRequestContext,
    dependencies: ResolvedDependencies
): 'apify' | 'selfhosted_auth' {
    return isBetaFreePoolRequest(request)
        ? 'apify'
        : getAnalysisV2PaidCollectionProvider(dependencies.env);
}

function profileIdentity(claim: AnalysisV2CollectionJobClaim): AnalysisV2ProfileFetchCheckpointIdentity {
    return { ...claim };
}

function assertScopeMatchesState(
    request: AnalysisV2CollectionRequestContext,
    state: { planId: string; girlfriendExclusion: { excludedCount: 0 | 1 } }
): void {
    const plan = getAnalysisPlan(request.planId);
    if (
        state.planId !== request.planId
        || state.girlfriendExclusion.excludedCount !== (request.excludedUsername ? 1 : 0)
        || request.detailedMutualLimit !== plan.detailedMutualLimit
        || request.followersDeclaredCount > plan.relationshipCapacity.followers
        || request.followingDeclaredCount > plan.relationshipCapacity.following
    ) {
        throw new Error('ANALYSIS_V2_COLLECTION_SCOPE_DRIFT');
    }
}

function topologyInputHash(kind: 'profiles' | 'private_names', usernames: readonly string[]): string {
    return sha256([
        'analysis-v2-collection-topology-v1',
        kind,
        usernames.length,
        ...usernames.map((username, index) => `${index + 1}|${lengthPrefixed(username)}`),
    ].join('\n'));
}

export function createAnalysisV2CollectionTopology(
    kind: 'profiles' | 'private_names',
    usernames: readonly string[]
): readonly AnalysisV2DagBatchManifest[] {
    const limit = kind === 'profiles'
        ? ANALYSIS_V2_PROFILE_BATCH_LIMIT
        : ANALYSIS_V2_PRIVATE_NAME_BATCH_LIMIT;
    const result: AnalysisV2DagBatchManifest[] = [];
    for (let offset = 0; offset < usernames.length; offset += limit) {
        const batchUsernames = usernames.slice(offset, offset + limit);
        result.push(Object.freeze({
            batch: result.length,
            itemCount: batchUsernames.length,
            inputHash: topologyInputHash(kind, batchUsernames),
        }));
    }
    return Object.freeze(result);
}

async function bindApifyRun(input: {
    dependencies: ResolvedDependencies;
    claim: AnalysisV2CollectionJobClaim;
    request: AnalysisV2CollectionRequestContext;
    operation: ProviderPolicyOperationKind;
    operationKey: string;
    inputHash: string;
    actorId: string;
    maxChargeUsd: number;
    requireCurrentProviderRun?: boolean;
}) {
    const freshRevenueRequest = isRevenueCostLedgerRequest(input.request);
    if (freshRevenueRequest) {
        assertFreshRevenueCollectionRuntime(input.request, input.dependencies);
    }
    const providerBinding = resolveAnalysisV2ApifyProviderBinding({
        accessMode: input.request.accessMode,
        policy: input.request.providerExecutionPolicy,
        operation: input.operation,
        maxChargeUsd: input.maxChargeUsd,
        orderScopedCredentialSlot: input.request.orderScopedCredentialSlot,
        env: input.dependencies.env,
    });
    const identity = {
        requestId: input.claim.requestId,
        jobKey: input.claim.jobKey,
        claimToken: input.claim.claimToken,
        operationKey: input.operationKey,
        inputHash: input.inputHash,
        logicalProvider: 'apify',
        actorId: input.actorId,
        credentialSlot: providerBinding.credentialSlot,
        maxChargeUsd: input.maxChargeUsd,
    } as const;
    const withAdmission = async <T extends {
        stored: StoredAnalysisV2ProviderRun | null;
        checkpoint: ProviderRunCheckpoint;
    }>(binding: T): Promise<T> => ({
        ...binding,
        checkpoint: await withAnalysisProviderAdmissionCheckpoint({
            checkpoint: binding.checkpoint,
            storedStatus: binding.stored?.status === 'starting'
                || binding.stored?.status === 'running'
                ? binding.stored.status
                : null,
            workloadRole: 'paid',
            requestId: input.claim.requestId,
            jobKey: input.claim.jobKey,
            operationKey: input.operationKey,
            claimToken: input.claim.claimToken,
            env: input.dependencies.env,
            store: input.dependencies.providerAdmissionStore,
        }),
    });
    if (freshRevenueRequest || input.requireCurrentProviderRun) {
        // Fresh provenance rejects any adoption before it can select an external
        // Dataset. The only resumable path is the exact durable provider row.
        // Ordinary Earlybird direct-fresh requests use the same immutable
        // current-row binding, but do not opt into the revenue ledger/evidence
        // side effects reserved for strict test-entitlement requests.
        const fallback = freshRevenueRequest
            ? await input.dependencies.providerRunStore.bindAdapterCheckpoint(identity, {
                revenueCostOperationStore: input.dependencies.revenueCostOperationStore,
                freshProvenanceStore: input.dependencies.freshProvenanceStore
                    ?? analysisRevenueFreshProvenanceStore,
                jobInputHash: input.claim.jobInputHash,
            })
            : await input.dependencies.providerRunStore.bindAdapterCheckpoint(identity);
        return { ...(await withAdmission(fallback)), evidenceRun: null };
    }
    const binding = await bindAdoptedProviderRunOrFallback({
        adoptionStore: input.dependencies.providerRunAdoptionStore,
        identity,
        fallback: () => input.dependencies.providerRunStore.bindAdapterCheckpoint(identity),
    });
    if (binding.adopted) {
        return {
            stored: null,
            checkpoint: binding.checkpoint,
            evidenceRun: binding.adopted,
        };
    }
    return { ...(await withAdmission(binding.fallback)), evidenceRun: null };
}

async function requireSucceededRun(
    store: AnalysisV2ProviderRunStore,
    identity: { requestId: string; jobKey: string; operationKey: string }
): Promise<StoredAnalysisV2ProviderRun & { runId: string; status: 'succeeded' }> {
    const run = await store.load(identity);
    if (!run || run.status !== 'succeeded' || run.runId === null) {
        throw new Error('ANALYSIS_V2_COLLECTION_PROVIDER_RUN_NOT_SUCCEEDED');
    }
    return run as StoredAnalysisV2ProviderRun & { runId: string; status: 'succeeded' };
}

function relationshipRows(rows: readonly InstagramFollower[]): AnalysisV2RelationshipRowInput[] {
    return rows.map(row => ({
        username: row.username,
        isPrivate: row.isPrivate,
        isVerified: row.isVerified,
        fullName: row.fullName ?? null,
        profilePicUrl: row.profilePicUrl ?? null,
    }));
}

function canonicalApifyRelationshipIdentity(input: {
    side: 'followers' | 'following';
    targetUsername: string;
    declaredCount: number;
    planId: string;
}): string {
    return canonicalProviderInput([
        'relationship-v2',
        input.side,
        input.targetUsername,
        String(input.declaredCount),
        input.planId,
        'apify-no-cookie',
    ]);
}

function canonicalSelfHostedAuthRelationshipIdentity(input: {
    side: 'followers' | 'following';
    targetUsername: string;
    declaredCount: number;
    planId: string;
}): string {
    return canonicalProviderInput([
        'relationship-v2',
        input.side,
        input.targetUsername,
        String(input.declaredCount),
        input.planId,
        'selfhosted-auth-v1',
    ]);
}

function relationshipIncompleteReplacementIdentity(canonicalInput: string): string {
    return canonicalProviderInput([
        'relationship-incomplete-replacement-v1',
        canonicalInput,
    ]);
}

function isRelationshipIncompleteError(error: unknown): error is Error {
    return error instanceof Error
        && error.message.startsWith('SCRAPING_INCOMPLETE_ERROR:');
}

function adoptionDatasetUnavailable(cause: unknown): Error {
    return new Error('ADOPTION_DATASET_UNAVAILABLE', { cause });
}

class AuthorizedAdoptedRelationshipIncompleteError extends Error {
    constructor(cause: Error) {
        super(cause.message, { cause });
        this.name = 'AuthorizedAdoptedRelationshipIncompleteError';
    }
}

function isReconciledSucceededRun(
    run: StoredAnalysisV2ProviderRun | null
): run is StoredAnalysisV2ProviderRun & { runId: string; status: 'succeeded' } {
    return run?.status === 'succeeded'
        && run.runId !== null
        && run.actualUsageUsd !== null
        && run.usageReconciledAt !== null;
}

export function createAnalysisV2RelationshipsExecutor(
    input: AnalysisV2CollectionExecutorDependencies = {}
): AnalysisV2StageExecutor<'relationships'> {
    const dependencies = deps(input);
    return async (context) => {
        const claim = collectionClaim(context);
        const request = await dependencies.requestContextStore.load(claim);
        assertFreshRevenueCollectionRuntime(request, dependencies);
        assertScopeMatchesState(request, context.state);
        const collectionProvider = collectionProviderForRequest(request, dependencies);

        const collect = async (
            side: 'followers' | 'following',
            startCancellationSignal: AbortSignal
        ) => {
            const declaredCount = side === 'followers'
                ? request.followersDeclaredCount
                : request.followingDeclaredCount;
            if (declaredCount === 0) {
                return dependencies.evidenceStore.checkpointRelationshipSide({
                    ...claim,
                    side,
                    declaredCount,
                    source: {
                        status: 'not_applicable',
                        inputHash: createAnalysisV2RelationshipNotApplicableInputHash(side),
                    },
                    rows: [],
                });
            }
            const apifyCanonicalInput = canonicalApifyRelationshipIdentity({
                side,
                targetUsername: request.targetUsername,
                declaredCount,
                planId: request.planId,
            });
            const operation = side === 'followers'
                ? 'relationship-followers'
                : 'relationship-following';
            const getter = side === 'followers'
                ? dependencies.getFollowers
                : dependencies.getFollowing;
            const executeApify = async (providerInput: string) => {
                const operationKey = createAnalysisV2ProviderOperationKey(
                    operation,
                    providerInput
                );
                const inputHash = createAnalysisV2ProviderInputHash(providerInput);
                const binding = await bindApifyRun({
                    dependencies,
                    claim,
                    request,
                    operation,
                    operationKey,
                    inputHash,
                    actorId: APIFY_RELATIONSHIP_ACTOR_ID,
                    maxChargeUsd: relationshipMaximumCharge(declaredCount, dependencies.env),
                });
                let rows: InstagramFollower[];
                try {
                    rows = await getter(request.targetUsername, declaredCount, {
                        provider: 'apify',
                        fallback: false,
                        expectedResultCount: declaredCount,
                        requestId: claim.requestId,
                        providerRun: { ...binding.checkpoint, startCancellationSignal },
                    });
                } catch (error) {
                    if (binding.evidenceRun) {
                        if (
                            binding.evidenceRun.allowRelationshipIncompleteReplacement
                            && isRelationshipIncompleteError(error)
                        ) {
                            throw new AuthorizedAdoptedRelationshipIncompleteError(error);
                        }
                        throw adoptionDatasetUnavailable(error);
                    }
                    throw error;
                }
                const run = binding.evidenceRun ?? await requireSucceededRun(
                    dependencies.providerRunStore,
                    {
                        requestId: claim.requestId,
                        jobKey: claim.jobKey,
                        operationKey,
                    }
                );
                return { provider: 'apify' as const, inputHash, operationKey, rows, run };
            };
            const executeApifyWithReplacement = async () => {
                const initialOperationKey = createAnalysisV2ProviderOperationKey(
                    operation,
                    apifyCanonicalInput
                );
                try {
                    return await executeApify(apifyCanonicalInput);
                } catch (error) {
                    if (!isRelationshipIncompleteError(error)) throw error;
                    // Some Actors report SUCCEEDED while publishing a partial Dataset. Prove the
                    // first charge is terminal and reconciled before opening one fixed replacement
                    // identity; worker retries then reuse these two rows instead of buying a third.
                    const initialRun = await dependencies.providerRunStore.load({
                        requestId: claim.requestId,
                        jobKey: claim.jobKey,
                        operationKey: initialOperationKey,
                    });
                    if (
                        !isReconciledSucceededRun(initialRun)
                        && !(error instanceof AuthorizedAdoptedRelationshipIncompleteError)
                    ) throw error;
                    return executeApify(
                        relationshipIncompleteReplacementIdentity(apifyCanonicalInput)
                    );
                }
            };
            const executeSelfHostedAuth = async () => {
                const providerInput = canonicalSelfHostedAuthRelationshipIdentity({
                    side,
                    targetUsername: request.targetUsername,
                    declaredCount,
                    planId: request.planId,
                });
                const operationKey = createAnalysisV2ProviderOperationKey(
                    operation,
                    providerInput
                );
                const providerInputHash = createAnalysisV2ProviderInputHash(providerInput);
                const cached = await dependencies.selfHostedAuthRunStore.load({
                    ...claim,
                    operationKey,
                    inputHash: providerInputHash,
                });
                if (cached) {
                    return {
                        provider: 'selfhosted_auth' as const,
                        inputHash: providerInputHash,
                        operationKey,
                        rows: parseSelfHostedAuthRelationshipItems(cached.items),
                        run: cached,
                    };
                }
                const workerReceipt: { current: SelfHostedAuthRunReceipt | null } = {
                    current: null,
                };
                const rows = await getter(request.targetUsername, declaredCount, {
                    provider: 'selfhosted_auth',
                    fallback: false,
                    expectedResultCount: declaredCount,
                    requestId: claim.requestId,
                    selfHostedAuthIdentity: createAnalysisV2SelfHostedAuthWorkerIdentity({
                        requestId: claim.requestId,
                        jobKey: claim.jobKey,
                        operationKey,
                        inputHash: providerInputHash,
                    }),
                    onSelfHostedAuthRunFinished: run => {
                        workerReceipt.current = run;
                    },
                });
                if (workerReceipt.current === null) {
                    throw new Error('ANALYSIS_V2_SELFHOSTED_AUTH_RECEIPT_MISSING');
                }
                const receipt = await dependencies.selfHostedAuthRunStore.checkpoint({
                    ...claim,
                    operationKey,
                    inputHash: providerInputHash,
                    runId: workerReceipt.current.runId,
                    accountSlot: workerReceipt.current.accountSlot,
                    items: rows.map(row => ({ ...row })),
                });
                return {
                    provider: 'selfhosted_auth' as const,
                    inputHash: providerInputHash,
                    operationKey,
                    rows,
                    run: receipt,
                };
            };

            const selectedProvider = collectionProvider;
            let completed: Awaited<ReturnType<typeof executeApifyWithReplacement>>
                | Awaited<ReturnType<typeof executeSelfHostedAuth>>;
            if (selectedProvider === 'selfhosted_auth') {
                // The named route is whole-request scoped. An authenticated-worker failure or
                // a retained Apify row can never switch this operation to another provider.
                completed = await executeSelfHostedAuth();
            } else {
                completed = await executeApifyWithReplacement();
            }
            return dependencies.evidenceStore.checkpointRelationshipSide({
                ...claim,
                side,
                declaredCount,
                source: {
                    status: 'collected',
                    inputHash: completed.inputHash,
                    provider: completed.provider,
                    providerRunId: completed.run.runId,
                    providerOperationKey: completed.operationKey,
                },
                rows: relationshipRows(completed.rows),
            });
        };

        await awaitSettledBranches([
            signal => collect('followers', signal),
            signal => collect('following', signal),
        ] as const);
        const manifest = await dependencies.evidenceStore.freezeRelationships({
            ...claim,
            detailedMutualLimit: request.detailedMutualLimit,
        });
        const staging = await dependencies.evidenceStore.loadRelationshipStaging({
            requestId: claim.requestId,
            jobKey: claim.jobKey,
        });
        if (!staging || staging.excludedUsername !== request.excludedUsername) {
            throw new Error('ANALYSIS_V2_RELATIONSHIP_STAGING_MISSING');
        }
        if (
            request.excludedUsername
            && (
                staging.detailedPublicUsernames.includes(request.excludedUsername)
                || staging.privateMutualUsernames.includes(request.excludedUsername)
            )
        ) {
            throw new Error('ANALYSIS_V2_GIRLFRIEND_EXCLUSION_LEAK');
        }

        let detailedPublicUsernames = staging.detailedPublicUsernames;
        let detailedSelectedPublicCount = manifest.detailedPublicCount;
        let notScreenedPublicCount = manifest.unscreenedPublicCount;
        let relationshipSelectionPolicy: {
            policyVersion: 'gender-routing-v1';
            relationshipCheckpointId: string;
            relationshipJobInputHash: string;
            planId: 'basic' | 'standard';
            publicPopulationCount: number;
            selectedCount: number;
        } | undefined;
        if (isRevenueGenderRoutingRequest(request)) {
            const publicMutualRows = staging.mutualRows
                .filter(row => !row.isPrivate)
                .sort((left, right) => left.mutualOrdinal - right.mutualOrdinal);
            const cap = GENDER_ROUTING_CAPS[request.planId];
            if (
                publicMutualRows.length !== manifest.publicCount
                || publicMutualRows.length > cap.population
                || new Set(publicMutualRows.map(row => row.mutualOrdinal)).size !== publicMutualRows.length
            ) throw new Error('ANALYSIS_V2_GENDER_ROUTING_POPULATION_DRIFT');
            const hmacSecret = revenueGenderRoutingSecret(dependencies);
            const assessor = dependencies.revenueGenderRoutingAssessor
                ?? dependencies.revenueGenderRoutingAssessorFactory?.({
                    requestId: claim.requestId,
                    jobKey: 'track:relationships:collect',
                    jobClaimToken: claim.claimToken,
                    jobInputHash: claim.jobInputHash,
                    accessMode: request.accessMode,
                    planId: request.planId,
                    ...(context.handlerDeadlineAtMs === undefined
                        ? {}
                        : { handlerDeadlineAtMs: context.handlerDeadlineAtMs }),
                });
            let routed: Awaited<ReturnType<typeof routeAndPersistRevenueGenderCandidates>>;
            try {
                routed = await routeAndPersistRevenueGenderCandidates({
                    requestId: claim.requestId,
                    relationshipCheckpointId: manifest.resultHash,
                    accessMode: request.accessMode,
                    planId: request.planId,
                    candidates: publicMutualRows.map(row => ({
                        mutualOrdinal: row.mutualOrdinal,
                        candidateKey: `mutual:${row.mutualOrdinal}`,
                        profilePicUrl: row.profilePicUrl,
                        fullname: row.fullName,
                    })),
                    hmacSecret,
                    inputPreparer: dependencies.revenueGenderRoutingInputPreparer,
                    assess: assessor ?? undefined,
                    jobKey: 'track:relationships:collect',
                    claimToken: claim.claimToken,
                    jobInputHash: claim.jobInputHash,
                    manifestStore: dependencies.genderRoutingManifestStore,
                });
            } catch (error) {
                if (error instanceof GenderRoutingError && error.code === 'ROUTING_UNAVAILABLE') {
                    await dependencies.revenueCostOperationStore.manualReview({
                        requestId: claim.requestId,
                        reasonCode: 'routing_failure',
                    });
                }
                throw error;
            }
            if (!routed) throw new Error('ANALYSIS_V2_GENDER_ROUTING_NOT_APPLICABLE');
            const selectedRows = await dependencies.genderRoutingManifestStore.loadSelectedUsernames({
                requestId: claim.requestId,
                relationshipCheckpointId: manifest.resultHash,
                policyVersion: 'gender-routing-v1',
                planId: request.planId,
            });
            const publicByOrdinal = new Map(publicMutualRows.map(row => [row.mutualOrdinal, row]));
            if (
                selectedRows.length !== routed.header.selectedCount
                || selectedRows.length !== routed.selectedMutualOrdinals.length
                || selectedRows.length > cap.detailed
                || selectedRows.some((row, index) => (
                    row.ordinal !== index + 1
                    || row.candidateKey !== `mutual:${row.mutualOrdinal}`
                    || publicByOrdinal.get(row.mutualOrdinal)?.username !== row.username
                ))
            ) throw new Error('ANALYSIS_V2_GENDER_ROUTING_SELECTION_DRIFT');
            detailedPublicUsernames = selectedRows.map(row => row.username);
            detailedSelectedPublicCount = selectedRows.length;
            notScreenedPublicCount = publicMutualRows.length - selectedRows.length;
            relationshipSelectionPolicy = Object.freeze({
                policyVersion: 'gender-routing-v1',
                relationshipCheckpointId: manifest.resultHash,
                relationshipJobInputHash: claim.jobInputHash,
                planId: request.planId,
                publicPopulationCount: publicMutualRows.length,
                selectedCount: selectedRows.length,
            });
        }

        return Object.freeze({
            checkpoint: Object.freeze({
                kind: 'relationships' as const,
                manifest: Object.freeze({
                    revision: manifest.revision,
                    resultHash: manifest.resultHash,
                    detectedMutualCount: manifest.mutualCount,
                    publicCount: manifest.publicCount,
                    privateCount: manifest.privateCount,
                    detailedSelectedPublicCount,
                    notScreenedPublicCount,
                    profileBatches: createAnalysisV2CollectionTopology(
                        'profiles',
                        detailedPublicUsernames
                    ),
                    privateNameBatches: createAnalysisV2CollectionTopology(
                        'private_names',
                        staging.privateMutualUsernames
                    ),
                    ...(relationshipSelectionPolicy ? { relationshipSelectionPolicy } : {}),
                }),
            }),
        });
    };
}

function checkpointAttemptResults(
    results: readonly ProfileAttemptResult[]
): readonly AnalysisV2ProfileAttemptResultInput[] {
    return results.map(result => ('profile' in result
        ? { outcome: result.outcome, profile: result.profile }
        : { outcome: result.outcome }));
}

function resumeAttemptResults(
    resume: AnalysisV2ProfileFetchResume
): readonly ProfileAttemptResult[] {
    return resume.primaryResults.map(result => ('profile' in result
        ? { outcome: result.outcome, profile: result.profile as InstagramProfile }
        : { outcome: result.outcome })) as readonly ProfileAttemptResult[];
}

/**
 * Attempt precedence for one username: primary success, then repair, then fallback, then the
 * primary row itself. The later attempt wins only where the primary did not already succeed,
 * and the repair outranks the fallback because it is the more recent terminal evidence for
 * the same username — not because it is more favourable. A repair that failed therefore stays
 * a failure here and is still counted by `evaluateProfileBatchCompleteness`, which remains the
 * only 90 percent predicate; repair never buys back failure budget.
 *
 * `resume.repairResults` is the server-derived repair attempt the checkpoint carries. It is
 * read as given and never re-derived: the client-side repair-set prediction in
 * `v2-profile-fetch-store.ts` decides whether to call the RPC, and is not an authority here.
 */
function finalCheckpointResults(resume: AnalysisV2ProfileFetchResume) {
    const fallbackByUsername = new Map(
        resume.fallbackResults.map(result => [result.outcome.requestedUsername, result])
    );
    const repairByUsername = new Map(
        resume.repairResults.map(result => [result.outcome.requestedUsername, result])
    );
    return resume.primaryResults.map(primary => (
        primary.outcome.status === 'success'
            ? primary
            : repairByUsername.get(primary.outcome.requestedUsername)
                ?? fallbackByUsername.get(primary.outcome.requestedUsername)
                ?? primary
    ));
}

function profileFallbackIdentity(usernames: readonly string[]): string {
    return canonicalProviderInput(['profile-fallback-v2', ...usernames]);
}

/**
 * The target-evidence profile is not a generic fallback: its evidence must
 * retain the exact approved target-profile operation identity. Candidate batch
 * collection remains a separately approved profile-fallback family.
 */
function freshProfileOperation(input: {
    claim: AnalysisV2CollectionJobClaim;
    request: AnalysisV2CollectionRequestContext;
    usernames: readonly string[];
}): { operation: 'target-profile' | 'profile-fallback'; canonicalInput: string } {
    if (input.claim.jobKey !== ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY) {
        return {
            operation: 'profile-fallback',
            canonicalInput: profileFallbackIdentity(input.usernames),
        };
    }
    if (
        input.usernames.length !== 1
        || input.usernames[0] !== input.request.targetUsername
    ) {
        throw new Error('FRESH_PROVENANCE_TARGET_PROFILE_IDENTITY_DRIFT');
    }
    return {
        operation: 'target-profile',
        canonicalInput: canonicalProviderInput([
            'target-profile-fresh-v1',
            input.claim.jobInputHash,
            input.request.targetUsername,
        ]),
    };
}

function selfHostedAuthProfileIdentity(
    claim: AnalysisV2CollectionJobClaim,
    usernames: readonly string[]
) {
    const operation = 'target-profile';
    const providerInput = canonicalProviderInput([
        'selfhosted-auth-profile-v1',
        claim.jobInputHash,
        ...usernames,
    ]);
    const operationKey = createAnalysisV2ProviderOperationKey(operation, providerInput);
    const inputHash = createAnalysisV2ProviderInputHash(providerInput);
    return createAnalysisV2SelfHostedAuthWorkerIdentity({
        requestId: claim.requestId,
        jobKey: claim.jobKey,
        operationKey,
        inputHash,
    });
}

function isDirectApifyProfileResume(
    resume: AnalysisV2ProfileFetchResume,
): boolean {
    return resume.primaryResults.length > 0
        && resume.primaryResults.every(result => result.outcome.source === 'apify')
        && resume.fallbackResults.length === 0
        && resume.fallbackCapturedAt === null
        && resume.repairResults.length === 0
        && resume.repairCapturedAt === null;
}

function requiresUnauthorizedFreshProfileRepair(
    resume: AnalysisV2ProfileFetchResume,
    usernames: readonly string[],
): boolean {
    return resume.repairCapturedAt === null
        && !evaluateProfileBatchCompleteness(finalCheckpointResults(resume), usernames).satisfied
        && deriveRepairUsernames(resume).length > 0;
}

async function durableFreshApifyProfiles(input: {
    dependencies: ResolvedDependencies;
    claim: AnalysisV2CollectionJobClaim;
    request: AnalysisV2CollectionRequestContext;
    usernames: readonly string[];
    onProfileStart?: (username: string) => Promise<void>;
    onProfileResolved?: (profile: InstagramProfile) => Promise<void>;
}): Promise<AnalysisV2ProfileFetchResume> {
    const {
        dependencies,
        claim,
        request,
        usernames,
        onProfileStart,
        onProfileResolved,
    } = input;
    assertFreshRevenueCollectionRuntime(request, dependencies);
    const identity = profileIdentity(claim);
    const freshOperation = freshProfileOperation({ claim, request, usernames });
    const canonicalInput = freshOperation.canonicalInput;
    const operationKey = createAnalysisV2ProviderOperationKey(
        freshOperation.operation,
        canonicalInput,
    );
    const providerInputHash = createAnalysisV2ProviderInputHash(canonicalInput);
    // Inspect a retained direct-Apify checkpoint before binding a provider row.
    // Both strict and paid Earlybird direct-fresh admissions reject any mixed
    // fallback/repair state before provider work.
    const resume = !isRevenueCostLedgerRequest(request)
        && dependencies.profileCheckpointStore.loadFreshApifyRetry
        ? await dependencies.profileCheckpointStore.loadFreshApifyRetry({
            ...identity,
            operationKey,
            providerInputHash,
        })
        : await dependencies.profileCheckpointStore.load(identity);
    if (resume && !isDirectApifyProfileResume(resume)) {
        throw new Error('FRESH_PROVENANCE_PROFILE_CHECKPOINT_UNPROVEN');
    }
    if (
        resume
        && isRevenueCostLedgerRequest(request)
        && requiresUnauthorizedFreshProfileRepair(resume, usernames)
    ) {
        throw new Error('FRESH_PROVENANCE_PROFILE_REPAIR_UNAUTHORIZED');
    }
    // The exact provider row is the only permitted retained state. This bind
    // reasserts its source lineage and will never select target reuse, a cache,
    // or an adopted Dataset for the trusted cohort.
    const binding = await bindApifyRun({
        dependencies,
        claim,
        request,
        operation: freshOperation.operation,
        operationKey,
        inputHash: providerInputHash,
        actorId: PROFILE_ACTOR_ID,
        maxChargeUsd: profileMaximumCharge(usernames.length, dependencies.env),
        requireCurrentProviderRun: true,
    });
    if (resume) {
        if (
            binding.stored === null
            || !binding.checkpoint.resumeRunId
        ) {
            throw new Error('FRESH_PROVENANCE_PROFILE_CHECKPOINT_UNPROVEN');
        }
        return resume;
    }

    try {
        await dependencies.getProfilesBatchV2(usernames, {
            requestId: claim.requestId,
            freshApifyOnly: true,
            allowApifyFallback: false,
            providerRun: binding.checkpoint,
            onProfileStart,
            onProfileResolved,
            persistAttemptOutcomes: async (snapshot: ProfilesBatchV2AttemptSnapshot) => {
                if (snapshot.attempt !== 'fresh_apify' || snapshot.source !== 'apify') {
                    throw new Error('FRESH_PROVENANCE_PROFILE_ATTEMPT_DRIFT');
                }
                await dependencies.profileCheckpointStore.checkpointFreshApify({
                    ...identity,
                    requestedUsernames: snapshot.requestedUsernames,
                    results: checkpointAttemptResults(snapshot.results),
                    operationKey,
                    providerInputHash,
                    freshAdmission: isRevenueCostLedgerRequest(request)
                        ? 'strict_test_entitlement'
                        : 'paid_earlybird',
                });
            },
        });
    } catch (error) {
        if (binding.evidenceRun) throw adoptionDatasetUnavailable(error);
        throw error;
    }

    const stored = await dependencies.profileCheckpointStore.load(identity);
    if (!stored || !isDirectApifyProfileResume(stored)) {
        throw new Error('FRESH_PROVENANCE_PROFILE_CHECKPOINT_MISSING');
    }
    return stored;
}

async function durableProfiles(input: {
    dependencies: ResolvedDependencies;
    claim: AnalysisV2CollectionJobClaim;
    request: AnalysisV2CollectionRequestContext;
    usernames: readonly string[];
    onProfileStart?: (username: string) => Promise<void>;
    onProfileResolved?: (profile: InstagramProfile) => Promise<void>;
}): Promise<AnalysisV2ProfileFetchResume> {
    const {
        dependencies,
        claim,
        request,
        usernames,
        onProfileStart,
        onProfileResolved,
    } = input;
    const collectionProvider = collectionProviderForRequest(request, dependencies);
    if (
        isRevenueCostLedgerRequest(request)
        || (
            !isBetaFreePoolRequest(request)
            && !isAuthorizedTestOperationRequest(request)
            && collectionProvider === 'apify'
        )
    ) {
        return durableFreshApifyProfiles(input);
    }
    const allowApifyFallback = isBetaFreePoolRequest(request)
        || (isAuthorizedTestOperationRequest(request) && collectionProvider === 'apify');
    const authenticatedProfiles = !isBetaFreePoolRequest(request)
        && collectionProvider === 'selfhosted_auth';
    const identity = profileIdentity(claim);
    let resume = await dependencies.profileCheckpointStore.load(identity);
    if (
        resume
        && (!allowApifyFallback || resume.frozenUnresolvedUsernames.length === 0
            || resume.fallbackCapturedAt !== null)
    ) return resume;

    const mutableProviderRun: ProviderRunCheckpoint = {};
    let adoptedFallback = false;
    const bindFallback = async (unresolved: readonly string[]) => {
        if (unresolved.length === 0) return;
        if (
            !isRevenueCostLedgerRequest(request)
            && claim.jobKey === 'track:target-evidence:collect'
        ) {
            if (
                unresolved.length !== 1
                || unresolved[0] !== request.targetUsername
                || usernames.length !== 1
                || usernames[0] !== request.targetUsername
            ) {
                throw new Error('ANALYSIS_V2_TARGET_PROFILE_REUSE_IDENTITY_DRIFT');
            }
            const reusable = await dependencies.targetProfileReuseStore.load({
                requestId: claim.requestId,
                jobKey: claim.jobKey,
                claimToken: claim.claimToken,
                jobInputHash: claim.jobInputHash,
                targetUsername: request.targetUsername,
            });
            if (reusable) {
                Object.assign(mutableProviderRun, {
                    resumeRunId: reusable.runId,
                    logicalProvider: reusable.logicalProvider,
                    actorId: reusable.actorId,
                    credentialSlot: reusable.credentialSlot,
                    maxChargeUsd: reusable.maxChargeUsd,
                });
                return;
            }
        }
        const canonicalInput = profileFallbackIdentity(unresolved);
        const binding = await bindApifyRun({
            dependencies,
            claim,
            request,
            operation: 'profile-fallback',
            operationKey: createAnalysisV2ProviderOperationKey('profile-fallback', canonicalInput),
            inputHash: createAnalysisV2ProviderInputHash(canonicalInput),
            actorId: PROFILE_ACTOR_ID,
            maxChargeUsd: profileMaximumCharge(unresolved.length, dependencies.env),
        });
        Object.assign(mutableProviderRun, binding.checkpoint);
        adoptedFallback = binding.evidenceRun !== null;
    };

    if (resume && allowApifyFallback) await bindFallback(resume.frozenUnresolvedUsernames);

    try {
        await dependencies.getProfilesBatchV2(usernames, {
        requestId: claim.requestId,
        allowApifyFallback,
        primaryProvider: authenticatedProfiles ? 'selfhosted_auth' : 'selfhosted',
        ...(authenticatedProfiles ? {
            selfHostedAuthIdentity: selfHostedAuthProfileIdentity(claim, usernames),
        } : {}),
        onProfileStart,
        onProfileResolved,
        providerRun: mutableProviderRun,
        ...(resume ? {
            resume: {
                primaryResults: resumeAttemptResults(resume),
                frozenUnresolvedUsernames: resume.frozenUnresolvedUsernames,
            },
        } : {}),
        persistAttemptOutcomes: async (snapshot: ProfilesBatchV2AttemptSnapshot) => {
            if (snapshot.attempt === 'primary') {
                resume = await dependencies.profileCheckpointStore.checkpointPrimary({
                    ...identity,
                    requestedUsernames: snapshot.requestedUsernames,
                    results: checkpointAttemptResults(snapshot.results),
                });
                if (allowApifyFallback) {
                    await bindFallback(resume.frozenUnresolvedUsernames);
                }
                return;
            }
            resume = await dependencies.profileCheckpointStore.checkpointFallback({
                ...identity,
                results: checkpointAttemptResults(snapshot.results),
            });
        },
        });
    } catch (error) {
        if (adoptedFallback) throw adoptionDatasetUnavailable(error);
        throw error;
    }

    const stored = await dependencies.profileCheckpointStore.load(identity);
    if (!stored) throw new Error('ANALYSIS_V2_PROFILE_CHECKPOINT_MISSING');
    return stored;
}

/**
 * One at-most-once repair pass over a legacy beta/test profile batch that the primary+fallback
 * merge left short of the 90% gate. Paid production direct-fresh batches return before this
 * function can bind the replacement Actor. The repair path runs only over the still-failed
 * frozen-unresolved subset, checkpoints those outcomes as the third `repair` attempt, and returns
 * the merged resume for the gate to re-evaluate.
 */
async function repairProfileBatch(input: {
    dependencies: ResolvedDependencies;
    claim: AnalysisV2CollectionJobClaim;
    request: AnalysisV2CollectionRequestContext;
    usernames: readonly string[];
    resume: AnalysisV2ProfileFetchResume;
}): Promise<AnalysisV2ProfileFetchResume> {
    const { dependencies, claim, request, usernames, resume } = input;
    if (!isBetaFreePoolRequest(request)
        && collectionProviderForRequest(request, dependencies) === 'selfhosted_auth') {
        return resume;
    }
    // The 12-hour paid Earlybird launch intentionally has no profile repair
    // admission.  The direct fresh batch remains durable and the shared
    // completeness gate fails closed until an operator retry/recovery policy
    // is introduced. Beta and authorized test requests retain their legacy
    // repair behavior below.
    if (!isBetaFreePoolRequest(request)
        && !isAuthorizedTestOperationRequest(request)
        && collectionProviderForRequest(request, dependencies) === 'apify') {
        return resume;
    }
    // A completed repair is terminal for the batch. This short-circuit mirrors durableProfiles'
    // fallback guard so a retried job never starts a second paid repair run.
    if (resume.repairCapturedAt !== null) return resume;
    // Repair is triggered by the single shared 90% predicate only: if the merged primary+fallback
    // evidence already clears the gate there is nothing to repair and nothing to spend.
    if (evaluateProfileBatchCompleteness(finalCheckpointResults(resume), usernames).satisfied) {
        return resume;
    }
    // The still-failed frozen-unresolved subset. `unavailable` is never admitted, so a shortfall
    // made entirely of settled-unavailable accounts yields an empty set and no run.
    const repairUsernames = deriveRepairUsernames(resume);
    if (repairUsernames.length === 0) return resume;
    if (isRevenueCostLedgerRequest(request)) {
        // The applied provider-cost SQL intentionally has no authorized fresh
        // profile-repair source mapping. Do not widen it implicitly here.
        throw new Error('FRESH_PROVENANCE_PROFILE_REPAIR_UNAUTHORIZED');
    }

    const identity = profileIdentity(claim);
    const canonicalInput = profileRepairIdentity(repairUsernames);
    const mutableProviderRun: ProviderRunCheckpoint = {};
    const binding = await bindApifyRun({
        dependencies,
        claim,
        request,
        // Legacy seven-key policies intentionally alias this through the resolver; beta's frozen
        // eight-key map gets its own slot and reservation family.
        operation: 'profile-repair',
        operationKey: createAnalysisV2ProviderOperationKey('profile-repair', canonicalInput),
        inputHash: createAnalysisV2ProviderInputHash(canonicalInput),
        actorId: REPLACEMENT_PROFILE_ACTOR.actorId,
        maxChargeUsd: profileRepairMaximumCharge(repairUsernames.length),
    });
    Object.assign(mutableProviderRun, binding.checkpoint);
    const credentialSlot = binding.checkpoint.credentialSlot;
    if (!credentialSlot) throw new Error('ANALYSIS_V2_PROFILE_REPAIR_SLOT_UNRESOLVED');

    // The adapter throws on a RESTRICTED-pin failure or a still-pending run, so the checkpoint
    // write below is reached only with a durable, terminal outcome set — never sealing a barrier
    // as synthetic failures.
    let outcomes: Awaited<ReturnType<typeof dependencies.runProfileRepair>>;
    try {
        outcomes = await dependencies.runProfileRepair({
            usernames: repairUsernames,
            credentialSlot,
            providerRunCheckpoint: mutableProviderRun,
            env: dependencies.env,
        });
    } catch (error) {
        if (binding.evidenceRun) throw adoptionDatasetUnavailable(error);
        throw error;
    }
    return dependencies.profileCheckpointStore.checkpointRepair({
        ...identity,
        results: checkpointAttemptResults(outcomes),
    });
}

function durableSuccessfulProfiles(
    resume: AnalysisV2ProfileFetchResume,
    requestedUsernames: readonly string[]
): AnalysisV2CheckpointProfile[] {
    const final = durableTerminalProfileResults(resume, requestedUsernames);
    if (final.some(result => result.outcome.status !== 'success' || !('profile' in result))) {
        throw new Error('ANALYSIS_V2_PROFILE_EVIDENCE_INCOMPLETE');
    }
    return final.map(result => {
        if (!('profile' in result)) throw new Error('ANALYSIS_V2_PROFILE_EVIDENCE_INCOMPLETE');
        return result.profile;
    });
}

export function evaluateProfileBatchCompleteness(
    final: readonly AnalysisV2CheckpointResult[],
    requestedUsernames: readonly string[]
): { satisfied: boolean; failedUsernames: readonly string[]; allowedFailures: number } {
    const failed = final.filter(result => result.outcome.status === 'failed');
    const allowedFailures = requestedUsernames.length - Math.ceil(0.9 * requestedUsernames.length);
    const satisfied = final.length === requestedUsernames.length
        && failed.length <= allowedFailures
        // A malformed external profile row is never used as evidence.  It is safe to
        // classify that one candidate as unavailable, subject to the same 90% coverage
        // floor as an omitted row; retryable transport/auth failures remain terminal.
        && failed.every(result => (
            result.outcome.failureCategory === 'incomplete'
            || result.outcome.failureCategory === 'schema'
        ));
    return {
        satisfied,
        failedUsernames: failed.map(result => result.outcome.requestedUsername),
        allowedFailures,
    };
}

function durableTerminalProfileResults(
    resume: AnalysisV2ProfileFetchResume,
    requestedUsernames: readonly string[]
): AnalysisV2CheckpointResult[] {
    if (
        resume.requestedUsernames.length !== requestedUsernames.length
        || resume.requestedUsernames.some((username, index) => username !== requestedUsernames[index])
    ) {
        throw new Error('ANALYSIS_V2_PROFILE_BATCH_IDENTITY_DRIFT');
    }
    const final = finalCheckpointResults(resume);
    if (!evaluateProfileBatchCompleteness(final, requestedUsernames).satisfied) {
        throw new Error('ANALYSIS_V2_PROFILE_EVIDENCE_INCOMPLETE');
    }
    return final;
}

function profileBatchResultHash(
    requestedUsernames: readonly string[],
    results: readonly AnalysisV2CheckpointResult[]
): string {
    return sha256([
        'analysis-v2-profile-batch-result-v1',
        ...requestedUsernames.map((username, index) => [
            index + 1,
            lengthPrefixed(username),
            lengthPrefixed(JSON.stringify(results[index])),
        ].join('|')),
    ].join('\n'));
}

function interactionContext(
    checkpoint: ProviderRunCheckpoint,
    startCancellationSignal: AbortSignal
): ProviderCallContext {
    return { ...checkpoint, startCancellationSignal, recordUsage: () => undefined };
}

function targetProfilePosts(profile: AnalysisV2CheckpointProfile): InstagramPost[] {
    const posts = profile.latestPosts ?? [];
    if (posts.length === 0 && profile.postsCount > 0) {
        throw new Error('ANALYSIS_V2_TARGET_POST_SNAPSHOT_INCOMPLETE');
    }
    return posts as InstagramPost[];
}

async function collectedTargetSource(input: {
    dependencies: ResolvedDependencies;
    claim: AnalysisV2CollectionJobClaim;
    request: AnalysisV2CollectionRequestContext;
    targetUsername: string;
    kind: 'likers' | 'comments';
    posts: readonly InstagramPost[];
    collectionProvider: 'apify' | 'selfhosted_auth';
    startCancellationSignal: AbortSignal;
}) {
    const limitPerPost = input.kind === 'likers' ? TARGET_LIKER_LIMIT : TARGET_COMMENT_LIMIT;
    const postUrls = input.posts.map(instagramPostUrl);
    const apifyCanonicalInput = canonicalProviderInput([
        `target-${input.kind}-v2`,
        input.targetUsername,
        String(limitPerPost),
        ...postUrls,
    ]);
    const operation = input.kind === 'likers' ? 'target-likers' : 'target-comments';
    const executeApify = async () => {
        const operationKey = createAnalysisV2ProviderOperationKey(
            operation,
            apifyCanonicalInput
        );
        const inputHash = createAnalysisV2ProviderInputHash(apifyCanonicalInput);
        const binding = await bindApifyRun({
            dependencies: input.dependencies,
            claim: input.claim,
            request: input.request,
            operation,
            operationKey,
            inputHash,
            actorId: input.kind === 'likers' ? APIFY_LIKERS_ACTOR_ID : APIFY_COMMENTS_ACTOR_ID,
            maxChargeUsd: interactionMaximumCharge(
                input.kind,
                postUrls.length,
                limitPerPost,
                input.dependencies.env
            ),
        });
        let rows: Awaited<ReturnType<ApifyInteractionAdapter['getPostLikers']>>
            | Awaited<ReturnType<ApifyInteractionAdapter['getPostComments']>>;
        try {
            rows = input.kind === 'likers'
                ? await input.dependencies.interactionAdapter.getPostLikers(
                    postUrls,
                    limitPerPost,
                    interactionContext(binding.checkpoint, input.startCancellationSignal)
                )
                : await input.dependencies.interactionAdapter.getPostComments(
                    postUrls,
                    limitPerPost,
                    interactionContext(binding.checkpoint, input.startCancellationSignal)
                );
        } catch (error) {
            if (binding.evidenceRun) throw adoptionDatasetUnavailable(error);
            throw error;
        }
        const run = binding.evidenceRun ?? await requireSucceededRun(
            input.dependencies.providerRunStore,
            {
                requestId: input.claim.requestId,
                jobKey: input.claim.jobKey,
                operationKey,
            }
        );
        return {
            rows,
            provider: 'apify' as const,
            providerRunId: run.runId,
            providerCredentialSlot: run.credentialSlot,
            operationKey,
            inputHash,
        };
    };
    const executeSelfHostedAuth = async () => {
        const canonicalInput = canonicalProviderInput([
            `target-${input.kind}-v2`,
            input.targetUsername,
            String(limitPerPost),
            ...postUrls,
            'selfhosted-auth-v1',
        ]);
        const operationKey = createAnalysisV2ProviderOperationKey(operation, canonicalInput);
        const inputHash = createAnalysisV2ProviderInputHash(canonicalInput);
        const cached = await input.dependencies.selfHostedAuthRunStore.load({
            ...input.claim,
            operationKey,
            inputHash,
        });
        if (cached) {
            return {
                rows: input.kind === 'likers'
                    ? parseSelfHostedAuthLikerItems(cached.items)
                    : parseSelfHostedAuthCommentItems(cached.items),
                provider: 'selfhosted_auth' as const,
                providerRunId: cached.runId,
                providerCredentialSlot: cached.accountSlot,
                operationKey,
                inputHash,
            };
        }
        const receiptHolder: { current: SelfHostedAuthRunReceipt | null } = { current: null };
        const context: ProviderCallContext = {
            startCancellationSignal: input.startCancellationSignal,
            selfHostedAuthIdentity: createAnalysisV2SelfHostedAuthWorkerIdentity({
                requestId: input.claim.requestId,
                jobKey: input.claim.jobKey,
                operationKey,
                inputHash,
            }),
            recordUsage: () => undefined,
            onSelfHostedAuthRunFinished: async run => {
                receiptHolder.current = run;
            },
        };
        const rows = input.kind === 'likers'
            ? await input.dependencies.selfHostedAuthInteractionAdapter.getPostLikers(
                postUrls,
                limitPerPost,
                context
            )
            : await input.dependencies.selfHostedAuthInteractionAdapter.getPostComments(
                postUrls,
                limitPerPost,
                context
            );
        if (receiptHolder.current === null) {
            throw new Error('ANALYSIS_V2_SELFHOSTED_AUTH_RECEIPT_MISSING');
        }
        const receipt = await input.dependencies.selfHostedAuthRunStore.checkpoint({
            ...input.claim,
            operationKey,
            inputHash,
            runId: receiptHolder.current.runId,
            accountSlot: receiptHolder.current.accountSlot,
            items: rows.map(row => ({ ...row })),
        });
        return {
            rows,
            provider: 'selfhosted_auth' as const,
            providerRunId: receipt.runId,
            providerCredentialSlot: receipt.accountSlot,
            operationKey,
            inputHash,
        };
    };

    const selectedProvider = input.collectionProvider;
    if (selectedProvider !== 'selfhosted_auth') return executeApify();

    return executeSelfHostedAuth();
}

export function createAnalysisV2TargetEvidenceExecutor(
    input: AnalysisV2CollectionExecutorDependencies = {}
): AnalysisV2StageExecutor<'target_evidence'> {
    const dependencies = deps(input);
    return async (context) => {
        const claim = collectionClaim(context);
        const request = await dependencies.requestContextStore.load(claim);
        assertFreshRevenueCollectionRuntime(request, dependencies);
        assertScopeMatchesState(request, context.state);
        const collectionProvider = collectionProviderForRequest(request, dependencies);
        const targetResume = await durableProfiles({
            dependencies,
            claim,
            request,
            usernames: [request.targetUsername],
        });
        const [targetProfile] = durableSuccessfulProfiles(targetResume, [request.targetUsername]);
        if (!targetProfile || targetProfile.isPrivate) {
            throw new Error('ANALYSIS_V2_TARGET_PROFILE_UNAVAILABLE');
        }
        const posts = targetProfilePosts(targetProfile);
        const likerPosts = selectRecentInteractionPosts([...posts], TARGET_LIKER_POST_LIMIT);
        const commentPosts = selectRecentInteractionPosts([...posts], TARGET_COMMENT_POST_LIMIT);
        if ((likerPosts.length === 0 || commentPosts.length === 0) && posts.length > 0) {
            throw new Error('ANALYSIS_V2_TARGET_POST_IDENTITY_INCOMPLETE');
        }

        let likerSource: AnalysisV2TargetEvidenceSourceInput;
        let commentSource: AnalysisV2TargetEvidenceSourceInput;
        let likerRows: Awaited<ReturnType<ApifyInteractionAdapter['getPostLikers']>> = [];
        let commentRows: Awaited<ReturnType<ApifyInteractionAdapter['getPostComments']>> = [];
        if (posts.length === 0) {
            const proofHash = sha256([
                'analysis-v2-target-not-applicable-v1',
                request.targetUsername,
                String(targetProfile.postsCount),
                lengthPrefixed(JSON.stringify(targetProfile.latestPosts ?? [])),
            ].join('\n'));
            likerSource = { status: 'not_applicable', inputHash: proofHash };
            commentSource = { status: 'not_applicable', inputHash: proofHash };
        } else {
            const [likers, comments] = await awaitSettledBranches([
                signal => collectedTargetSource({
                    dependencies,
                    claim,
                    request,
                    targetUsername: request.targetUsername,
                    kind: 'likers',
                    posts: likerPosts,
            collectionProvider,
                    startCancellationSignal: signal,
                }),
                signal => collectedTargetSource({
                    dependencies,
                    claim,
                    request,
                    targetUsername: request.targetUsername,
                    kind: 'comments',
                    posts: commentPosts,
                    collectionProvider,
                    startCancellationSignal: signal,
                }),
            ] as const);
            likerRows = likers.rows as ApifyPostLiker[];
            commentRows = comments.rows as ApifyPostComment[];

            const raw = extractRawTargetInteractions({
                targetPosts: posts,
                likers: likerRows,
                comments: commentRows,
                excludedUsernames: [
                    request.targetUsername,
                    ...(request.excludedUsername ? [request.excludedUsername] : []),
                ],
            });
            likerSource = {
                status: 'collected',
                inputHash: likers.inputHash,
                provider: likers.provider,
                providerRunId: likers.providerRunId,
                providerOperationKey: likers.operationKey,
                providerCredentialSlot: likers.providerCredentialSlot,
                coverage: raw.likerCoverage,
            };
            commentSource = {
                status: 'collected',
                inputHash: comments.inputHash,
                provider: comments.provider,
                providerRunId: comments.providerRunId,
                providerOperationKey: comments.operationKey,
                providerCredentialSlot: comments.providerCredentialSlot,
                coverage: raw.commentCoverage,
            };
        }

        const raw = extractRawTargetInteractions({
            targetPosts: posts,
            likers: likerRows,
            comments: commentRows,
            excludedUsernames: [
                request.targetUsername,
                ...(request.excludedUsername ? [request.excludedUsername] : []),
            ],
        });
        const inputHash = sha256([
            'analysis-v2-target-evidence-checkpoint-v1',
            request.targetUsername,
            request.excludedUsername ?? '',
            likerSource.inputHash,
            commentSource.inputHash,
        ].join('\n'));
        const manifest = await dependencies.evidenceStore.checkpointTargetEvidence({
            ...claim,
            targetUsername: request.targetUsername,
            excludedUsername: request.excludedUsername,
            inputHash,
            likerSource,
            commentSource,
            rows: raw.evidence,
        });
        return Object.freeze({
            checkpoint: Object.freeze({
                kind: 'target_evidence' as const,
                manifest: Object.freeze({
                    revision: manifest.revision,
                    resultHash: manifest.resultHash,
                    interactorCount: manifest.interactorCount,
                }),
            }),
        });
    };
}

export function createAnalysisV2ProfileFetchExecutor(
    input: AnalysisV2CollectionExecutorDependencies = {}
): AnalysisV2StageExecutor<'profile_fetch'> {
    const dependencies = deps(input);
    return async (context) => {
        const claim = collectionClaim(context);
        const request = await dependencies.requestContextStore.load(claim);
        assertFreshRevenueCollectionRuntime(request, dependencies);
        assertScopeMatchesState(request, context.state);
        if (context.job.batch === null || context.job.batch < 0) {
            throw new Error('ANALYSIS_V2_PROFILE_BATCH_MISMATCH');
        }
        const relationshipStaging = await dependencies.evidenceStore.loadRelationshipStaging({
            requestId: claim.requestId,
            jobKey: 'track:relationships:collect',
        });
        if (!relationshipStaging) throw new Error('ANALYSIS_V2_RELATIONSHIP_STAGING_MISSING');
        const offset = context.job.batch * ANALYSIS_V2_PROFILE_BATCH_LIMIT;
        let allSelectedUsernames = relationshipStaging.detailedPublicUsernames;
        if (isRevenueGenderRoutingRequest(request)) {
            const relationship = context.state.relationships;
            if (!relationship) {
                throw new Error('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_MISSING');
            }
            const cap = GENDER_ROUTING_CAPS[request.planId];
            const publicMutualRows = relationshipStaging.mutualRows
                .filter(row => !row.isPrivate)
                .sort((left, right) => left.mutualOrdinal - right.mutualOrdinal);
            if (
                publicMutualRows.length !== relationship.publicCount
                || publicMutualRows.length > cap.population
                || new Set(publicMutualRows.map(row => row.mutualOrdinal)).size !== publicMutualRows.length
            ) throw new Error('ANALYSIS_V2_GENDER_ROUTING_POPULATION_DRIFT');
            const selectedRows = await dependencies.genderRoutingManifestStore.loadSelectedUsernames({
                requestId: claim.requestId,
                relationshipCheckpointId: relationship.resultHash,
                policyVersion: 'gender-routing-v1',
                planId: request.planId,
            });
            const publicByOrdinal = new Map(publicMutualRows.map(row => [row.mutualOrdinal, row]));
            if (
                selectedRows.length !== relationship.detailedSelectedPublicCount
                || selectedRows.length > cap.detailed
                || selectedRows.some((row, index) => (
                    row.ordinal !== index + 1
                    || row.candidateKey !== `mutual:${row.mutualOrdinal}`
                    || publicByOrdinal.get(row.mutualOrdinal)?.username !== row.username
                ))
                || relationship.profileBatches.reduce((total, batch) => total + batch.itemCount, 0)
                    !== selectedRows.length
            ) throw new Error('ANALYSIS_V2_GENDER_ROUTING_SELECTION_DRIFT');
            allSelectedUsernames = selectedRows.map(row => row.username);
        }
        const usernames = allSelectedUsernames.slice(
            offset,
            offset + ANALYSIS_V2_PROFILE_BATCH_LIMIT
        );
        const topology = context.state.relationships?.profileBatches.find(
            batch => batch.batch === context.job.batch
        );
        if (
            usernames.length === 0
            || !topology
            || topology.itemCount !== usernames.length
            || topology.inputHash !== topologyInputHash('profiles', usernames)
        ) {
            throw new Error('ANALYSIS_V2_PROFILE_BATCH_MISMATCH');
        }
        if (
            request.excludedUsername
            && usernames.includes(request.excludedUsername)
        ) {
            throw new Error('ANALYSIS_V2_GIRLFRIEND_EXCLUSION_LEAK');
        }

        const profileOrdinal = (username: string) => {
            const ordinal = usernames.indexOf(username) + 1;
            return ordinal > 0 ? ordinal : 0;
        };
        const reportProfileStart = context.reportActiveProfile
            ? async (username: string) => {
                await context.reportActiveProfile!(username, undefined, {
                    currentOrdinal: profileOrdinal(username),
                    totalCount: usernames.length,
                    callPhase: 'fetching',
                });
            }
            : undefined;
        const reportProfileResolved = context.reportActiveProfile
            ? async (profile: InstagramProfile) => {
                if (profile.isPrivate) return;
                let preview;
                try {
                    preview = selectAnalysisV2ProgressCandidateMedia(profile);
                } catch {
                    preview = undefined;
                }
                await context.reportActiveProfile!(profile.username, preview, {
                    currentOrdinal: profileOrdinal(profile.username),
                    totalCount: usernames.length,
                    callPhase: 'persisting',
                });
            }
            : undefined;
        const resume = await durableProfiles({
            dependencies,
            claim,
            request,
            usernames,
            onProfileStart: reportProfileStart,
            onProfileResolved: reportProfileResolved,
        });
        const repaired = await repairProfileBatch({
            dependencies,
            claim,
            request,
            usernames,
            resume,
        });
        const results = durableTerminalProfileResults(repaired, usernames);
        return Object.freeze({
            checkpoint: Object.freeze({
                kind: 'profile_fetch_batch' as const,
                manifest: Object.freeze({
                    batch: context.job.batch,
                    itemCount: usernames.length,
                    producerInputHash: context.job.inputHash,
                    revision: 1,
                    resultHash: profileBatchResultHash(usernames, results),
                }),
            }),
        });
    };
}

export function createAnalysisV2CollectionExecutorRegistry(
    input: AnalysisV2CollectionExecutorDependencies = {}
): AnalysisV2StageExecutorRegistry {
    return Object.freeze({
        relationships: createAnalysisV2RelationshipsExecutor(input),
        target_evidence: createAnalysisV2TargetEvidenceExecutor(input),
        profile_fetch: createAnalysisV2ProfileFetchExecutor(input),
    });
}

export const analysisV2CollectionExecutorRegistry =
    createAnalysisV2CollectionExecutorRegistry();
