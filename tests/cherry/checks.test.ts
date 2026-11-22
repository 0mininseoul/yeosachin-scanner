import { describe, expect, it, vi } from 'vitest';
import { processCherryCheck, type CherryCheckDeps } from '@/lib/services/cherry/checks';
import type { CherryRelation } from '@/lib/services/cherry/detection';
import { CherryDeferError } from '@/lib/services/cherry/errors';
import { normalizeTargetUsername, parseProfileRows, parseRelationshipRows } from '@/lib/services/cherry/instagram';
import { runCherryActor, type CherryRunDeps, type CherryRunRequest } from '@/lib/services/cherry/provider-runs';
import type { CherryCheck, CherrySettings, CherrySubscription } from '@/lib/services/cherry/store';

const CREATED = '2026-12-02T22:00:00.000Z';
const NOW = Date.parse('2026-12-02T22:05:00.000Z');
const check = (kind: CherryCheck['kind']): CherryCheck => ({
    id: '33333333-3333-4333-8333-333333333333', subscription_id: 'sub', kind, check_date: '2026-12-03', attempts: 1, series: 0,
    lease_token: 'lease', created_at: CREATED,
});
const profileRow = (overrides: Record<string, unknown> = {}) => ({
    id: '9001', username: 'target', followersCount: 30, followsCount: 30, postsCount: 1, private: false, verified: false, ...overrides,
});
const listRow = (direction: 'Followers' | 'Following', id: number) => ({
    username_scrape: 'target', type: direction, id, username: `u${id}`, full_name: '', is_private: false, is_verified: false, profile_pic_url: 'x',
});
const ids = (from: number, count: number) => Array.from({ length: count }, (_, index) => from + index);

function setup(options: {
    profile?: Record<string, unknown> | null; followers?: number[]; following?: number[]; subscription?: Partial<CherrySubscription>;
    settings?: Partial<CherrySettings>; relations?: Map<string, CherryRelation>; attempt?: number;
}) {
    const runs: CherryRunRequest[] = [];
    const calls: { name: string; params: Record<string, unknown> }[] = [];
    const reject = vi.fn(async () => undefined);
    const deps: CherryCheckDeps = {
        now: () => NOW,
        isBlocked: async () => false,
        loadRelations: async () => options.relations ?? new Map(),
        loadSettings: async () => ({ monthly_item_limit: 6000, ...options.settings }) as CherrySettings,
        loadSubscription: async () => ({
            id: 'sub', status: 'active', target_instagram_id: '9001', target_username: 'target', followers_count: 30,
            following_count: 30, followers_listed_at: CREATED, following_listed_at: CREATED, followers_gap: 0, following_gap: 0,
            items_used: 0, items_period_start: CREATED, ...options.subscription,
        }) as CherrySubscription,
        reject,
        rpc: async <T,>(name: string, params: Record<string, unknown>) => { calls.push({ name, params }); return {} as T; },
        run: async request => {
            runs.push(request);
            if (request.operation.startsWith('profile')) {
                return { ledgerId: 'p', attempt: 1, rows: options.profile === null ? [] : [options.profile ?? profileRow()] };
            }
            const direction = request.operation.startsWith('followers') ? 'Followers' : 'Following';
            const list = direction === 'Followers' ? options.followers ?? [] : options.following ?? [];
            return { ledgerId: direction, attempt: options.attempt ?? 1, rows: list.slice(0, request.items).map(id => listRow(direction, id)) };
        },
    };
    return { deps, runs, calls, reject };
}
const stored = (followers: number[], following: number[]) => {
    const rows = new Map<string, CherryRelation>();
    for (const id of new Set([...followers, ...following])) rows.set(String(id), {
        id: String(id), username: `u${id}`, fullName: null, isPrivate: false, isVerified: false,
        follower: followers.includes(id), following: following.includes(id), followerNew: false, followingNew: false,
        followerMisses: 0, followingMisses: 0, followerMissingSince: null, followingMissingSince: null,
    });
    return rows;
};
const payload = (calls: { name: string; params: Record<string, unknown> }[]) =>
    calls.find(call => call.name === 'cherry_apply_check')?.params.p_payload as Record<string, unknown> & { events: { id: string; kind: string }[]; result: Record<string, unknown> };

