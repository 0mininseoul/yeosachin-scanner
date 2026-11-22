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
const HIDDEN_ALLOWANCE = 3;
/** A public count must be recent, because a private account is confirmed by a second look an hour later. */
const PROFILE_REUSE_SECONDS = 45 * 60;
const LIST_REUSE_SECONDS = 12 * 3600;
/** After repeated bad days one retry is enough; more would only spend the month's rows. */
const BACKOFF_STREAK = 2;
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
    rowsUsed(subscriptionId: string, since: string, checkId: string): Promise<number>;
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
    rowsUsed: (subscriptionId, since, checkId) => cherryRpc<number>('cherry_rows_used', { p_subscription: subscriptionId, p_since: since, p_check: checkId }),
    now: () => Date.now(),
};

export function relationshipBuild(env: Record<string, string | undefined> = process.env): string {
    const build = env.APIFY_RELATIONSHIP_BUILD?.trim();
    return build && /^\d+\.\d+\.\d+$/.test(build) ? build : RELATIONSHIP_BUILD;
}

/** One ledger series per check; an operator retry starts a new one. */
function operation(base: string, check: CherryCheck): string {
    return `${base}_s${check.series}`;
}

export async function collectCherryProfiles(input: {
    ownerKey: string; operation: string; subscriptionId: string | null; slot: ApifyCredentialSlot;
    usernames: readonly string[]; deadlineAtMs: number; reuseSeconds?: number;
}, run: CherryCheckDeps['run'] = defaultDeps.run): Promise<{ profiles: Map<string, CherryProfileResult>; ledgerId: string }> {
    const charge = Number((input.usernames.length * CHERRY_PROFILE_USD).toFixed(6));
    const result = await run({
        ownerKey: input.ownerKey, operation: input.operation, subscriptionId: input.subscriptionId, slot: input.slot,
        actorId: APIFY_PROFILE_ACTOR_ID, input: { usernames: [...input.usernames] }, items: input.usernames.length + 1,
        maxChargeUsd: charge, executionMaxChargeUsd: Number((charge + 0.0004).toFixed(6)),
        estimatedUsdPerItem: 0.0023, timeoutSecs: 300, deadlineAtMs: input.deadlineAtMs,
        reuseSeconds: input.reuseSeconds ?? PROFILE_REUSE_SECONDS,
    });
    return { profiles: parseProfileRows(result.rows, input.usernames), ledgerId: result.ledgerId };
}

