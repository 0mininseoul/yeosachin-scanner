import { describe, expect, it } from 'vitest';
import {
    consumeTestAdmissionCredential,
    consumeTestEntitlementToken,
    normalizeInstagramUsername,
    readTestAdmissionCredential,
    readTestEntitlementToken,
    testAdmissionStorageKey,
    testEntitlementStorageKey,
} from './v2-client-credentials';

function memoryStorage(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    return {
        getItem: (key: string) => values.get(key) ?? null,
        removeItem: (key: string) => values.delete(key),
    };
}

describe('analysis V2 client credentials', () => {
    it('normalizes only supported Instagram usernames', () => {
        expect(normalizeInstagramUsername(' @Target.User ')).toBe('target.user');
        expect(normalizeInstagramUsername('target-user')).toBeNull();
        expect(normalizeInstagramUsername('')).toBeNull();
    });

    it('reads and consumes a target-bound signed admission credential', () => {
        const target = 'target.user';
        const key = testAdmissionStorageKey(target);
        const storage = memoryStorage({
            [key]: JSON.stringify({
                idempotencyKey: 'preflight-key-000000000000',
                token: 'v1.payload.signature',
            }),
        });

        expect(readTestAdmissionCredential(storage, target)).toEqual({
            idempotencyKey: 'preflight-key-000000000000',
            token: 'v1.payload.signature',
        });
        consumeTestAdmissionCredential(storage, target);
        expect(readTestAdmissionCredential(storage, target)).toBeNull();
    });

    it('rejects malformed operator material without throwing or exposing it', () => {
        const target = 'target';
        const storage = memoryStorage({
            [testAdmissionStorageKey(target)]: JSON.stringify({
                idempotencyKey: 'short',
                token: 'not-signed',
            }),
        });

        expect(readTestAdmissionCredential(storage, target)).toBeNull();
    });

    it('reads plan-bound entitlements and removes only the consumed plan', () => {
        const preflightId = '123e4567-e89b-42d3-a456-426614174000';
        const standard = testEntitlementStorageKey(preflightId, 'standard');
        const plus = testEntitlementStorageKey(preflightId, 'plus');
        const storage = memoryStorage({
            [standard]: 'v1.standard.signature',
            [plus]: 'v1.plus.signature',
        });

        expect(readTestEntitlementToken(storage, preflightId, 'standard'))
            .toBe('v1.standard.signature');
        consumeTestEntitlementToken(storage, preflightId, 'standard');
        expect(readTestEntitlementToken(storage, preflightId, 'standard')).toBeNull();
        expect(readTestEntitlementToken(storage, preflightId, 'plus'))
            .toBe('v1.plus.signature');
    });
});
