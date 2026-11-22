import { APIFY_PROFILE_ACTOR_ID, APIFY_RELATIONSHIP_ACTOR_ID } from '@/lib/services/instagram/providers/apify';
import type { ApifyCredentialSlot } from '@/lib/services/instagram/providers/types';
import {
    canCollect, CHERRY_DIRECTIONS, coverageRatio, diffBaseline, diffObservations, listGap, requiredCoverage,
    type CherryDiff, type CherryDirection, type CherryListAccount, type CherryObservation, type CherryRelation,
} from './detection';
import { CherryDeferError, cherryErrorCode } from './errors';
import {
    CHERRY_LIST_MIN, CHERRY_PROFILE_USD, CHERRY_RELATIONSHIP_USD_PER_ITEM, parseProfileRows, parseRelationshipRows,
    relationshipInput, relationshipMaxCharge, type CherryProfile, type CherryProfileResult,
} from './instagram';
import { rejectCherryRun, runCherryActor, type CherryRunRequest, type CherryRunResult } from './provider-runs';
import { CherryDatabaseError, cherryRpc } from './rpc';
import {
    isCherryTargetBlocked, loadCherryRelations, loadCherrySettings, loadCherrySubscription,
    type CherryCheck, type CherrySettings, type CherrySubscription,
} from './store';

/** Public lists above this are not read; the provider cost and completeness both degrade. */
const HARD_LIST_LIMIT = 2000;
const RELATIONSHIP_BUILD = '0.0.71';
const CONFIRM_UNAVAILABLE_SECONDS = 3600;
/** A direction is read again after this long even when its public count never moved. */
const RELIST_DAYS = 14;

export interface CherryCheckDeps {
    run(request: CherryRunRequest): Promise<CherryRunResult>;
    reject(ledgerId: string, code: string): Promise<void>;
    rpc<T>(name: string, params: Record<string, unknown>): Promise<T>;
    loadSubscription(id: string): Promise<CherrySubscription | null>;
    loadRelations(id: string): Promise<Map<string, CherryRelation>>;
    loadSettings(): Promise<CherrySettings>;
    isBlocked(instagramId: string, username: string): Promise<boolean>;
    now(): number;
}

const defaultDeps: CherryCheckDeps = {
    run: request => runCherryActor(request),
    reject: (id, code) => rejectCherryRun(id, code),
    rpc: (name, params) => cherryRpc(name, params),
    loadSubscription: loadCherrySubscription,
    loadRelations: loadCherryRelations,
    loadSettings: loadCherrySettings,
    isBlocked: isCherryTargetBlocked,
    now: () => Date.now(),
};

export function relationshipBuild(env: Record<string, string | undefined> = process.env): string {
    const build = env.APIFY_RELATIONSHIP_BUILD?.trim();
    return build && /^\d+\.\d+\.\d+$/.test(build) ? build : RELATIONSHIP_BUILD;
}

/** A retry inside the window resumes the same paid run; a later one starts fresh data. */
function bucket(base: string, createdAt: string, nowMs: number, hours: number): string {
    return `${base}_b${Math.max(0, Math.floor((nowMs - Date.parse(createdAt)) / (hours * 3_600_000)))}`;
}

export async function collectCherryProfiles(input: {
    ownerKey: string; operation: string; subscriptionId: string | null; slot: ApifyCredentialSlot;
    usernames: readonly string[]; deadlineAtMs: number;
}, run: CherryCheckDeps['run'] = defaultDeps.run): Promise<Map<string, CherryProfileResult>> {
    const charge = Number((input.usernames.length * CHERRY_PROFILE_USD).toFixed(6));
    const result = await run({
        ownerKey: input.ownerKey, operation: input.operation, subscriptionId: input.subscriptionId, slot: input.slot,
        actorId: APIFY_PROFILE_ACTOR_ID, input: { usernames: [...input.usernames] }, items: input.usernames.length + 1,
        maxChargeUsd: charge, executionMaxChargeUsd: Number((charge + 0.0004).toFixed(6)),
        estimatedUsdPerItem: 0.0023, timeoutSecs: 300, deadlineAtMs: input.deadlineAtMs,
    });
    return parseProfileRows(result.rows, input.usernames);
}

