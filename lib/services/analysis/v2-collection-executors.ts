import { createHash } from 'node:crypto';
import { getAnalysisPlan } from '@/lib/domain/analysis/plan-catalog';
import type { ProfileAttemptResult, ProviderCallContext, ProviderRunCheckpoint } from '@/lib/services/instagram/providers/types';
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
    numberSetting,
} from '@/lib/services/instagram/providers/apify-relationship';
import { APIFY_RELATIONSHIP_ACTOR_ID } from '@/lib/services/instagram/providers/apify';
import { REPLACEMENT_PROFILE_ACTOR } from '@/lib/services/instagram/providers/apify-profile-details';
import {
    getFollowers,
    getFollowing,
    getProfilesBatchV2,
    type ProfilesBatchV2AttemptSnapshot,
} from '@/lib/services/instagram/scraper';
import type { InstagramFollower, InstagramPost, InstagramProfile } from '@/lib/types/instagram';
import { instagramPostUrl, selectRecentInteractionPosts } from './interaction-posts';
import {
    ANALYSIS_V2_PROFILE_BATCH_LIMIT,
    ANALYSIS_V2_PRIVATE_NAME_BATCH_LIMIT,
    type AnalysisV2DagBatchManifest,
} from './v2-dag-planner';
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
    analysisV2CollectionRequestContextStore,
    type AnalysisV2CollectionJobClaim,
    type AnalysisV2CollectionRequestContext,
    type AnalysisV2CollectionRequestContextStore,
} from './v2-request-context';
import {
    canonicalProviderInput,
    checkedMaximumCharge,
    lengthPrefixed,
} from './v2-provider-identity';
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
    resolveAnalysisV2ApifyCredentialSlot,
    type AuthorizedTestProviderOperationKind,
} from './authorized-test-provider-policy';

const PROFILE_ACTOR_ID = 'apify/instagram-profile-scraper';
const TARGET_LIKER_LIMIT = 150;
const TARGET_COMMENT_LIMIT = 15;
const TARGET_LIKER_POST_LIMIT = 4;
const TARGET_COMMENT_POST_LIMIT = 6;

type RelationshipGetter = typeof getFollowers;
type ProfileBatchFetcher = typeof getProfilesBatchV2;
type ProfileRepairRunner = typeof runAnalysisV2ProfileRepair;

export interface AnalysisV2CollectionExecutorDependencies {
    requestContextStore?: AnalysisV2CollectionRequestContextStore;
    evidenceStore?: AnalysisV2EvidenceStore;
    profileCheckpointStore?: AnalysisV2ProfileFetchCheckpointStore;
    providerRunStore?: AnalysisV2ProviderRunStore;
    targetProfileReuseStore?: AnalysisV2TargetProfileReuseStore;
    getFollowers?: RelationshipGetter;
    getFollowing?: RelationshipGetter;
    getProfilesBatchV2?: ProfileBatchFetcher;
    runProfileRepair?: ProfileRepairRunner;
    interactionAdapter?: ApifyInteractionAdapter;
    env?: Record<string, string | undefined>;
}

interface ResolvedDependencies {
    requestContextStore: AnalysisV2CollectionRequestContextStore;
    evidenceStore: AnalysisV2EvidenceStore;
    profileCheckpointStore: AnalysisV2ProfileFetchCheckpointStore;
    providerRunStore: AnalysisV2ProviderRunStore;
    targetProfileReuseStore: AnalysisV2TargetProfileReuseStore;
    getFollowers: RelationshipGetter;
    getFollowing: RelationshipGetter;
    getProfilesBatchV2: ProfileBatchFetcher;
    runProfileRepair: ProfileRepairRunner;
    interactionAdapter: ApifyInteractionAdapter;
    env: Record<string, string | undefined>;
}

