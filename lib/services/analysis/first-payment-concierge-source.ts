import { z } from 'zod';
import type { InstagramProfile } from '@/lib/types/instagram';
import {
    APIFY_PROFILE_ACTOR_ID,
    APIFY_RELATIONSHIP_ACTOR_ID,
    attributedApifyProfileUsername,
    attributedProfileActorErrorUsername,
    parseApifyProfileDataset,
    parseApifyRelationshipDataset,
} from '@/lib/services/instagram/providers/apify';
import {
    APIFY_COMMENTS_ACTOR_ID,
    APIFY_LIKERS_ACTOR_ID,
    parseApifyCommentDataset,
    parseApifyLikerDataset,
} from '@/lib/services/instagram/providers/apify-interactions';
import { REPLACEMENT_PROFILE_ACTOR } from '@/lib/services/instagram/providers/apify-profile-details';
import { extractRawTargetInteractions } from './v2-target-interactions';
import type { ReplayReadonlyApifyClient } from './replay/replay-readonly-apify';

const sourceLabelSchema = z.enum(['original', 'policy', 'transient', 'last']);
const runSchema = z.object({
    sourceLabel: sourceLabelSchema,
    actorId: z.string().min(1).max(255),
    credentialSlot: z.string().regex(/^[a-z]{3,24}$/),
    runId: z.string().min(1).max(128),
    ledgerStatus: z.string().min(1).max(64),
    operationKey: z.string().min(1).max(255),
    jobKey: z.string().min(1).max(255).optional(),
}).strict();

export const firstPaymentConciergeRecoverySourceSchema = z.object({
    schemaVersion: z.literal(2),
    descriptorHash: z.string().regex(/^[a-f0-9]{64}$/),
    preflightRuns: z.array(runSchema).length(4),
    providerRuns: z.array(runSchema).length(15),
    schedulerOperations: z.array(z.object({
        jobKey: z.string().min(1).max(255),
        operationKey: z.string().min(1).max(255),
        stage: z.string().min(1).max(64),
        status: z.literal('ready'),
        result: z.unknown(),
    }).strict()).length(22),
}).strict();

export type FirstPaymentConciergeRecoverySource = z.infer<
    typeof firstPaymentConciergeRecoverySourceSchema
>;
export type FirstPaymentConciergeRun = z.infer<typeof runSchema>;

export interface FirstPaymentConciergeRelationshipRow {
    username: string;
    fullName: string | null;
    profilePicUrl: string | null;
    isPrivate: boolean;
    isVerified: boolean;
    mutualOrdinal: number;
}

export interface FirstPaymentConciergeSource {
    descriptorHash: string;
    targetProfile: InstagramProfile;
    followersDeclared: number;
    followersCollected: number;
    followingDeclared: number;
    followingCollected: number;
    mutualRows: readonly FirstPaymentConciergeRelationshipRow[];
    publicProfiles: readonly Readonly<{
        ordinal: number;
        profile: InstagramProfile;
    }>[];
    publicUnavailableRows: readonly FirstPaymentConciergeRelationshipRow[];
    privateRows: readonly FirstPaymentConciergeRelationshipRow[];
    targetInteractions: readonly Readonly<{
        actorUsername: string;
        postId: string;
        signal: 'target_post_like' | 'target_post_comment';
        sourceInteractionId: string;
        occurredAt?: string;
        content?: string;
    }>[];
    /** Optional retained reverse-like observations; no collection is performed here. */
    reverseInteractions?: readonly Readonly<{
        candidateUsername: string;
        postId: string;
        status: 'observed' | 'not_observed' | 'not_collected';
    }>[];
}

type LoadedRun = FirstPaymentConciergeRun & { items: readonly unknown[] };

const sourcePriority: Readonly<Record<z.infer<typeof sourceLabelSchema>, number>> = {
    original: 1,
    policy: 2,
    transient: 3,
    last: 4,
};

function fail(code: string): never {
    throw new Error(code);
}

function normalizedUsername(value: string): string {
    const normalized = value.trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(normalized)) {
        fail('FIRST_PAYMENT_CONCIERGE_SOURCE_INVALID');
    }
    return normalized;
}

function operationKind(run: FirstPaymentConciergeRun): string {
    return run.operationKey.split(':', 1)[0] ?? '';
}

