/**
 * Pure rules for turning collected lists into relation changes and new-mutual events.
 *
 * The provider returns lists in a different order every time and leaves out a few accounts that come
 * back later (measured 2026-11-23: 20 repeated lists, rank correlation 0.38-0.69, about one account
 * missing per list). Order therefore proves nothing, and an unseen account is new only when the public
 * counts leave no room for it to be an account an earlier list had missed.
 */
export type CherryDirection = 'followers' | 'following';
export const CHERRY_DIRECTIONS: readonly CherryDirection[] = ['followers', 'following'];

export interface CherryListAccount {
    id: string;
    username: string;
    fullName: string | null;
    isPrivate: boolean;
    isVerified: boolean;
}

export interface CherryRelation extends CherryListAccount {
    follower: boolean;
    following: boolean;
    /** First observed after the baseline, not merely found late. */
    followerNew: boolean;
    followingNew: boolean;
    followerMisses: number;
    followingMisses: number;
    followerMissingSince: string | null;
    followingMissingSince: string | null;
}

export interface CherryObservation {
    direction: CherryDirection;
    accounts: readonly CherryListAccount[];
    /** Public count on the profile when this list was read. */
    declaredCount: number;
    /** Public count when the previous list of this direction was read. */
    previousCount: number;
    /** Accounts the previous list had left out of its public count. */
    previousGap: number;
}

export type CherryCertainty = 'confirmed' | 'possible';
export interface CherryMutualEvent extends CherryListAccount {
    kind: 'new' | 'supplement';
    certainty: CherryCertainty;
    position: number;
}

export interface CherryDiff {
    /** Only rows that differ from the stored relation. */
    changed: CherryRelation[];
    events: CherryMutualEvent[];
    mutuals: number;
}

const REMOVAL_MISSES = 2;
const REMOVAL_DAYS = 14;

export function requiredCoverage(attempt: number): number {
    if (attempt <= 1) return 0.985;
    return attempt === 2 ? 0.96 : 0.93;
}

export function coverageRatio(collected: number, declared: number): number {
    return declared === 0 ? 1 : collected / declared;
}

export function listGap(collected: number, declared: number): number {
    return Math.max(0, declared - collected);
}

/**
 * Whether unseen accounts in a list are new.
 * 'late' means every one of them fits into the accounts an earlier list had left out.
 */
export function classifyUnseen(unseen: number, observation: CherryObservation): CherryCertainty | 'late' {
    const growth = Math.max(0, observation.declaredCount - observation.previousCount);
    if (observation.previousGap === 0 || (unseen <= growth)) return 'confirmed';
    if (growth === 0 && unseen <= observation.previousGap) return 'late';
    return 'possible';
}

/**
 * Keeps one member within the monthly rows. Rows accrue daily on top of a starting allowance, so a
 * quiet account is read on the day it changes and a very active one every few days.
 */
export function canCollect(input: {
    nowMs: number; periodStartMs: number; used: number; planned: number; monthlyLimit: number; listTotal: number;
}): boolean {
    const elapsed = Math.min(1, Math.max(0, (input.nowMs - input.periodStartMs) / (30 * 86_400_000)));
    const allowance = Math.min(input.monthlyLimit, input.monthlyLimit * elapsed + 2 * input.listTotal);
    return input.used + input.planned <= allowance;
}

function isKnown(relation: CherryRelation | undefined, direction: CherryDirection): boolean {
    if (!relation) return false;
    return direction === 'followers' ? relation.follower : relation.following;
}

function emptyRelation(account: CherryListAccount): CherryRelation {
    return {
        ...account, follower: false, following: false, followerNew: false, followingNew: false,
        followerMisses: 0, followingMisses: 0, followerMissingSince: null, followingMissingSince: null,
    };
}