async function collectList(input: {
    check: CherryCheck; subscription: CherrySubscription; profile: CherryProfile; direction: CherryDirection; deadlineAtMs: number;
}, deps: CherryCheckDeps): Promise<CherryListAccount[]> {
    const declared = input.direction === 'followers' ? input.profile.followersCount : input.profile.followingCount;
    if (declared === 0) return [];
    const limit = Math.max(CHERRY_LIST_MIN, Math.min(HARD_LIST_LIMIT, declared + 10));
    const result = await deps.run({
        ownerKey: `check:${input.check.id}`, operation: bucket(input.direction, input.check.created_at, deps.now(), 6),
        subscriptionId: input.subscription.id, slot: 'secondary', actorId: APIFY_RELATIONSHIP_ACTOR_ID,
        actorBuild: relationshipBuild(), input: relationshipInput(input.profile.username, input.direction, limit), items: limit,
        maxChargeUsd: relationshipMaxCharge(limit), estimatedUsdPerItem: CHERRY_RELATIONSHIP_USD_PER_ITEM,
        timeoutSecs: 900, deadlineAtMs: input.deadlineAtMs,
    });
    let accounts: CherryListAccount[];
    try {
        accounts = parseRelationshipRows(result.rows, input.profile.username, input.direction);
    } catch {
        await deps.reject(result.ledgerId, 'schema');
        throw new CherryDeferError('list_schema', { delaySeconds: 1800 });
    }
    if (coverageRatio(accounts.length, declared) < requiredCoverage(result.attempt)) {
        await deps.reject(result.ledgerId, 'incomplete');
        throw new CherryDeferError('list_incomplete', { delaySeconds: 600, terminal: result.attempt >= 4 });
    }
    return accounts;
}

/** Both directions run together; one failure still lets the other finish and be resumed. */
async function collectBoth(
    directions: readonly CherryDirection[], task: (direction: CherryDirection) => Promise<CherryListAccount[]>,
): Promise<Map<CherryDirection, CherryListAccount[]>> {
    const settled = await Promise.allSettled(directions.map(task));
    const failure = settled.find(item => item.status === 'rejected');
    if (failure?.status === 'rejected') {
        // Prefer a failure that needs a person over one that only waits.
        const terminal = settled.find(item => item.status === 'rejected'
            && item.reason instanceof CherryDeferError && item.reason.options.terminal);
        throw terminal?.status === 'rejected' ? terminal.reason : failure.reason;
    }
    return new Map(settled.map((item, index) => [directions[index], (item as PromiseFulfilledResult<CherryListAccount[]>).value]));
}

function relationPayload(diff: CherryDiff) {
    return diff.changed.map(row => ({
        id: row.id, username: row.username, full_name: row.fullName, is_private: row.isPrivate, is_verified: row.isVerified,
        follower: row.follower, following: row.following, follower_new: row.followerNew, following_new: row.followingNew,
        follower_misses: row.followerMisses, following_misses: row.followingMisses,
        follower_missing_since: row.followerMissingSince, following_missing_since: row.followingMissingSince,
    }));
}

async function applyDiff(
    check: CherryCheck, diff: CherryDiff, profile: CherryProfile, lists: ReadonlyMap<CherryDirection, CherryListAccount[]>,
    paced: readonly CherryDirection[], deps: CherryCheckDeps,
): Promise<void> {
    const listed = (direction: CherryDirection, count: number) => {
        const accounts = lists.get(direction);
        return accounts ? { [direction]: { count, gap: listGap(accounts.length, count) } } : {};
    };
    await deps.rpc('cherry_apply_check', { p_check: check.id, p_lease: check.lease_token, p_payload: {
        ...listed('followers', profile.followersCount), ...listed('following', profile.followingCount),
        items: [...lists.values()].reduce((sum, accounts) => sum + accounts.length, 0), mutuals: diff.mutuals,
        relations: relationPayload(diff),
        events: diff.events.map(event => ({
            id: event.id, username: event.username, full_name: event.fullName, is_private: event.isPrivate,
            is_verified: event.isVerified, kind: event.kind, certainty: event.certainty, position: event.position,
        })),
        result: {
            read: [...lists.keys()], paced, followers: profile.followersCount, following: profile.followingCount,
            new: diff.events.filter(event => event.kind === 'new').length,
            supplement: diff.events.filter(event => event.kind === 'supplement').length,
        },
    } });
}

