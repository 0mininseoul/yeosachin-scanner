import { describe, expect, it, vi } from 'vitest';
import { routeRevenueGenderCandidates } from './revenue-routing-runtime';

const base = {
    requestId: '123e4567-e89b-42d3-a456-426614174000',
    relationshipCheckpointId: 'relationship-checkpoint-1',
    hmacSecret: 'revenue-routing-runtime-test-secret-at-least-32-characters',
};

function candidates(count: number) {
    return Array.from({ length: count }, (_, index) => ({
        mutualOrdinal: index + 1,
        candidateKey: `candidate:${index + 1}`,
        profilePicUrl: `https://cdn.example/${index + 1}.jpg`,
        fullname: `Candidate ${index + 1}`,
        imageContentHmac: 'a'.repeat(64),
    }));
}

const assessment = {
    femaleScore: 0.8,
    maleScore: 0.1,
    uncertaintyScore: 0.1,
    evidence: 'image_and_name' as const,
};

describe('revenue gender-routing runtime', () => {
    it('is a no-op for the production path', async () => {
        const assess = vi.fn();

        await expect(routeRevenueGenderCandidates({
            ...base,
            accessMode: 'production',
            planId: 'basic',
            candidates: candidates(101),
            assess,
        })).resolves.toBeNull();
        expect(assess).not.toHaveBeenCalled();
    });

    it('uses the requested Basic cohort only, then exposes no more than its selected 100 rows', async () => {
        const input = candidates(101);
        const assess = vi.fn(async (rows: readonly typeof input[number][]) => new Map(
            rows.map(row => [row.candidateKey, assessment])
        ));

        const result = await routeRevenueGenderCandidates({
            ...base,
            accessMode: 'test_entitlement',
            planId: 'basic',
            candidates: input,
            assess,
        });

        expect(assess).toHaveBeenCalledTimes(1);
        expect(assess).toHaveBeenCalledWith(input, 1);
        expect(result?.selectedMutualOrdinals).toHaveLength(100);
        expect(result?.manifest.selectedCount).toBe(100);
        expect(JSON.stringify(result?.manifest)).not.toContain('Candidate ');
        expect(JSON.stringify(result?.manifest)).not.toContain('cdn.example');
    });

    it('does not invoke stage-one AI when the public population is already within the plan cap', async () => {
        const assess = vi.fn();

        const result = await routeRevenueGenderCandidates({
            ...base,
            accessMode: 'test_entitlement',
            planId: 'basic',
            candidates: candidates(100),
            assess,
        });

        expect(assess).not.toHaveBeenCalled();
        expect(result?.manifest.selectedCount).toBe(100);
        expect(result?.manifest.modelAttemptedCount).toBe(0);
    });

    it('retries only unresolved candidates once and marks that call as attempt two', async () => {
        const input = candidates(120);
        const initial = new Map(input.slice(0, 100).map(row => [row.candidateKey, assessment]));
        const retry = new Map(input.slice(100).map(row => [row.candidateKey, assessment]));
        const assess = vi.fn(async (rows: readonly typeof input[number][], attempt: 1 | 2) => (
            attempt === 1 ? initial : retry
        ));

        const result = await routeRevenueGenderCandidates({
            ...base,
            accessMode: 'test_entitlement',
            planId: 'basic',
            candidates: input,
            assess,
        });

        expect(assess).toHaveBeenNthCalledWith(1, input, 1);
        expect(assess).toHaveBeenNthCalledWith(2, input.slice(100), 2);
        expect(result?.manifest.modelRetriedCount).toBe(20);
        expect(result?.manifest.modelFailedCount).toBe(0);
    });
});