function deps(input: AnalysisV2CollectionExecutorDependencies): ResolvedDependencies {
    return {
        requestContextStore: input.requestContextStore ?? analysisV2CollectionRequestContextStore,
        evidenceStore: input.evidenceStore ?? analysisV2EvidenceStore,
        profileCheckpointStore:
            input.profileCheckpointStore ?? analysisV2ProfileFetchCheckpointStore,
        providerRunStore: input.providerRunStore ?? analysisV2ProviderRunStore,
        targetProfileReuseStore:
            input.targetProfileReuseStore ?? analysisV2TargetProfileReuseStore,
        getFollowers: input.getFollowers ?? getFollowers,
        getFollowing: input.getFollowing ?? getFollowing,
        getProfilesBatchV2: input.getProfilesBatchV2 ?? getProfilesBatchV2,
        runProfileRepair: input.runProfileRepair ?? runAnalysisV2ProfileRepair,
        interactionAdapter: input.interactionAdapter ?? apifyInteractionAdapter,
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

function relationshipMaximumCharge(
    declaredCount: number,
    env: Record<string, string | undefined>
): number {
    const costPerResult = numberSetting(
        env,
        'APIFY_RELATIONSHIP_ESTIMATED_COST_PER_RESULT_USD',
        0.00085,
        0,
        100
    );
    const maximum = numberSetting(
        env,
        'APIFY_RELATIONSHIP_MAX_ESTIMATED_COST_USD_PER_OPERATION',
        1.1,
        0.00000001,
        100_000
    );
    return checkedMaximumCharge(Math.max(25, declaredCount) * costPerResult, maximum, 'relationship');
}

function profileMaximumCharge(
    count: number,
    env: Record<string, string | undefined>
): number {
    const costPerResult = numberSetting(
        env,
        'APIFY_PROFILE_ESTIMATED_COST_PER_RESULT_USD',
        0.0026,
        0,
        100
    );
    const maximum = numberSetting(
        env,
        'APIFY_PROFILE_MAX_ESTIMATED_COST_USD_PER_OPERATION',
        1,
        0.00000001,
        100_000
    );
    return checkedMaximumCharge(count * costPerResult, maximum, 'profile fallback');
}

function interactionMaximumCharge(
    kind: 'likers' | 'comments',
    postCount: number,
    limitPerPost: number,
    env: Record<string, string | undefined>
): number {
    const prefix = kind === 'likers' ? 'APIFY_LIKERS' : 'APIFY_COMMENTS';
    const defaultCost = kind === 'likers' ? 0.00155 : 0.0026;
    const costPerResult = numberSetting(
        env,
        `${prefix}_ESTIMATED_COST_PER_RESULT_USD`,
        defaultCost,
        0.00000001,
        100
    );
    const maximum = numberSetting(
        env,
        `${prefix}_MAX_ESTIMATED_COST_USD_PER_OPERATION`,
        (kind === 'likers' ? 1_500 : 90) * defaultCost,
        0.00000001,
        100_000
    );
    return checkedMaximumCharge(
        postCount * limitPerPost * costPerResult,
        maximum,
        `target ${kind}`
    );
}

async function bindApifyRun(input: {
    dependencies: ResolvedDependencies;
    claim: AnalysisV2CollectionJobClaim;
    request: AnalysisV2CollectionRequestContext;
    operation: AuthorizedTestProviderOperationKind;
    operationKey: string;
    inputHash: string;
    actorId: string;
    maxChargeUsd: number;
}) {
    return input.dependencies.providerRunStore.bindAdapterCheckpoint({
        requestId: input.claim.requestId,
        jobKey: input.claim.jobKey,
        claimToken: input.claim.claimToken,
        operationKey: input.operationKey,
        inputHash: input.inputHash,
        logicalProvider: 'apify',
        actorId: input.actorId,
        credentialSlot: resolveAnalysisV2ApifyCredentialSlot({
            accessMode: input.request.accessMode,
            policy: input.request.providerExecutionPolicy,
            operation: input.operation,
            env: input.dependencies.env,
        }),
        maxChargeUsd: input.maxChargeUsd,
    });
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

function canonicalRelationshipIdentity(input: {
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
        assertScopeMatchesState(request, context.state);

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
            const canonicalInput = canonicalRelationshipIdentity({
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
            const execute = async (providerInput: string) => {
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
                const rows = await getter(request.targetUsername, declaredCount, {
                    provider: 'apify',
                    fallback: false,
                    expectedResultCount: declaredCount,
                    requestId: claim.requestId,
                    providerRun: { ...binding.checkpoint, startCancellationSignal },
                });
                const run = await requireSucceededRun(dependencies.providerRunStore, {
                    requestId: claim.requestId,
                    jobKey: claim.jobKey,
                    operationKey,
                });
                return { inputHash, operationKey, rows, run };
            };

            const initialOperationKey = createAnalysisV2ProviderOperationKey(
                operation,
                canonicalInput
            );
            let completed: Awaited<ReturnType<typeof execute>>;
            try {
                completed = await execute(canonicalInput);
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
                if (!isReconciledSucceededRun(initialRun)) throw error;
                completed = await execute(
                    relationshipIncompleteReplacementIdentity(canonicalInput)
                );
            }
            return dependencies.evidenceStore.checkpointRelationshipSide({
                ...claim,
                side,
                declaredCount,
                source: {
                    status: 'collected',
                    inputHash: completed.inputHash,
                    provider: 'apify',
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

        return Object.freeze({
            checkpoint: Object.freeze({
                kind: 'relationships' as const,
                manifest: Object.freeze({
                    revision: manifest.revision,
                    resultHash: manifest.resultHash,
                    detectedMutualCount: manifest.mutualCount,
                    publicCount: manifest.publicCount,
                    privateCount: manifest.privateCount,
                    detailedSelectedPublicCount: manifest.detailedPublicCount,
                    notScreenedPublicCount: manifest.unscreenedPublicCount,
                    profileBatches: createAnalysisV2CollectionTopology(
                        'profiles',
                        staging.detailedPublicUsernames
                    ),
                    privateNameBatches: createAnalysisV2CollectionTopology(
                        'private_names',
                        staging.privateMutualUsernames
                    ),
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

async function durableProfiles(input: {
    dependencies: ResolvedDependencies;
    claim: AnalysisV2CollectionJobClaim;
    request: AnalysisV2CollectionRequestContext;
    usernames: readonly string[];
    onProfileStart?: (username: string) => Promise<void>;
}): Promise<AnalysisV2ProfileFetchResume> {
    const { dependencies, claim, request, usernames, onProfileStart } = input;
    const identity = profileIdentity(claim);
    let resume = await dependencies.profileCheckpointStore.load(identity);
    if (
        resume
        && (resume.frozenUnresolvedUsernames.length === 0 || resume.fallbackCapturedAt !== null)
    ) return resume;

    const mutableProviderRun: ProviderRunCheckpoint = {};
    const bindFallback = async (unresolved: readonly string[]) => {
        if (unresolved.length === 0) return;
        if (claim.jobKey === 'track:target-evidence:collect') {
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
    };

    if (resume) await bindFallback(resume.frozenUnresolvedUsernames);

    await dependencies.getProfilesBatchV2(usernames, {
        requestId: claim.requestId,
        onProfileStart,
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
                await bindFallback(resume.frozenUnresolvedUsernames);
                return;
            }
            resume = await dependencies.profileCheckpointStore.checkpointFallback({
                ...identity,
                results: checkpointAttemptResults(snapshot.results),
            });
        },
    });

    const stored = await dependencies.profileCheckpointStore.load(identity);
    if (!stored) throw new Error('ANALYSIS_V2_PROFILE_CHECKPOINT_MISSING');
    return stored;
}

/**
 * One at-most-once repair pass over a profile batch that the primary+fallback merge left short of
 * the 90% gate. It runs the pinned replacement Actor over only the still-failed frozen-unresolved
 * subset, checkpoints those outcomes as the third `repair` attempt, and returns the merged resume
 * for the gate to re-evaluate. Every non-repair path is a no-op that returns `resume` untouched and
 * spends nothing.
 */
async function repairProfileBatch(input: {
    dependencies: ResolvedDependencies;
    claim: AnalysisV2CollectionJobClaim;
    request: AnalysisV2CollectionRequestContext;
    usernames: readonly string[];
    resume: AnalysisV2ProfileFetchResume;
}): Promise<AnalysisV2ProfileFetchResume> {
    const { dependencies, claim, request, usernames, resume } = input;
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

    const identity = profileIdentity(claim);
    const canonicalInput = profileRepairIdentity(repairUsernames);
    const mutableProviderRun: ProviderRunCheckpoint = {};
    const binding = await bindApifyRun({
        dependencies,
        claim,
        request,
        // The repair run gets its OWN ledger row under the profile-repair operation key, but
        // resolves its credential slot through the profile-fallback slot: no eighth slot is added
        // to the persisted seven-key policy.
        operation: 'profile-fallback',
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
    const outcomes = await dependencies.runProfileRepair({
        usernames: repairUsernames,
        credentialSlot,
        providerRunCheckpoint: mutableProviderRun,
        env: dependencies.env,
    });
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
    startCancellationSignal: AbortSignal;
}) {
    const limitPerPost = input.kind === 'likers' ? TARGET_LIKER_LIMIT : TARGET_COMMENT_LIMIT;
    const postUrls = input.posts.map(instagramPostUrl);
    const canonicalInput = canonicalProviderInput([
        `target-${input.kind}-v2`,
        input.targetUsername,
        String(limitPerPost),
        ...postUrls,
    ]);
    const operationKey = createAnalysisV2ProviderOperationKey(
        input.kind === 'likers' ? 'target-likers' : 'target-comments',
        canonicalInput
    );
    const inputHash = createAnalysisV2ProviderInputHash(canonicalInput);
    const binding = await bindApifyRun({
        dependencies: input.dependencies,
        claim: input.claim,
        request: input.request,
        operation: input.kind === 'likers' ? 'target-likers' : 'target-comments',
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
    const rows = input.kind === 'likers'
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
    const run = await requireSucceededRun(input.dependencies.providerRunStore, {
        requestId: input.claim.requestId,
        jobKey: input.claim.jobKey,
        operationKey,
    });
    return { rows, run, operationKey, inputHash };
}

export function createAnalysisV2TargetEvidenceExecutor(
    input: AnalysisV2CollectionExecutorDependencies = {}
): AnalysisV2StageExecutor<'target_evidence'> {
    const dependencies = deps(input);
    return async (context) => {
        const claim = collectionClaim(context);
        const request = await dependencies.requestContextStore.load(claim);
        assertScopeMatchesState(request, context.state);
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
                    startCancellationSignal: signal,
                }),
                signal => collectedTargetSource({
                    dependencies,
                    claim,
                    request,
                    targetUsername: request.targetUsername,
                    kind: 'comments',
                    posts: commentPosts,
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
                provider: 'apify',
                providerRunId: likers.run.runId,
                providerOperationKey: likers.operationKey,
                providerCredentialSlot: likers.run.credentialSlot,
                coverage: raw.likerCoverage,
            };
            commentSource = {
                status: 'collected',
                inputHash: comments.inputHash,
                provider: 'apify',
                providerRunId: comments.run.runId,
                providerOperationKey: comments.operationKey,
                providerCredentialSlot: comments.run.credentialSlot,
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
        const usernames = relationshipStaging.detailedPublicUsernames.slice(
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

        const resume = await durableProfiles({
            dependencies,
            claim,
            request,
            usernames,
            onProfileStart: context.reportActiveProfile,
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