export function diffBaseline(
    followers: readonly CherryListAccount[],
    following: readonly CherryListAccount[],
): CherryDiff {
    const rows = new Map<string, CherryRelation>();
    const put = (account: CherryListAccount, direction: CherryDirection) => {
        const row = rows.get(account.id) ?? emptyRelation(account);
        if (direction === 'followers') row.follower = true; else row.following = true;
        rows.set(account.id, row);
    };
    followers.forEach(account => put(account, 'followers'));
    following.forEach(account => put(account, 'following'));
    const changed = [...rows.values()];
    return { changed, events: [], mutuals: changed.filter(row => row.follower && row.following).length };
}

export function diffObservations(
    relations: ReadonlyMap<string, CherryRelation>,
    observations: readonly CherryObservation[],
    nowMs: number,
): CherryDiff {
    const next = new Map<string, CherryRelation>();
    for (const [id, relation] of relations) next.set(id, { ...relation });
    const touched = new Set<string>();
    const certainty = new Map<string, CherryCertainty>();
    const order: string[] = [];

    for (const observation of observations) {
        const isFollowers = observation.direction === 'followers';
        const unseen = observation.accounts.filter(account => !isKnown(relations.get(account.id), observation.direction));
        const verdict = classifyUnseen(unseen.length, observation);
        for (const account of unseen) {
            const row = next.get(account.id) ?? emptyRelation(account);
            Object.assign(row, account);
            const isNew = verdict !== 'late';
            if (isFollowers) { row.follower = true; row.followerNew = isNew; } else { row.following = true; row.followingNew = isNew; }
            next.set(account.id, row);
            touched.add(account.id);
            if (isNew && (verdict === 'confirmed' || !certainty.has(account.id))) certainty.set(account.id, verdict);
            order.push(account.id);
        }
        const seen = new Map(observation.accounts.map(account => [account.id, account]));
        for (const [id, row] of next) {
            const account = seen.get(id);
            if (account) {
                const missed = isFollowers ? row.followerMisses > 0 : row.followingMisses > 0;
                if (missed || account.username !== row.username || account.fullName !== row.fullName
                    || account.isPrivate !== row.isPrivate || account.isVerified !== row.isVerified) {
                    Object.assign(row, account);
                    if (isFollowers) { row.followerMisses = 0; row.followerMissingSince = null; }
                    else { row.followingMisses = 0; row.followingMissingSince = null; }
                    touched.add(id);
                }
                continue;
            }
            if (!isKnown(row, observation.direction)) continue;
            // An absent account usually comes back, so it is dropped only after two lists and two weeks.
            const misses = (isFollowers ? row.followerMisses : row.followingMisses) + 1;
            const since = (isFollowers ? row.followerMissingSince : row.followingMissingSince) ?? new Date(nowMs).toISOString();
            const removed = misses >= REMOVAL_MISSES && nowMs - Date.parse(since) >= REMOVAL_DAYS * 86_400_000;
            if (isFollowers) {
                row.followerMisses = removed ? 0 : misses;
                row.followerMissingSince = removed ? null : since;
                if (removed) { row.follower = false; row.followerNew = false; }
            } else {
                row.followingMisses = removed ? 0 : misses;
                row.followingMissingSince = removed ? null : since;
                if (removed) { row.following = false; row.followingNew = false; }
            }
            touched.add(id);
        }
    }

    let mutuals = 0;
    for (const row of next.values()) if (row.follower && row.following) mutuals += 1;
    const events: CherryMutualEvent[] = [];
    for (const id of new Set(order)) {
        const row = next.get(id)!;
        const before = relations.get(id);
        if (!row.follower || !row.following || (before?.follower && before.following)) continue;
        // A mutual needs both sides, so one side seen as new makes the mutual new.
        const isNew = row.followerNew || row.followingNew;
        events.push({
            id: row.id, username: row.username, fullName: row.fullName, isPrivate: row.isPrivate, isVerified: row.isVerified,
            kind: isNew ? 'new' : 'supplement', certainty: certainty.get(id) ?? (isNew ? 'possible' : 'confirmed'),
            position: events.length,
        });
    }
    return { changed: [...touched].map(id => next.get(id)!), events, mutuals };
}