function assertRunIdentity(run: FirstPaymentConciergeRun): void {
    const kind = operationKind(run);
    const expectedActors = kind === 'target-profile-fallback'
        || kind === 'target-profile-fresh-admission'
        || kind === 'profile-fallback'
        || kind === 'profile-repair'
        ? new Set([APIFY_PROFILE_ACTOR_ID, REPLACEMENT_PROFILE_ACTOR.actorId])
        : kind === 'relationship-followers' || kind === 'relationship-following'
            ? new Set([APIFY_RELATIONSHIP_ACTOR_ID])
            : kind === 'target-likers'
                ? new Set([APIFY_LIKERS_ACTOR_ID])
                : kind === 'target-comments'
                    ? new Set([APIFY_COMMENTS_ACTOR_ID])
                    : new Set<string>();
    if (!expectedActors.has(run.actorId)) {
        fail('FIRST_PAYMENT_CONCIERGE_PROVIDER_IDENTITY_MISMATCH');
    }
}

async function readDataset(
    run: FirstPaymentConciergeRun,
    client: ReplayReadonlyApifyClient,
): Promise<readonly unknown[]> {
    assertRunIdentity(run);
    const expectedActorId = await client.resolveActorId(run.actorId);
    const remote = await client.run(run.runId).get();
    if (
        !expectedActorId
        || remote?.id !== run.runId
        || remote.actId !== expectedActorId
        || !remote.defaultDatasetId
        || !['SUCCEEDED', 'ABORTED'].includes(remote.status ?? '')
    ) {
        fail('FIRST_PAYMENT_CONCIERGE_PROVIDER_IDENTITY_MISMATCH');
    }
    const result: unknown[] = [];
    let offset = 0;
    let total: number | undefined;
    do {
        const page = await client.dataset(remote.defaultDatasetId).listItems({
            offset,
            limit: 1_000,
        });
        if (
            page.offset !== offset
            || !Number.isSafeInteger(page.count)
            || page.count !== page.items.length
            || !Number.isSafeInteger(page.total)
            || page.total < 0
            || page.total > 5_000
            || (total !== undefined && total !== page.total)
        ) {
            fail('FIRST_PAYMENT_CONCIERGE_DATASET_ENVELOPE_INVALID');
        }
        total = page.total;
        result.push(...page.items);
        offset += page.count;
        if (page.count === 0 && offset < total) {
            fail('FIRST_PAYMENT_CONCIERGE_DATASET_ENVELOPE_INVALID');
        }
    } while (offset < (total ?? 0));
    if (result.length !== total) {
        fail('FIRST_PAYMENT_CONCIERGE_DATASET_ENVELOPE_INVALID');
    }
    return Object.freeze(result);
}

export async function loadFirstPaymentConciergeDatasets(input: {
    descriptor: FirstPaymentConciergeRecoverySource;
    clientForSlot(slot: string): ReplayReadonlyApifyClient;
}): Promise<readonly LoadedRun[]> {
    const runs = [...input.descriptor.preflightRuns, ...input.descriptor.providerRuns];
    if (new Set(runs.map(run => run.runId)).size !== runs.length) {
        fail('FIRST_PAYMENT_CONCIERGE_SOURCE_NOT_EXACT');
    }
    const loaded: LoadedRun[] = [];
    for (const run of runs) {
        loaded.push({
            ...run,
            items: await readDataset(run, input.clientForSlot(run.credentialSlot)),
        });
    }
    return Object.freeze(loaded);
}

function profileUsernames(items: readonly unknown[]): string[] {
    return [...new Set(items.flatMap(item => {
        const username = attributedApifyProfileUsername(item)
            ?? attributedProfileActorErrorUsername(item);
        return username ? [normalizedUsername(username)] : [];
    }))];
}

function profileRows(run: LoadedRun): Map<string, InstagramProfile> {
    const usernames = profileUsernames(run.items);
    const parsed = parseApifyProfileDataset(run.items, usernames);
    if (parsed.datasetContaminated) {
        fail('FIRST_PAYMENT_CONCIERGE_PROFILE_DATASET_INVALID');
    }
    return parsed.profilesByUsername;
}