describe('cherry check', () => {
    it('stores both first lists', async () => {
        const { deps, calls, runs } = setup({ followers: ids(1, 30), following: ids(21, 30), subscription: { status: 'preparing' } });
        expect(await processCherryCheck(check('baseline'), NOW + 500_000, deps)).toEqual({ outcome: 'done' });
        expect(payload(calls)).toMatchObject({
            mutuals: 10, items: 60, events: [], followers: { count: 30, gap: 0 }, following: { count: 30, gap: 0 },
        });
        expect(runs.every(run => run.slot === 'secondary')).toBe(true);
    });

    it('spends nothing on lists when both counts are unchanged', async () => {
        const { deps, runs, calls } = setup({});
        await processCherryCheck(check('daily'), NOW + 500_000, deps);
        expect(runs).toHaveLength(1);
        expect(payload(calls)).toMatchObject({ items: 0, relations: [] });
    });

    it('reads only the direction that changed', async () => {
        const { deps, runs, calls } = setup({
            profile: profileRow({ followersCount: 31 }), followers: [...ids(1, 30), 99], relations: stored(ids(1, 30), [99, ...ids(101, 29)]),
        });
        await processCherryCheck(check('daily'), NOW + 500_000, deps);
        expect(runs.map(run => run.operation)).toEqual(['profile_s0_b0', 'followers_s0_b0']);
        expect(payload(calls).events).toMatchObject([{ id: '99', kind: 'new', certainty: 'confirmed' }]);
        expect(payload(calls)).toMatchObject({ followers: { count: 31, gap: 0 } });
        expect(payload(calls)).not.toHaveProperty('following');
    });

    it('reads both lists again after two weeks or a lapse even when counts are unchanged', async () => {
        for (const followers_listed_at of [null, '2026-11-15T00:00:00.000Z']) {
            const { deps, runs } = setup({ followers: ids(1, 30), relations: stored(ids(1, 30), []), subscription: { followers_listed_at } });
            await processCherryCheck(check('daily'), NOW + 500_000, deps);
            expect(runs.map(run => run.operation)).toEqual(['profile_s0_b0', 'followers_s0_b0']);
        }
    });

    it('leaves a change pending when the month is used up faster than it passes', async () => {
        const { deps, runs, calls } = setup({ profile: profileRow({ followersCount: 31 }), subscription: { items_used: 5990 } });
        expect(await processCherryCheck(check('daily'), NOW + 500_000, deps)).toEqual({ outcome: 'done' });
        expect(runs.map(run => run.operation)).toEqual(['profile_s0_b0']);
        expect(payload(calls)).not.toHaveProperty('followers');
        expect(payload(calls).result).toMatchObject({ paced: ['followers'] });
    });

    it('retries an incomplete first list with a new run and never activates on it', async () => {
        const { deps, calls, reject } = setup({ followers: ids(1, 20), following: ids(1, 30), subscription: { status: 'preparing' } });
        expect(await processCherryCheck(check('baseline'), NOW + 500_000, deps)).toEqual({ outcome: 'deferred', code: 'list_incomplete' });
        expect(reject).toHaveBeenCalledWith('Followers', 'incomplete');
        expect(payload(calls)).toBeUndefined();
        expect(calls.at(-1)).toMatchObject({ name: 'cherry_defer_check', params: { p_terminal: false, p_error: 'list_incomplete' } });
    });

    it('uses fresh paid runs when an operator asks again', async () => {
        const { deps, runs } = setup({});
        await processCherryCheck({ ...check('daily'), series: 2 }, NOW + 500_000, deps);
        expect(runs[0].operation).toBe('profile_s2_b0');
    });

    it('treats private, missing, replaced and unreadable targets differently', async () => {
        const cases: [Record<string, unknown> | null, string, string | undefined][] = [
            [profileRow({ private: true }), 'cherry_mark_unavailable', 'private'],
            [{ username: 'target', error: 'not_found' }, 'cherry_mark_unavailable', 'not_found'],
            [null, 'cherry_defer_check', undefined],
            [profileRow({ id: '777' }), 'cherry_defer_check', undefined],
        ];
        for (const [profile, name, code] of cases) {
            const { deps, calls } = setup({ profile });
            await processCherryCheck(check('daily'), NOW + 500_000, deps);
            expect(calls.at(-1)?.name).toBe(name);
            if (code) expect(calls.at(-1)?.params.p_code).toBe(code);
        }
    });
});