async function runCheck(check: CherryCheck, deadlineAtMs: number, deps: CherryCheckDeps): Promise<void> {
    const [subscription, settings] = await Promise.all([deps.loadSubscription(check.subscription_id), deps.loadSettings()]);
    if (!subscription || !['preparing', 'active'].includes(subscription.status)) {
        throw new CherryDeferError('subscription_inactive', { delaySeconds: 0, terminal: true });
    }
    if (await deps.isBlocked(subscription.target_instagram_id, subscription.target_username)) {
        await deps.rpc('cherry_end_with_refund', { p_subscription: subscription.id, p_reason: 'target_blocked' });
        throw new CherryDeferError('target_blocked', { delaySeconds: 0, terminal: true });
    }
    const profiles = await collectCherryProfiles({
        ownerKey: `check:${check.id}`, operation: bucket('profile', check.created_at, deps.now(), 1),
        subscriptionId: subscription.id, slot: 'secondary', usernames: [subscription.target_username], deadlineAtMs,
    }, deps.run);
    const observed = profiles.get(subscription.target_username.toLowerCase());
    if (!observed || observed.status === 'unavailable') throw new CherryDeferError('profile_unavailable', { delaySeconds: 900 });
    if (observed.status === 'not_found' || observed.profile.isPrivate) {
        await deps.rpc('cherry_mark_unavailable', {
            p_check: check.id, p_lease: check.lease_token,
            p_code: observed.status === 'not_found' ? 'not_found' : 'private',
            p_confirm_seconds: CONFIRM_UNAVAILABLE_SECONDS,
        });
        return;
    }
    const profile = observed.profile;
    // A recycled handle belongs to someone else.
    if (profile.id !== subscription.target_instagram_id) {
        throw new CherryDeferError('target_identity_changed', { delaySeconds: 0, terminal: true });
    }
    if (profile.followersCount + profile.followingCount > HARD_LIST_LIMIT) {
        throw new CherryDeferError('target_too_large', { delaySeconds: 0, terminal: true });
    }
    const collect = (direction: CherryDirection) => collectList({ check, subscription, profile, direction, deadlineAtMs }, deps);

    if (check.kind === 'baseline') {
        const lists = await collectBoth(CHERRY_DIRECTIONS, collect);
        await applyDiff(check, diffBaseline(lists.get('followers') ?? [], lists.get('following') ?? []), profile, lists, [], deps);
        return;
    }

    const nowMs = deps.now();
    const declared = { followers: profile.followersCount, following: profile.followingCount };
    const previous = { followers: subscription.followers_count, following: subscription.following_count };
    const listedAt = { followers: subscription.followers_listed_at, following: subscription.following_listed_at };
    const stale = (direction: CherryDirection) => {
        const at = listedAt[direction];
        return at === null || nowMs - Date.parse(at) >= RELIST_DAYS * 86_400_000;
    };
    const periodStartMs = subscription.items_period_start ? Date.parse(subscription.items_period_start) : nowMs;
    let used = nowMs - periodStartMs > 30 * 86_400_000 ? 0 : subscription.items_used;
    const wanted: CherryDirection[] = [];
    const paced: CherryDirection[] = [];
    for (const direction of CHERRY_DIRECTIONS) {
        if (stale(direction)) {
            wanted.push(direction);
            used += declared[direction];
        } else if (declared[direction] !== previous[direction]) {
            const allowed = canCollect({
                nowMs, periodStartMs: used === 0 ? nowMs : periodStartMs, used, planned: declared[direction],
                monthlyLimit: settings.monthly_item_limit, listTotal: declared.followers + declared.following,
            });
            (allowed ? wanted : paced).push(direction);
            if (allowed) used += declared[direction];
        }
    }
    const lists = await collectBoth(wanted, collect);
    if (lists.size === 0) {
        await applyDiff(check, { changed: [], events: [], mutuals: 0 }, profile, lists, paced, deps);
        return;
    }
    const relations = await deps.loadRelations(subscription.id);
    const observations: CherryObservation[] = [...lists].map(([direction, accounts]) => ({
        direction, accounts, declaredCount: declared[direction], previousCount: previous[direction] ?? declared[direction],
        previousGap: direction === 'followers' ? subscription.followers_gap : subscription.following_gap,
    }));
    await applyDiff(check, diffObservations(relations, observations, nowMs), profile, lists, paced, deps);
}

export async function processCherryCheck(
    check: CherryCheck, deadlineAtMs: number, deps: CherryCheckDeps = defaultDeps,
): Promise<{ outcome: 'done' | 'deferred' | 'failed' | 'fenced'; code?: string }> {
    try {
        await runCheck(check, deadlineAtMs, deps);
        return { outcome: 'done' };
    } catch (error) {
        // Another worker owns this check now; its result stands.
        if (error instanceof CherryDatabaseError && error.databaseCode === 'CHERRY_CHECK_FENCE') return { outcome: 'fenced' };
        const defer = error instanceof CherryDeferError ? error.options : { delaySeconds: 600 };
        const code = cherryErrorCode(error);
        await deps.rpc('cherry_defer_check', {
            p_check: check.id, p_lease: check.lease_token, p_error: code, p_delay_seconds: defer.delaySeconds,
            p_terminal: defer.terminal ?? false, p_count_attempt: defer.countAttempt ?? true,
        });
        return { outcome: defer.terminal ? 'failed' : 'deferred', code };
    }
}
