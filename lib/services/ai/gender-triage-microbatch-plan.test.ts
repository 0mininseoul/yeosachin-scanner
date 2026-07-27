import { describe, expect, it } from 'vitest';
import { planGenderTriageMicrobatches } from './gender-triage-microbatch-plan';

describe('production v2.9 gender microbatch planner', () => {
    it('stably sorts six opaque accounts into three paired operations', () => {
        const members = ['f', 'a', 'e', 'b', 'd', 'c'].map(value => ({
            accountId: `account:${value.repeat(64)}`,
            value,
        }));

        const batches = planGenderTriageMicrobatches(members);

        expect(batches.map(batch => batch.length)).toEqual([2, 2, 2]);
        expect(batches.flat().map(member => member.value))
            .toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    });
});
