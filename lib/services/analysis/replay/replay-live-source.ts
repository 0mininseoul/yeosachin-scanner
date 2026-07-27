import { ApifyClient } from 'apify-client';
import { z } from 'zod';
import {
    APIFY_PROFILE_ACTOR_ID,
    APIFY_RELATIONSHIP_ACTOR_ID,
    parseApifyProfileDataset,
    parseApifyRelationshipDataset,
} from '@/lib/services/instagram/providers/apify';
import { APIFY_COMMENTS_ACTOR_ID, APIFY_LIKERS_ACTOR_ID, parseApifyCommentDataset, parseApifyLikerDataset } from '@/lib/services/instagram/providers/apify-interactions';
import { REPLACEMENT_PROFILE_ACTOR } from '@/lib/services/instagram/providers/apify-profile-details';
import {
    instagramPostUrl,
    selectRecentInteractionPosts,
} from '@/lib/services/analysis/interaction-posts';
import { extractRawTargetInteractions } from '@/lib/services/analysis/v2-target-interactions';
import type { AnalysisV2CheckpointProfile } from '@/lib/services/analysis/v2-profile-fetch-store';
import type { AnalysisV2ReplayBundle } from './replay-bundle';
import { readCompletedApifyDatasetOnce, type ReplayReadonlyApifyClient } from './replay-readonly-apify';
import type {
    HistoricalOfficialE2EReplayCaptureDescriptor,
    ReplayCaptureDescriptor,
} from './replay-supabase-repository';

type Run = ReplayCaptureDescriptor['providerRuns'][number];
const record = z.record(z.string(), z.unknown());
const FRESH_TARGET_PROFILE_OPERATION =
    /^target-profile-fresh-admission:g([1-9]|[1-9][0-9]|100)$/;

/** The returned object exposes only Actor/run GET and dataset list operations. */
export function createReplayReadonlyApifyClient(token: string): ReplayReadonlyApifyClient {
    if (!token.trim()) throw new Error('ANALYSIS_V2_REPLAY_APIFY_CREDENTIAL_MISSING');
    const client = new ApifyClient({ token, maxRetries: 0 });
    const actorIds = new Map<string, Promise<string | null>>();
    return {
        resolveActorId: actorSlug => {
            const existing = actorIds.get(actorSlug);
            if (existing) return existing;
            const pending = client.actor(actorSlug).get()
                .then(actor => actor?.id ?? null);
            actorIds.set(actorSlug, pending);
            return pending;
        },
        run: runId => ({ get: async () => {
            const value = await client.run(runId).get();
            return { id: value?.id, actId: value?.actId, status: value?.status, defaultDatasetId: value?.defaultDatasetId };
        } }),
        dataset: datasetId => ({ listItems: async input => {
            const page = await client.dataset(datasetId).listItems(input);
            return { offset: page.offset, count: page.count, total: page.total, items: page.items };
        } }),
    };
}

function operationKind(run: Run): string { return run.operationKey.split(':', 1)[0] ?? ''; }
function assertActorForOperation(run: Run): void {
    const isTargetProfile = run.operationKey === 'target-profile-fallback'
        || FRESH_TARGET_PROFILE_OPERATION.test(run.operationKey);
    const isCandidateProfile = /^(?:profile-fallback|profile-repair):[a-f0-9]{64}$/.test(run.operationKey);
    const isRelationship = /^(?:relationship-followers|relationship-following):[a-f0-9]{64}$/.test(run.operationKey);
    const isLikers = /^(?:target-likers|candidate-likers):[a-f0-9]{64}$/.test(run.operationKey);
    const isComments = /^target-comments:[a-f0-9]{64}$/.test(run.operationKey);
    const allowed = isTargetProfile
        ? [APIFY_PROFILE_ACTOR_ID]
        : isCandidateProfile
            ? [APIFY_PROFILE_ACTOR_ID, REPLACEMENT_PROFILE_ACTOR.actorId]
        : isRelationship
            ? [APIFY_RELATIONSHIP_ACTOR_ID]
            : isLikers
                ? [APIFY_LIKERS_ACTOR_ID]
                : isComments
                    ? [APIFY_COMMENTS_ACTOR_ID]
                    : [];
    if (!allowed.includes(run.actorId)) throw new Error('ANALYSIS_V2_REPLAY_PROVIDER_IDENTITY_MISMATCH');
}
function profileUsernames(items: readonly unknown[]): string[] {
    const values = new Set<string>();
    for (const item of items) {
        const parsed = z.object({ username: z.string().regex(/^[A-Za-z0-9._]{1,30}$/) }).passthrough().safeParse(item);
        if (!parsed.success) throw new Error('ANALYSIS_V2_REPLAY_PROFILE_ATTRIBUTION_MISSING');
        values.add(parsed.data.username.toLowerCase());
    }
    if (!values.size) throw new Error('ANALYSIS_V2_REPLAY_PROFILE_DATASET_EMPTY');
    return [...values];
}

