import { describe, expect, it } from 'vitest';
import {
    canCollect, classifyUnseen, diffBaseline, diffObservations, listGap, requiredCoverage,
    type CherryListAccount, type CherryObservation, type CherryRelation,
} from '@/lib/services/cherry/detection';

const NOW = Date.parse('2026-12-10T00:00:00Z');
const DAY = 86_400_000;
const account = (id: string): CherryListAccount => ({ id, username: `u${id}`, fullName: null, isPrivate: false, isVerified: false });
const stored = (followers: string[], following: string[]) => new Map<string, CherryRelation>(
    diffBaseline(followers.map(account), following.map(account)).changed.map(row => [row.id, row]),
);
const observe = (direction: 'followers' | 'following', list: string[], declaredCount: number, previousCount: number, previousGap = 0): CherryObservation =>
    ({ direction, accounts: list.map(account), declaredCount, previousCount, previousGap });
const merge = (relations: Map<string, CherryRelation>, changed: CherryRelation[]) =>
    new Map([...relations, ...changed.map(row => [row.id, row] as const)]);

describe('cherry detection', () => {
    it('counts the first mutual list without announcing it', () => {
        expect(diffBaseline(['1', '2'].map(account), ['2', '3'].map(account))).toMatchObject({ events: [], mutuals: 1 });
    });

    it('announces a follow-back wherever it appears in the list', () => {
        const diff = diffObservations(stored(['1', '2', '3'], ['9', '8']), [observe('followers', ['2', '1', '9', '3'], 4, 3)], NOW);
        expect(diff.events).toMatchObject([{ id: '9', kind: 'new', certainty: 'confirmed' }]);
        expect(diff.mutuals).toBe(1);
    });

    it('stays quiet about an account an earlier list had left out', () => {
        const diff = diffObservations(stored(['1', '2', '3'], ['9']), [observe('followers', ['9', '1', '2', '3'], 4, 4, 1)], NOW);
        expect(diff.events).toMatchObject([{ id: '9', kind: 'supplement' }]);
    });

    it('marks an announcement as possible when a left-out account could explain part of it', () => {
        const relations = stored(['1', '2', '3'], ['8', '9']);
        const one = diffObservations(relations, [observe('followers', ['1', '2', '3', '9'], 5, 4, 1)], NOW);
        expect(one.events).toMatchObject([{ id: '9', kind: 'new', certainty: 'confirmed' }]);
        const both = diffObservations(relations, [observe('followers', ['1', '2', '3', '8', '9'], 5, 4, 1)], NOW);
        expect(both.events.map(event => [event.id, event.certainty])).toEqual([['8', 'possible'], ['9', 'possible']]);
        expect(classifyUnseen(3, observe('followers', [], 4, 4, 1))).toBe('possible');
    });

    it('announces a left-out side when the other side was seen as new after the first list', () => {
        const relations = stored(['1', '2', '3'], ['5', '6']);
        const first = diffObservations(relations, [observe('following', ['9', '5', '6'], 3, 2)], NOW);
        expect(first.events).toEqual([]);
        const second = diffObservations(merge(relations, first.changed), [observe('followers', ['1', '2', '3', '9'], 4, 4, 1)], NOW);
        expect(second.events).toMatchObject([{ id: '9', kind: 'new', certainty: 'possible' }]);
    });

    it('announces both sides appearing on the same day once', () => {
        const diff = diffObservations(stored(['1', '2'], ['4', '5']), [
            observe('followers', ['9', '1', '2'], 3, 2), observe('following', ['9', '4', '5'], 3, 2),
        ], NOW);
        expect(diff.events.map(event => event.id)).toEqual(['9']);
    });

    it('never announces a mutual that only disappeared from a list for a while', () => {
        let relations = stored(['1', '2', '3', '4'], ['4']);
        const gone = diffObservations(relations, [observe('followers', ['1', '2', '3'], 3, 4)], NOW);
        expect(gone).toMatchObject({ mutuals: 1, events: [], changed: [{ id: '4', follower: true, followerMisses: 1 }] });
        relations = merge(relations, gone.changed);
        const again = diffObservations(relations, [observe('followers', ['1', '2', '3'], 3, 3)], NOW + 5 * DAY);
        expect(again.changed).toMatchObject([{ id: '4', follower: true, followerMisses: 2 }]);
        relations = merge(relations, again.changed);
        const back = diffObservations(relations, [observe('followers', ['4', '1', '2', '3'], 4, 3)], NOW + 6 * DAY);
        expect(back.events).toEqual([]);
        expect(back.changed).toMatchObject([{ id: '4', followerMisses: 0, followerMissingSince: null }]);
    });

    it('announces a return only after two lists and two weeks without the account', () => {
        let relations = stored(['1', '2', '3', '4'], ['4']);
        relations = merge(relations, diffObservations(relations, [observe('followers', ['1', '2', '3'], 3, 4)], NOW).changed);
        const removed = diffObservations(relations, [observe('followers', ['1', '2', '3'], 3, 3)], NOW + 15 * DAY);
        expect(removed).toMatchObject({ mutuals: 0, changed: [{ id: '4', follower: false, following: true }] });
        relations = merge(relations, removed.changed);
        expect(diffObservations(relations, [observe('followers', ['4', '1', '2', '3'], 4, 3)], NOW + 20 * DAY).events)
            .toMatchObject([{ id: '4', kind: 'new' }]);
    });

    it('follows a renamed account by its id', () => {
        const relations = stored(['1'], ['1']);
        const diff = diffObservations(relations, [{ ...observe('followers', [], 1, 1), accounts: [{ ...account('1'), username: 'renamed' }] }], NOW);
        expect(diff.events).toEqual([]);
        expect(diff.changed).toMatchObject([{ id: '1', username: 'renamed' }]);
    });

    it('reads a quiet account at once and paces a busy one within its month', () => {
        const pace = (day: number, used: number, planned: number, listTotal: number) =>
            canCollect({ nowMs: NOW + day * DAY, periodStartMs: NOW, used, planned, monthlyLimit: 6000, listTotal });
        expect(pace(0, 0, 400, 800)).toBe(true);
        expect(pace(1, 1600, 400, 800)).toBe(false);
        expect(pace(3, 1600, 400, 800)).toBe(true);
        expect(pace(30, 5900, 750, 1500)).toBe(false);
    });

    it('accepts a slightly incomplete list only after retries', () => {
        expect([requiredCoverage(1), requiredCoverage(2), requiredCoverage(3)]).toEqual([0.985, 0.96, 0.93]);
        expect([listGap(475, 476), listGap(476, 475)]).toEqual([1, 0]);
    });
});
