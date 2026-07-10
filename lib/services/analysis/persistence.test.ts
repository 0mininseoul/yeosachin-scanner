import { describe, expect, it } from 'vitest';
import {
    requireInsertedMutationRows,
    requireSingleMutationRow,
} from './persistence';

describe('analysis persistence guards', () => {
    it('accepts exactly one returned update row', () => {
        const row = { id: 'request-id' };
        expect(requireSingleMutationRow({ data: row, error: null }, 'step update')).toBe(row);
    });

    it('fails closed on update errors and zero affected rows without leaking details', () => {
        const secret = 'database detail containing private username';
        for (const result of [
            { data: null, error: null },
            { data: { id: 'request-id' }, error: new Error(secret) },
        ]) {
            expect(() => requireSingleMutationRow(result, 'step update'))
                .toThrow('ANALYSIS_PERSISTENCE_ERROR: step update failed.');
            try {
                requireSingleMutationRow(result, 'step update');
            } catch (error) {
                expect(String(error)).not.toContain(secret);
            }
        }
    });

    it('requires the complete expected insert result set', () => {
        expect(requireInsertedMutationRows({
            data: [{ id: 'a' }, { id: 'b' }],
            error: null,
        }, 2, 'result insert')).toHaveLength(2);
        expect(() => requireInsertedMutationRows({
            data: [{ id: 'a' }],
            error: null,
        }, 2, 'result insert')).toThrow('ANALYSIS_PERSISTENCE_ERROR');
        expect(() => requireInsertedMutationRows({
            data: null,
            error: new Error('database unavailable'),
        }, 2, 'result insert')).toThrow('ANALYSIS_PERSISTENCE_ERROR');
    });
});
