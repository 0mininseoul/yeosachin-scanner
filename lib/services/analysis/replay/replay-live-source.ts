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
import type { ReplayCaptureDescriptor } from './replay-supabase-repository';

type Run = ReplayCaptureDescriptor['providerRuns'][number];
const record = z.record(z.string(), z.unknown());

/** The returned object has no Actor/start/update/delete/abort methods. */
export function createReplayReadonlyApifyClient(token: string): ReplayReadonlyApifyClient {
    if (!token.trim()) throw new Error('ANALYSIS_V2_REPLAY_APIFY_CREDENTIAL_MISSING');
    const client = new ApifyClient({ token, maxRetries: 0 });
    return {
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
        || /^target-profile-fresh-admission:g(?:[1-9]|[1-9][0-9]|100)$/.test(run.operationKey);
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

function asCheckpoint(profile: ReturnType<typeof parseApifyProfileDataset>['profilesByUsername'] extends Map<string, infer P> ? P : never): AnalysisV2CheckpointProfile {
    return profile as AnalysisV2CheckpointProfile;
}

function postIdFromUrl(value: string): string {
    const parsed = /^https:\/\/(?:www\.)?instagram\.com\/(?:p|reel)\/([A-Za-z0-9_-]+)\/?$/i.exec(value);
    if (!parsed?.[1]) throw new Error('ANALYSIS_V2_REPLAY_INTERACTION_POST_INVALID');
    return parsed[1];
}

export async function loadReplaySourceFromExistingRuns(input: {
    descriptor: ReplayCaptureDescriptor;
    clientForSlot(slot: string): ReplayReadonlyApifyClient;
}): Promise<{ profiles: AnalysisV2CheckpointProfile[]; evidence: AnalysisV2ReplayBundle['evidence']; providerRuns: Run[] }> {
    const allRuns = [...input.descriptor.preflightRuns, ...input.descriptor.providerRuns];
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
    for (const [run, items] of datasets) {
        if (![
            'target-profile-fallback',
            'target-profile-fresh-admission',
            'profile-fallback',
            'profile-repair',
        ].includes(operationKind(run))) continue;
        const usernames = profileUsernames(items);
        const parsed = parseApifyProfileDataset(items, usernames);
        if (parsed.datasetContaminated || parsed.failuresByUsername.size || parsed.notFoundUsernames.size || parsed.profilesByUsername.size !== usernames.length) {
            throw new Error('ANALYSIS_V2_REPLAY_PROFILE_DATASET_INVALID');
        }
        for (const [username, profile] of parsed.profilesByUsername) {
            const mapped = asCheckpoint(profile);
            const existing = profiles.get(username);
            if (existing && JSON.stringify(existing) !== JSON.stringify(mapped)) throw new Error('ANALYSIS_V2_REPLAY_PROFILE_DUPLICATE_DRIFT');
            profiles.set(username, mapped);
        }
    }
    const targetProfile = profiles.get(input.descriptor.targetUsername);
    if (!targetProfile) throw new Error('ANALYSIS_V2_REPLAY_TARGET_PROFILE_MISSING');

    const relationship: AnalysisV2ReplayBundle['evidence']['relationship'] = [];
    for (const [run, items] of datasets) {
        const kind = operationKind(run);
        if (kind !== 'relationship-followers' && kind !== 'relationship-following') continue;
        const side = kind === 'relationship-followers' ? 'followers' as const : 'following' as const;
        const parsed = parseApifyRelationshipDataset(items.map(item => record.parse(item)), input.descriptor.targetUsername, side, 1_200);
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
        excludedUsernames: [input.descriptor.targetUsername],
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
            const observed = usernames.has(input.descriptor.targetUsername);
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

    const profileList = [...mutual.values()].map(row => {
        const detailed = profiles.get(row.username);
        if (detailed) return detailed;
        if (!row.isPrivate) throw new Error('ANALYSIS_V2_REPLAY_PUBLIC_PROFILE_MISSING');
        return { username: row.username, fullName: row.fullName ?? undefined, followersCount: 0, followingCount: 0, postsCount: 0, isPrivate: true, isVerified: row.isVerified } satisfies AnalysisV2CheckpointProfile;
    });
    return { profiles: profileList, evidence: { relationship, targetInteractions, reverseInteractions }, providerRuns: input.descriptor.providerRuns };
}