describe('cherry provider rows', () => {
    it('keeps stable ids and provider order, and refuses rows for another account', () => {
        expect(parseRelationshipRows([listRow('Followers', 3), listRow('Followers', 1), listRow('Followers', 3)], 'target', 'followers').map(row => row.id)).toEqual(['3', '1']);
        expect(() => parseRelationshipRows([listRow('Following', 1)], 'target', 'followers')).toThrow('CHERRY_RELATIONSHIP_MISMATCH');
        expect(() => parseRelationshipRows([{ ...listRow('Followers', 1), id: null }], 'target', 'followers')).toThrow('CHERRY_RELATIONSHIP_SCHEMA');
    });

    it('never reports a missing row as a missing account', () => {
        const rows = parseProfileRows([profileRow({ username: 'a' }), { username: 'b', errorCode: 'NOT_FOUND' }], ['a', 'b', 'c']);
        expect([rows.get('a')?.status, rows.get('b')?.status, rows.get('c')?.status]).toEqual(['found', 'not_found', 'unavailable']);
    });

    it('accepts an id, an @id, or a profile link', () => {
        expect(['Some.User', '@some_user ', 'https://www.instagram.com/some_user/?hl=ko', 'instagram.com/p/abc', 'not ok', ''].map(normalizeTargetUsername))
            .toEqual(['some.user', 'some_user', 'some_user', null, null, null]);
    });
});

describe('cherry paid runs', () => {
    const request: CherryRunRequest = {
        ownerKey: 'check:33333333-3333-4333-8333-333333333333', operation: 'followers_full_s0_b0', subscriptionId: null, slot: 'secondary',
        actorId: 'actor', input: {}, items: 100, maxChargeUsd: 0.1, estimatedUsdPerItem: 0.0007, timeoutSecs: 900,
        deadlineAtMs: Date.now() + 300_000,
    };
    function runner(reservation: Record<string, unknown>, options: { status?: string; start?: () => Promise<{ id: string }>; pages?: unknown[][] } = {}) {
        const updates: Record<string, unknown>[] = [];
        const start = vi.fn(options.start ?? (async () => ({ id: 'run1234567' })));
        const rows = options.pages ?? [[{ a: 1 }, { a: 2 }]];
        const deps: CherryRunDeps = {
            reserve: async () => ({ id: 'ledger', slot: 'secondary', maxChargeUsd: 0.1, attempt: 1, ...reservation }) as never,
            update: async (_id, patch) => { updates.push(patch); },
            sleep: async () => undefined,
            client: () => ({
                actor: () => ({ start }),
                run: () => ({ waitForFinish: async () => ({ id: 'run1234567', status: options.status ?? 'SUCCEEDED', defaultDatasetId: 'ds' }) }),
                dataset: () => ({ listItems: async () => ({ items: rows[0], total: rows[0].length, offset: 0, count: rows[0].length }) }),
            }) as never,
        };
        return { deps, updates, start };
    }

    it('records the run before waiting and its result after', async () => {
        const { deps, updates } = runner({ outcome: 'reserved' });
        const result = await runCherryActor(request, deps);
        expect(result.rows).toHaveLength(2);
        expect(updates.map(update => update.status)).toEqual(['started', 'succeeded']);
    });

    it('resumes the recorded run without a second start', async () => {
        const { deps, start } = runner({ outcome: 'resume', runId: 'run1234567', status: 'started' });
        await runCherryActor(request, deps);
        expect(start).not.toHaveBeenCalled();
    });

    it('waits for a running actor, and records an unknown start for an operator', async () => {
        const pending = runner({ outcome: 'reserved' }, { status: 'RUNNING' });
        await expect(runCherryActor(request, pending.deps)).rejects.toMatchObject({ code: 'provider_pending' });
        expect(pending.updates.map(update => update.status)).toEqual(['started']);
        const unknown = runner({ outcome: 'reserved' }, { start: async () => { throw new Error('socket hang up'); } });
        await expect(runCherryActor(request, unknown.deps)).rejects.toBeInstanceOf(CherryDeferError);
        expect(unknown.updates.map(update => update.status)).toEqual(['ambiguous']);
    });

    it('does not start without budget or capacity', async () => {
        for (const outcome of ['budget', 'capacity', 'ambiguous']) {
            const { deps, start } = runner({ outcome });
            await expect(runCherryActor(request, deps)).rejects.toMatchObject({ code: `provider_${outcome}` });
            expect(start).not.toHaveBeenCalled();
        }
    });
});
