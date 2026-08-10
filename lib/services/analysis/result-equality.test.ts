import { describe, expect, it } from 'vitest';
import { assertOwnerAdminResultEquality, ResultEqualityError, resultRevisionContentHash } from './result-equality';

const base = {
    requestId: '123e4567-e89b-42d3-a456-426614174000', resultRevisionId: '123e4567-e89b-42d3-a456-426614174001', imageManifestId: '123e4567-e89b-42d3-a456-426614174002',
    candidateOrder: ['candidate:1', 'candidate:2'], payload: { b: 2, a: 1 },
};
describe('owner/admin immutable result equality', () => {
    it('hashes stable payload independent of object key order', () => {
        expect(resultRevisionContentHash(base)).toBe(resultRevisionContentHash({ ...base, payload: { a: 1, b: 2 } }));
    });
    it('requires the same revision and image manifest for owner/admin', () => {
        expect(assertOwnerAdminResultEquality({ ...base, viewer: 'owner' }, { ...base, viewer: 'admin' })).toHaveLength(64);
        expect(() => assertOwnerAdminResultEquality({ ...base, viewer: 'owner' }, { ...base, viewer: 'admin', candidateOrder: ['candidate:2', 'candidate:1'] })).toThrowError(new ResultEqualityError('REVISION_MISMATCH'));
    });
});
