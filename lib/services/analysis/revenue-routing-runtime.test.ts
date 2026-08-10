import { describe, expect, it, vi } from 'vitest';
import type {
    AnalysisV2GenderRoutingManifestPublishInput,
    AnalysisV2GenderRoutingManifestStore,
} from './gender-routing-manifest-store';
import {
    routeAndPersistRevenueGenderCandidates,
    routeRevenueGenderCandidates,
} from './revenue-routing-runtime';

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
        const modelInput = input.map(({ candidateKey, profilePicUrl, fullname }) => ({
            candidateKey,
            profilePicUrl,
            fullname,
        }));
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
        expect(assess).toHaveBeenCalledWith(modelInput, 1);
        expect(JSON.stringify(assess.mock.calls[0]?.[0])).not.toContain('mutualOrdinal');
        expect(JSON.stringify(assess.mock.calls[0]?.[0])).not.toContain('imageContentHmac');
        expect(result?.selectedMutualOrdinals).toHaveLength(100);
        expect(result?.manifest.selectedCount).toBe(100);
        expect(JSON.stringify(result?.manifest)).not.toContain('Candidate ');
        expect(JSON.stringify(result?.manifest)).not.toContain('cdn.example');
    });

    it('does not invoke stage-one AI when Basic or Standard public populations are within cap', async () => {
        for (const [planId, count] of [['basic', 100], ['standard', 200]] as const) {
            const assess = vi.fn();
            const result = await routeRevenueGenderCandidates({
                ...base,
                accessMode: 'test_entitlement',
                planId,
                candidates: candidates(count),
                assess,
            });

            expect(assess).not.toHaveBeenCalled();
            expect(result?.manifest.selectedCount).toBe(count);
            expect(result?.manifest.modelAttemptedCount).toBe(0);
        }
    });

    it('cannot bypass either plan population cap before a model boundary', async () => {
        for (const [planId, count] of [['basic', 401], ['standard', 801]] as const) {
            const assess = vi.fn();
            await expect(routeRevenueGenderCandidates({
                ...base,
                accessMode: 'test_entitlement',
                planId,
                candidates: candidates(count),
                assess,
            })).rejects.toThrow('GENDER_ROUTING_POPULATION_OVER_CAP');
            expect(assess).not.toHaveBeenCalled();
        }
    });

    it('retries only unresolved candidates once and marks that call as attempt two', async () => {
        const input = candidates(120);
        const modelInput = input.map(({ candidateKey, profilePicUrl, fullname }) => ({
            candidateKey,
            profilePicUrl,
            fullname,
        }));
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

        expect(assess).toHaveBeenNthCalledWith(1, modelInput, 1);
        expect(assess).toHaveBeenNthCalledWith(2, modelInput.slice(100), 2);
        expect(result?.manifest.modelRetriedCount).toBe(20);
        expect(result?.manifest.modelFailedCount).toBe(0);
    });

    it('persists one failed candidate retry and exposes only the durable selected ordinals', async () => {
        const publication: { value: AnalysisV2GenderRoutingManifestPublishInput | null } = { value: null };
        const rows = Array.from({ length: 101 }, (_, index) => ({
            mutualOrdinal: index + 1,
            candidateKey: `mutual:${index + 1}`,
            profilePicUrl: `https://cdn.example/${index + 1}.jpg`,
            fullname: `Candidate ${index + 1}`,
        }));
        const completeHeader = (input: AnalysisV2GenderRoutingManifestPublishInput) => ({
            status: 'complete' as const,
            attemptCount: 1,
            requestId: input.requestId,
            relationshipCheckpointId: input.relationshipCheckpointId,
            policyVersion: input.policyVersion,
            planId: input.planId,
            canonicalInputHmac: input.canonicalInputHmac,
            populationCount: input.populationCount,
            detailedCap: input.detailedCap,
            selectedCount: input.selectedCount,
            modelAttemptedCount: input.modelAttemptedCount,
            modelValidCount: input.modelValidCount,
            modelFailedCount: input.modelFailedCount,
            modelRetriedCount: input.modelRetriedCount,
            quotaFemaleShortfall: input.quotaShortfalls.female,
            quotaUncertaintyShortfall: input.quotaShortfalls.uncertainty,
            femalePriorityCount: input.bucketCounts.female_priority,
            uncertaintyCount: input.bucketCounts.uncertainty,
            maleDeprioritizedCount: input.bucketCounts.male_deprioritized,
            selectedFemalePriorityCount: input.selectedBucketCounts.female_priority,
            selectedUncertaintyCount: input.selectedBucketCounts.uncertainty,
            selectedMaleDeprioritizedCount: input.selectedBucketCounts.male_deprioritized,
        });
        const manifestStore: AnalysisV2GenderRoutingManifestStore = {
            begin: vi.fn(async input => ({
                status: 'building' as const,
                attemptCount: 1,
                requestId: input.requestId,
                relationshipCheckpointId: input.relationshipCheckpointId,
                policyVersion: input.policyVersion,
                planId: input.planId,
                canonicalInputHmac: input.canonicalInputHmac,
                populationCount: input.populationCount,
                detailedCap: input.detailedCap,
            })),
            publish: vi.fn(async input => {
                publication.value = input;
                return completeHeader(input);
            }),
            loadSelected: vi.fn(async () => publication.value!.rows.filter(row => row.selected).map(row => ({
                mutualOrdinal: row.mutualOrdinal,
                candidateKey: row.candidateKey,
                selectionSlot: row.selectionSlot!,
                ordinal: row.ordinal!,
            }))),
            loadSelectedUsernames: vi.fn(),
        };
        const assess = vi.fn(async (
            modelCandidates: readonly { candidateKey: string }[],
            attempt: 1 | 2,
        ) => new Map(modelCandidates
            .filter(candidate => attempt === 2 || candidate.candidateKey !== 'mutual:101')
            .map(candidate => [candidate.candidateKey, assessment])));

        const result = await routeAndPersistRevenueGenderCandidates({
            ...base,
            accessMode: 'test_entitlement',
            planId: 'basic',
            candidates: rows,
            assess,
            jobKey: 'track:relationships:collect',
            claimToken: '123e4567-e89b-42d3-a456-426614174001',
            jobInputHash: 'd'.repeat(64),
            manifestStore,
        });

        expect(assess).toHaveBeenCalledTimes(2);
        expect(assess.mock.calls[1]?.[0]).toEqual([{
            candidateKey: 'mutual:101',
            profilePicUrl: 'https://cdn.example/101.jpg',
            fullname: 'Candidate 101',
        }]);
        expect(publication.value?.modelRetriedCount).toBe(1);
        expect(result?.selectedMutualOrdinals).toHaveLength(100);
        expect(publication.value?.rows.every(row => !('username' in row) && !('profilePicUrl' in row))).toBe(true);
    });
});