function selectExpectedRelationshipRun(
    runs: readonly LoadedRun[],
    targetUsername: string,
    side: 'followers' | 'following',
    expectedCount: number,
) {
    const kind = `relationship-${side}`;
    const candidates = runs.flatMap(run => {
        if (operationKind(run) !== kind) return [];
        const rows = parseApifyRelationshipDataset(
            run.items.map(item => z.record(z.string(), z.unknown()).parse(item)),
            targetUsername,
            side,
            1_200,
        ).map(row => ({
            username: normalizedUsername(row.username),
            fullName: row.fullName?.trim() || null,
            profilePicUrl: row.profilePicUrl?.trim() || null,
            isPrivate: row.isPrivate,
            isVerified: row.isVerified,
        }));
        if (new Set(rows.map(row => row.username)).size !== rows.length) {
            fail('FIRST_PAYMENT_CONCIERGE_RELATIONSHIP_DATASET_INVALID');
        }
        return [{ run, rows }];
    });
    const exactCandidates = candidates.filter(candidate => (
        candidate.rows.length === expectedCount
    ));
    const selectionPool = exactCandidates.length > 0 ? exactCandidates : candidates;
    const selected = selectionPool.sort((left, right) => (
        right.rows.length - left.rows.length
        || sourcePriority[left.run.sourceLabel] - sourcePriority[right.run.sourceLabel]
        || left.run.runId.localeCompare(right.run.runId)
    ))[0];
    if (!selected) fail('FIRST_PAYMENT_CONCIERGE_RELATIONSHIP_DATASET_MISSING');
    return selected.rows;
}

function interactionProfileFor(
    targetProfiles: readonly InstagramProfile[],
    likerItems: readonly unknown[],
    commentItems: readonly unknown[],
): InstagramProfile {
    const urls = new Set<string>();
    for (const item of likerItems) {
        const parsed = z.object({ liked_post: z.string().url() }).passthrough().safeParse(item);
        if (parsed.success) urls.add(parsed.data.liked_post);
    }
    for (const item of commentItems) {
        const parsed = z.object({ postUrl: z.string().url() }).passthrough().safeParse(item);
        if (parsed.success) urls.add(parsed.data.postUrl);
    }
    const covers = targetProfiles.filter(profile => {
        const profileUrls = new Set((profile.latestPosts ?? []).map(post => {
            const path = post.type === 'reel' ? 'reel' : 'p';
            return `https://www.instagram.com/${path}/${post.shortCode}/`;
        }));
        return [...urls].every(url => profileUrls.has(url));
    });
    const selected = covers[0] ?? (urls.size === 0 ? targetProfiles[0] : undefined);
    if (!selected) fail('FIRST_PAYMENT_CONCIERGE_TARGET_INTERACTION_DRIFT');
    return selected;
}

function largestItems(runs: readonly LoadedRun[], kind: string): readonly unknown[] {
    const selected = runs
        .filter(run => operationKind(run) === kind)
        .sort((left, right) => (
            right.items.length - left.items.length
            || sourcePriority[left.sourceLabel] - sourcePriority[right.sourceLabel]
            || left.runId.localeCompare(right.runId)
        ))[0];
    if (!selected) fail('FIRST_PAYMENT_CONCIERGE_INTERACTION_DATASET_MISSING');
    return selected.items;
}