function isProductionAllowedCandidateProfileFailure(error: Error): boolean {
    return error.message.startsWith('SCRAPING_SCHEMA_ERROR:')
        || error.message.startsWith('SCRAPING_INCOMPLETE_ERROR:');
}

type CandidateProfileAttempt =
    | { status: 'success'; profile: AnalysisV2CheckpointProfile }
    | { status: 'failed'; error: Error }
    | { status: 'unavailable' };

function candidateProfileAttempts(input: {
    usernames: readonly string[];
    parsed: ReturnType<typeof parseApifyProfileDataset>;
}): Map<string, CandidateProfileAttempt> | null {
    const attempts = new Map<string, CandidateProfileAttempt>();
    for (const [username, profile] of input.parsed.profilesByUsername) {
        attempts.set(username, { status: 'success', profile: asCheckpoint(profile) });
    }
    for (const [username, error] of input.parsed.failuresByUsername) {
        if (attempts.has(username)) return null;
        attempts.set(username, { status: 'failed', error });
    }
    for (const username of input.parsed.notFoundUsernames) {
        if (attempts.has(username)) return null;
        attempts.set(username, { status: 'unavailable' });
    }
    return input.parsed.datasetContaminated || attempts.size !== input.usernames.length
        ? null
        : attempts;
}

function isProductionCompleteCandidateProfileBatch(
    attempts: readonly CandidateProfileAttempt[],
): boolean {
    const failures = attempts.filter(
        (attempt): attempt is Extract<CandidateProfileAttempt, { status: 'failed' }> => (
            attempt.status === 'failed'
        ),
    );
    const allowedFailures = attempts.length - Math.ceil(0.9 * attempts.length);
    return failures.length <= allowedFailures
        && failures.every(attempt => isProductionAllowedCandidateProfileFailure(attempt.error));
}

function sameOrderedUsernames(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length
        && left.every((username, index) => username === right[index]);
}

function asCheckpoint(profile: ReturnType<typeof parseApifyProfileDataset>['profilesByUsername'] extends Map<string, infer P> ? P : never): AnalysisV2CheckpointProfile {
    return profile as AnalysisV2CheckpointProfile;
}

function postIdFromUrl(value: string): string {
    const parsed = /^https:\/\/(?:www\.)?instagram\.com\/(?:p|reel)\/([A-Za-z0-9_-]+)\/?$/i.exec(value);
    if (!parsed?.[1]) throw new Error('ANALYSIS_V2_REPLAY_INTERACTION_POST_INVALID');
    return parsed[1];
}

function isHistoricalDescriptor(
    descriptor: ReplayCaptureDescriptor | HistoricalOfficialE2EReplayCaptureDescriptor,
): descriptor is HistoricalOfficialE2EReplayCaptureDescriptor {
    return 'targetResolution' in descriptor
        && descriptor.targetResolution === 'provider_ledger';
}

/**
 * Fresh admission is the production target-evidence source when it exists. The earlier
 * preflight fallback is retained in the ledger for cost/audit history but is superseded by the
 * largest fresh-admission generation; selecting by the generation in its operation key is an
 * explicit pipeline rule, not last-write-wins record merging.
 */