async function collectList(input: {
    check: CherryCheck; subscription: CherrySubscription; profile: CherryProfile; direction: CherryDirection; deadlineAtMs: number;
}, deps: CherryCheckDeps): Promise<CherryListAccount[]> {
    const declared = input.direction === 'followers' ? input.profile.followersCount : input.profile.followingCount;
    if (declared === 0) return [];
    const limit = Math.max(CHERRY_LIST_MIN, Math.min(HARD_LIST_LIMIT, declared + 10));
    const result = await deps.run({
        ownerKey: `check:${input.check.id}`, operation: operation(input.direction, input.check),
        subscriptionId: input.subscription.id, slot: 'secondary', actorId: APIFY_RELATIONSHIP_ACTOR_ID,
        actorBuild: relationshipBuild(), input: relationshipInput(input.profile.username, input.direction, limit), items: limit,
        maxChargeUsd: relationshipMaxCharge(limit), estimatedUsdPerItem: CHERRY_RELATIONSHIP_USD_PER_ITEM,
        timeoutSecs: 900, deadlineAtMs: input.deadlineAtMs, reuseSeconds: LIST_REUSE_SECONDS,
    });
    let accounts: CherryListAccount[];
    try {
        accounts = parseRelationshipRows(result.rows, input.profile.username, input.direction);
    } catch {
        await deps.reject(result.ledgerId, 'schema');
        throw new CherryDeferError('list_schema', { delaySeconds: 1800 });
    }
    // In a short list a single hidden account is a large share, so a few are accepted once a retry agrees.
    const fewHidden = result.attempt >= 2 && accounts.length > 0 && listGap(accounts.length, declared) <= HIDDEN_ALLOWANCE;
    if (!fewHidden && coverageRatio(accounts.length, declared) < requiredCoverage(result.attempt)) {
        await deps.reject(result.ledgerId, 'incomplete');
        const tries = input.subscription.failure_streak >= BACKOFF_STREAK ? 2 : 4;
        throw new CherryDeferError('list_incomplete', { delaySeconds: 600, terminal: result.attempt >= tries });
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

/** A target that can no longer be served ends with a refund instead of failing, and charging, every day. */
function unavailableCode(observed: CherryProfileResult, subscription: CherrySubscription): 'private' | 'not_found' | 'too_large' | null {
    if (observed.status === 'not_found') return 'not_found';
    if (observed.status !== 'found') return null;
    // A recycled handle belongs to someone else, so the registered account is gone.
    if (observed.profile.id !== subscription.target_instagram_id) return 'not_found';
    if (observed.profile.isPrivate) return 'private';
    return observed.profile.followersCount + observed.profile.followingCount > HARD_LIST_LIMIT ? 'too_large' : null;
}

async function runCheck(check: CherryCheck, deadlineAtMs: number, deps: CherryCheckDeps): Promise<void> {
    const [subscription, settings] = await Promise.all([deps.loadSubscription(check.subscription_id), deps.loadSettings()]);
    if (!subscription || !['preparing', 'active'].includes(subscription.status)) {
        throw new CherryDeferError('subscription_inactive', { delaySeconds: 0, terminal: true });
    }
    if (await deps.isBlocked(subscription.target_instagram_id, subscription.target_username)) {
        const ended = await deps.rpc<{ refundKrw?: number }>('cherry_end_with_refund', { p_subscription: subscription.id, p_reason: 'target_blocked' });
        await deps.rpc('cherry_queue_notification', {
            p_subscription: subscription.id, p_kind: 'target_unavailable', p_dedupe: `unavailable:${subscription.id}`,
            p_payload: { code: 'blocked', refundKrw: ended?.refundKrw ?? 0 }, p_report: null,
        });
        throw new CherryDeferError('target_blocked', { delaySeconds: 0, terminal: true });
    }
    const { profiles, ledgerId } = await collectCherryProfiles({
        ownerKey: `check:${check.id}`, operation: operation('profile', check),
        subscriptionId: subscription.id, slot: 'secondary', usernames: [subscription.target_username], deadlineAtMs,
    }, deps.run);
    const observed = profiles.get(subscription.target_username.toLowerCase());
    if (!observed || observed.status === 'unavailable') {
        await deps.reject(ledgerId, 'profile_unusable');
        throw new CherryDeferError('profile_unavailable', { delaySeconds: 900 });
    }
    const unavailable = unavailableCode(observed, subscription);
    if (unavailable) {
        await deps.rpc('cherry_mark_unavailable', {
            p_check: check.id, p_lease: check.lease_token, p_code: unavailable, p_confirm_seconds: CONFIRM_UNAVAILABLE_SECONDS,
        });
        return;
    }
    if (observed.status !== 'found') throw new CherryDeferError('profile_unavailable', { delaySeconds: 900 });
    const profile = observed.profile;
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
    // Counted from the paid-run ledger over at most the last 30 days, so unusable lists are included
    // and a list that never succeeds cannot start a new month of its own.
    const periodStartMs = Math.max(nowMs - 30 * 86_400_000, Date.parse(subscription.items_period_start ?? subscription.created_at));
    let used = await deps.rowsUsed(subscription.id, new Date(periodStartMs).toISOString(), check.id);
    const wanted: CherryDirection[] = [];
    const paced: CherryDirection[] = [];
    for (const direction of CHERRY_DIRECTIONS) {
        if (stale(direction) || declared[direction] !== previous[direction]) {
            const allowed = canCollect({
                nowMs, periodStartMs, used, planned: declared[direction],
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