export function assembleFirstPaymentConciergeSource(input: {
    descriptor: FirstPaymentConciergeRecoverySource;
    runs: readonly LoadedRun[];
}): FirstPaymentConciergeSource {
    const targetRuns = input.runs.filter(run => (
        operationKind(run) === 'target-profile-fallback'
        || operationKind(run) === 'target-profile-fresh-admission'
    ));
    const targetEntries = targetRuns.flatMap(run => (
        [...profileRows(run).entries()].map(([username, profile]) => ({ run, username, profile }))
    ));
    const targetUsernames = new Set(targetEntries.map(entry => entry.username));
    if (targetUsernames.size !== 1) {
        fail('FIRST_PAYMENT_CONCIERGE_TARGET_PROFILE_INVALID');
    }
    const targetUsername = [...targetUsernames][0]!;
    const orderedTargets = targetEntries.sort((left, right) => (
        sourcePriority[right.run.sourceLabel] - sourcePriority[left.run.sourceLabel]
        || right.run.operationKey.localeCompare(left.run.operationKey)
        || right.run.runId.localeCompare(left.run.runId)
    ));
    const targetProfile = orderedTargets[0]?.profile;
    if (!targetProfile) fail('FIRST_PAYMENT_CONCIERGE_TARGET_PROFILE_INVALID');

    const followers = selectExpectedRelationshipRun(
        input.runs,
        targetUsername,
        'followers',
        390,
    );
    const following = selectExpectedRelationshipRun(
        input.runs,
        targetUsername,
        'following',
        256,
    );
    if (followers.length !== 390 || following.length !== 256) {
        fail(
            `FIRST_PAYMENT_CONCIERGE_RELATIONSHIP_COUNT_DRIFT(${followers.length}:${following.length})`,
        );
    }
    const followerByUsername = new Map(followers.map(row => [row.username, row]));
    const mutualRows: FirstPaymentConciergeRelationshipRow[] = following.flatMap(row => {
        const follower = followerByUsername.get(row.username);
        if (!follower) return [];
        return [{
            ...row,
            fullName: row.fullName ?? follower.fullName,
            profilePicUrl: row.profilePicUrl ?? follower.profilePicUrl,
            mutualOrdinal: 0,
        }];
    }).map((row, index) => ({ ...row, mutualOrdinal: index + 1 }));
    const publicMutuals = mutualRows.filter(row => !row.isPrivate);
    const privateRows = mutualRows.filter(row => row.isPrivate);
    if (
        mutualRows.length !== 182
        || publicMutuals.length !== 134
        || privateRows.length !== 48
    ) {
        fail(
            `FIRST_PAYMENT_CONCIERGE_MUTUAL_COUNT_DRIFT(${mutualRows.length}:${publicMutuals.length}:${privateRows.length})`,
        );
    }

    const candidateProfiles = new Map<string, InstagramProfile>();
    const candidateRuns = input.runs
        .filter(run => ['profile-fallback', 'profile-repair'].includes(operationKind(run)))
        .slice()
        .sort((left, right) => (
            sourcePriority[right.sourceLabel] - sourcePriority[left.sourceLabel]
            || Number(operationKind(right) === 'profile-repair')
                - Number(operationKind(left) === 'profile-repair')
            || right.operationKey.localeCompare(left.operationKey)
            || right.runId.localeCompare(left.runId)
        ));
    for (const run of candidateRuns) {
        for (const [username, profile] of profileRows(run)) {
            if (username !== targetUsername && !candidateProfiles.has(username)) {
                candidateProfiles.set(username, profile);
            }
        }
    }
    const publicByUsername = new Map(publicMutuals.map(row => [row.username, row]));
    if ([...candidateProfiles.keys()].some(username => !publicByUsername.has(username))) {
        fail('FIRST_PAYMENT_CONCIERGE_PROFILE_SCOPE_DRIFT');
    }
    const publicProfiles = publicMutuals.flatMap(row => {
        const profile = candidateProfiles.get(row.username);
        return profile ? [{ ordinal: row.mutualOrdinal, profile }] : [];
    });
    const publicUnavailableRows = publicMutuals.filter(row => (
        !candidateProfiles.has(row.username)
    ));
    if (publicProfiles.length !== 129 || publicUnavailableRows.length !== 5) {
        fail(
            `FIRST_PAYMENT_CONCIERGE_PROFILE_COUNT_DRIFT(${publicProfiles.length}:${publicUnavailableRows.length})`,
        );
    }

    const likerItems = largestItems(input.runs, 'target-likers');
    const commentItems = largestItems(input.runs, 'target-comments');
    const interactionProfile = interactionProfileFor(
        orderedTargets.map(entry => entry.profile),
        likerItems,
        commentItems,
    );
    const postUrl = (item: unknown, key: 'liked_post' | 'postUrl') => (
        z.object({ [key]: z.string().url() }).passthrough().parse(item)[key]
    );
    const likerPostUrls = [...new Set(likerItems.map(item => postUrl(item, 'liked_post')))];
    const commentPostUrls = [...new Set(commentItems.map(item => postUrl(item, 'postUrl')))];
    const likers = parseApifyLikerDataset(likerItems, likerPostUrls, 150);
    const comments = parseApifyCommentDataset(commentItems, commentPostUrls, 15).comments;
    const targetInteractions = extractRawTargetInteractions({
        targetPosts: interactionProfile.latestPosts ?? [],
        likers,
        comments,
        excludedUsernames: [targetUsername],
    }).evidence;

    return Object.freeze({
        descriptorHash: input.descriptor.descriptorHash,
        targetProfile,
        followersDeclared: Math.max(targetProfile.followersCount, followers.length),
        followersCollected: followers.length,
        followingDeclared: Math.max(targetProfile.followingCount, following.length),
        followingCollected: following.length,
        mutualRows: Object.freeze(mutualRows),
        publicProfiles: Object.freeze(publicProfiles),
        publicUnavailableRows: Object.freeze(publicUnavailableRows),
        privateRows: Object.freeze(privateRows),
        targetInteractions: Object.freeze(targetInteractions),
    });
}