function historicalAuthoritativeTargetProfileRuns(runs: readonly Run[]): readonly Run[] {
    const fresh = runs.flatMap(run => {
        const matched = FRESH_TARGET_PROFILE_OPERATION.exec(run.operationKey);
        return matched?.[1] === undefined ? [] : [{ run, generation: Number(matched[1]) }];
    });
    if (fresh.length > 0) {
        const generation = Math.max(...fresh.map(item => item.generation));
        const latest = fresh.filter(item => item.generation === generation);
        if (latest.length !== 1) throw new Error('ANALYSIS_V2_REPLAY_TARGET_PROFILE_MISSING');
        return [latest[0]!.run];
    }
    const fallback = runs.filter(run => run.operationKey === 'target-profile-fallback');
    if (fallback.length !== 1) throw new Error('ANALYSIS_V2_REPLAY_TARGET_PROFILE_MISSING');
    return fallback;
}

export async function loadReplaySourceFromExistingRuns(input: {
    descriptor: ReplayCaptureDescriptor | HistoricalOfficialE2EReplayCaptureDescriptor;
    clientForSlot(slot: string): ReplayReadonlyApifyClient;
}): Promise<{ profiles: AnalysisV2CheckpointProfile[]; evidence: AnalysisV2ReplayBundle['evidence']; providerRuns: Run[] }> {
    const historical = isHistoricalDescriptor(input.descriptor);
    const preflightRuns = historical
        ? historicalAuthoritativeTargetProfileRuns(input.descriptor.preflightRuns)
        : input.descriptor.preflightRuns;
    const allRuns = [...preflightRuns, ...input.descriptor.providerRuns];
    const readState = new Set<string>();
    const datasets = new Map<Run, unknown[]>();
    for (const run of allRuns) {
        assertActorForOperation(run);
        datasets.set(run, await readCompletedApifyDatasetOnce({
            client: input.clientForSlot(run.credentialSlot), runId: run.runId,
            expected: { actorId: run.actorId, credentialSlot: run.credentialSlot, runId: run.runId },
            ledger: { actorId: run.actorId, credentialSlot: run.credentialSlot, runId: run.runId }, readState,
        }));
    }

    const profiles = new Map<string, AnalysisV2CheckpointProfile>();
    const terminalCandidateProfileUsernames = new Set<string>();
    const fallbackBatches: Array<Map<string, CandidateProfileAttempt>> = [];
    const fallbackUsernames = new Set<string>();
    const repairBatches: Array<Map<string, CandidateProfileAttempt>> = [];
    for (const [run, items] of datasets) {
        const kind = operationKind(run);
        if (![
            'target-profile-fallback',
            'target-profile-fresh-admission',
            'profile-fallback',
            'profile-repair',
        ].includes(kind)) continue;
        const usernames = profileUsernames(items);
        const parsed = parseApifyProfileDataset(items, usernames);
        const isCandidateProfile = kind === 'profile-fallback' || kind === 'profile-repair';
        if (isCandidateProfile) {
            const attempts = candidateProfileAttempts({ usernames, parsed });
            if (!attempts) throw new Error('ANALYSIS_V2_REPLAY_PROFILE_DATASET_INVALID');
            if (kind === 'profile-fallback') {
                for (const username of attempts.keys()) {
                    if (fallbackUsernames.has(username)) {
                        throw new Error('ANALYSIS_V2_REPLAY_PROFILE_DATASET_INVALID');
                    }
                    fallbackUsernames.add(username);
                }
                fallbackBatches.push(attempts);
            } else {
                repairBatches.push(attempts);
            }
            continue;
        }
        if (
            parsed.datasetContaminated
            || parsed.failuresByUsername.size > 0
            || parsed.notFoundUsernames.size > 0
            || parsed.profilesByUsername.size !== usernames.length
        ) {
            throw new Error('ANALYSIS_V2_REPLAY_PROFILE_DATASET_INVALID');
        }
        for (const [username, profile] of parsed.profilesByUsername) {
            const mapped = asCheckpoint(profile);
            const existing = profiles.get(username);
            if (existing && JSON.stringify(existing) !== JSON.stringify(mapped)) throw new Error('ANALYSIS_V2_REPLAY_PROFILE_DUPLICATE_DRIFT');
            profiles.set(username, mapped);
        }
    }
    const repairedFallbackBatches = new Set<Map<string, CandidateProfileAttempt>>();
    for (const repair of repairBatches) {
        const repairUsernames = [...repair.keys()];
        const matchingFallbackBatches = fallbackBatches.filter(batch => (
            sameOrderedUsernames(
                repairUsernames,
                [...batch].flatMap(([username, attempt]) => (
                    attempt.status === 'failed' ? [username] : []
                )),
            )
        ));
        if (matchingFallbackBatches.length !== 1) {
            throw new Error('ANALYSIS_V2_REPLAY_PROFILE_DATASET_INVALID');
        }
        const fallback = matchingFallbackBatches[0]!;
        if (
            repairedFallbackBatches.has(fallback)
            || isProductionCompleteCandidateProfileBatch([...fallback.values()])
        ) {
            throw new Error('ANALYSIS_V2_REPLAY_PROFILE_DATASET_INVALID');
        }
        repairedFallbackBatches.add(fallback);
        for (const [username, attempt] of repair) fallback.set(username, attempt);
    }
    for (const batch of fallbackBatches) {
        const finalAttempts = [...batch.values()];
        if (!isProductionCompleteCandidateProfileBatch(finalAttempts)) {
            throw new Error('ANALYSIS_V2_REPLAY_PROFILE_DATASET_INVALID');
        }
        for (const [username, attempt] of batch) {
            if (attempt.status !== 'success') {
                if (profiles.has(username)) {
                    throw new Error('ANALYSIS_V2_REPLAY_PROFILE_DATASET_INVALID');
                }
                terminalCandidateProfileUsernames.add(username);
                continue;
            }
            if (terminalCandidateProfileUsernames.has(username)) {
                throw new Error('ANALYSIS_V2_REPLAY_PROFILE_DATASET_INVALID');
            }
            const existing = profiles.get(username);
            if (existing && JSON.stringify(existing) !== JSON.stringify(attempt.profile)) {
                throw new Error('ANALYSIS_V2_REPLAY_PROFILE_DUPLICATE_DRIFT');
            }
            profiles.set(username, attempt.profile);
        }
    }
    const targetUsername = historical
        ? replayTargetUsernameFromProviderLedger(datasets)
        : input.descriptor.targetUsername;
    const targetProfile = profiles.get(targetUsername);
    if (!targetProfile) throw new Error('ANALYSIS_V2_REPLAY_TARGET_PROFILE_MISSING');

    const relationship: AnalysisV2ReplayBundle['evidence']['relationship'] = [];
    for (const [run, items] of datasets) {
        const kind = operationKind(run);
        if (kind !== 'relationship-followers' && kind !== 'relationship-following') continue;
        const side = kind === 'relationship-followers' ? 'followers' as const : 'following' as const;
        const parsed = parseApifyRelationshipDataset(items.map(item => record.parse(item)), targetUsername, side, 1_200);
        parsed.forEach((row, index) => relationship.push({ username: row.username.toLowerCase(), side: side === 'followers' ? 'follower' : 'following', isPrivate: row.isPrivate, isVerified: row.isVerified, fullName: row.fullName ?? null, ordinal: index + 1 }));
    }
    if (!relationship.some(row => row.side === 'follower') || !relationship.some(row => row.side === 'following')) throw new Error('ANALYSIS_V2_REPLAY_RELATIONSHIP_DATASET_MISSING');
    const followers = new Set(relationship.filter(row => row.side === 'follower').map(row => row.username));
    const mutual = new Map(relationship.filter(row => row.side === 'following' && followers.has(row.username)).map(row => [row.username, row]));

    const targetPosts = targetProfile.latestPosts ?? [];
    const likerPostUrls = selectRecentInteractionPosts([...targetPosts], 4).map(instagramPostUrl);
    const commentPostUrls = selectRecentInteractionPosts([...targetPosts], 6).map(instagramPostUrl);
    let targetLikers: ReturnType<typeof parseApifyLikerDataset> = [];
    let targetComments: ReturnType<typeof parseApifyCommentDataset>['comments'] = [];
    for (const [run, items] of datasets) {
        const kind = operationKind(run);
        if (kind === 'target-likers') {
            targetLikers = parseApifyLikerDataset(items, likerPostUrls, 150);
        } else if (kind === 'target-comments') {
            targetComments = parseApifyCommentDataset(items, commentPostUrls, 15).comments;
        }
    }
    if (!allRuns.some(run => operationKind(run) === 'target-likers') || !allRuns.some(run => operationKind(run) === 'target-comments')) throw new Error('ANALYSIS_V2_REPLAY_TARGET_INTERACTION_DATASET_MISSING');
    const extractedTarget = extractRawTargetInteractions({
        targetPosts,
        likers: targetLikers,
        comments: targetComments,
        excludedUsernames: [targetUsername],
    });
    const targetInteractions: AnalysisV2ReplayBundle['evidence']['targetInteractions'] =
        extractedTarget.evidence.map(row => ({
            actorUsername: row.actorUsername,
            postId: row.postId,
            signal: row.signal,
            sourceInteractionId: row.sourceInteractionId,
            occurredAt: row.occurredAt ?? null,
            content: row.content ?? null,
        }));

    const postOwner = new Map<string, {
        username: string;
        post: NonNullable<AnalysisV2CheckpointProfile['latestPosts']>[number];
    }>();
    for (const [username, profile] of profiles) {
        for (const post of profile.latestPosts ?? []) {
            postOwner.set(post.shortCode, { username, post });
        }
    }
    const reverseByCandidate = new Map<string, AnalysisV2ReplayBundle['evidence']['reverseInteractions'][number]>();
    for (const [run, items] of datasets) {
        if (operationKind(run) !== 'candidate-likers') continue;
        if (items.length === 0) throw new Error('ANALYSIS_V2_REPLAY_REVERSE_ATTRIBUTION_MISSING');
        const urls = [...new Set(items.map(item => {
            const parsed = z.object({ liked_post: z.string().url() }).passthrough().parse(item);
            return parsed.liked_post;
        }))];
        const likers = parseApifyLikerDataset(items, urls, 100);
        for (const url of urls) {
            const owner = postOwner.get(postIdFromUrl(url));
            if (!owner) throw new Error('ANALYSIS_V2_REPLAY_REVERSE_ATTRIBUTION_MISSING');
            const usernames = new Set(likers
                .filter(row => row.postUrl === url)
                .map(row => row.username.toLowerCase()));
            const observed = usernames.has(targetUsername);
            const absenceConfirmed = owner.post.likesCountHidden !== true
                && owner.post.likesCount <= 100
                && usernames.size >= owner.post.likesCount;
            reverseByCandidate.set(owner.username, {
                candidateUsername: owner.username,
                postId: owner.post.id,
                status: observed
                    ? 'observed'
                    : absenceConfirmed
                        ? 'not_observed'
                        : 'not_collected',
            });
        }
    }
    const reverseInteractions = [...reverseByCandidate.values()]
        .filter(row => mutual.has(row.candidateUsername));

    const profileList = [...mutual.values()].flatMap(row => {
        const detailed = profiles.get(row.username);
        if (detailed) return [detailed];
        // These are the exact terminal `failed`/`unavailable` outcomes production permits
        // below the per-batch 90% profile-evidence floor. They have no profile media and
        // therefore no AI workload; accepting only this recorded set preserves the old
        // fail-closed check for public accounts absent from the retained Apify evidence.
        if (terminalCandidateProfileUsernames.has(row.username)) return [];
        if (!row.isPrivate) {
            // Completed requests purge selfhosted profile checkpoints. Never treat the
            // surviving Apify fallback subset as an exact AI workload benchmark.
            throw new Error('ANALYSIS_V2_REPLAY_EXACT_PUBLIC_COVERAGE_INCOMPLETE');
        }
        return [{ username: row.username, fullName: row.fullName ?? undefined, followersCount: 0, followingCount: 0, postsCount: 0, isPrivate: true, isVerified: row.isVerified } satisfies AnalysisV2CheckpointProfile];
    });
    return { profiles: profileList, evidence: { relationship, targetInteractions, reverseInteractions }, providerRuns: input.descriptor.providerRuns };
}

/** Only the explicit historical descriptor derives a target from provider data. */
function replayTargetUsernameFromProviderLedger(
    datasets: ReadonlyMap<Run, unknown[]>,
): string {
    const targetProfileUsernames = new Set<string>();
    for (const [run, items] of datasets) {
        if (
            run.operationKey !== 'target-profile-fallback'
            && !FRESH_TARGET_PROFILE_OPERATION.test(run.operationKey)
        ) continue;
        for (const username of profileUsernames(items)) targetProfileUsernames.add(username);
    }
    if (targetProfileUsernames.size !== 1) {
        throw new Error('ANALYSIS_V2_REPLAY_TARGET_PROFILE_MISSING');
    }
    return [...targetProfileUsernames][0]!;
}
