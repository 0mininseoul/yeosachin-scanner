import { describe, expect, it, vi } from 'vitest';
import type {
    AnalysisV2GenderRoutingManifestPublishInput,
    AnalysisV2GenderRoutingManifestStore,
} from './gender-routing-manifest-store';
import {
    routeAndPersistRevenueGenderCandidates,
    routeRevenueGenderCandidates,
    type RevenueGenderRoutingModelCandidate,
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

const nameOnlyAssessment = {
    ...assessment,
    evidence: 'name_only' as const,
};

const preparedImage = new Uint8Array([9, 8, 7]);

async function prepareEveryImage(sources: readonly { candidateKey: string; fullname: string | null }[]) {
    return sources.map(source => ({
        candidateKey: source.candidateKey,
        fullname: source.fullname,
        imageBytes: preparedImage,
    }));
}

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

    it('is a no-op for Plus even when a preparer is installed', async () => {
        const assess = vi.fn();
        const inputPreparer = vi.fn();

        await expect(routeRevenueGenderCandidates({
            ...base,
            accessMode: 'test_entitlement',
            planId: 'plus',
            candidates: candidates(101),
            inputPreparer,
            assess,
        })).resolves.toBeNull();
        expect(inputPreparer).not.toHaveBeenCalled();
        expect(assess).not.toHaveBeenCalled();
    });

    it('uses the requested Basic cohort only, then exposes no more than its selected 100 rows', async () => {
        const input = candidates(101);
        const modelInput = input.map(({ candidateKey, fullname }) => ({
            candidateKey,
            fullname,
            imageBytes: preparedImage,
        }));
        const assess = vi.fn(async (rows: readonly { candidateKey: string }[]) => new Map(
            rows.map(row => [row.candidateKey, assessment])
        ));

        const result = await routeRevenueGenderCandidates({
            ...base,
            accessMode: 'test_entitlement',
            planId: 'basic',
            candidates: input,
            inputPreparer: prepareEveryImage,
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
            const inputPreparer = vi.fn();
            const result = await routeRevenueGenderCandidates({
                ...base,
                accessMode: 'test_entitlement',
                planId,
                candidates: candidates(count),
                inputPreparer,
                assess,
            });

            expect(assess).not.toHaveBeenCalled();
            expect(inputPreparer).not.toHaveBeenCalled();
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
        const modelInput = input.map(({ candidateKey, fullname }) => ({
            candidateKey,
            fullname,
            imageBytes: preparedImage,
        }));
        const initial = new Map(input.slice(0, 100).map(row => [row.candidateKey, assessment]));
        const retry = new Map(input.slice(100).map(row => [row.candidateKey, assessment]));
        const assess = vi.fn(async (rows: readonly { candidateKey: string }[], attempt: 1 | 2) => (
            attempt === 1 ? initial : retry
        ));

        const result = await routeRevenueGenderCandidates({
            ...base,
            accessMode: 'test_entitlement',
            planId: 'basic',
            candidates: input,
            inputPreparer: prepareEveryImage,
            assess,
        });

        expect(assess).toHaveBeenNthCalledWith(1, modelInput, 1);
        expect(assess).toHaveBeenNthCalledWith(2, modelInput.slice(100), 2);
        expect(result?.manifest.modelRetriedCount).toBe(20);
        expect(result?.manifest.modelFailedCount).toBe(0);
    });

    it('does not retry at exactly ten percent initial failures and retains those candidates as unavailable', async () => {
        const input = candidates(110);
        const initial = new Map(input.slice(0, 99).map(row => [row.candidateKey, assessment]));
        const assess = vi.fn(async () => initial);

        const result = await routeRevenueGenderCandidates({
            ...base,
            accessMode: 'test_entitlement',
            planId: 'basic',
            candidates: input,
            inputPreparer: prepareEveryImage,
            assess,
        });

        expect(assess).toHaveBeenCalledTimes(1);
        expect(result?.manifest.modelRetriedCount).toBe(0);
        expect(result?.manifest.modelFailedCount).toBe(11);
        expect(result?.manifest.rows.filter(row => row.routingUnavailable)).toHaveLength(11);
    });

    it('retries every callable candidate once when the initial stage has zero valid results', async () => {
        const input = candidates(101);
        const assess = vi.fn(async (
            rows: readonly { candidateKey: string }[],
            attempt: 1 | 2,
        ) => attempt === 1 ? new Map() : new Map(rows.map(row => [row.candidateKey, assessment])));

        const result = await routeRevenueGenderCandidates({
            ...base,
            accessMode: 'test_entitlement',
            planId: 'basic',
            candidates: input,
            inputPreparer: prepareEveryImage,
            assess,
        });

        expect(assess).toHaveBeenNthCalledWith(2, expect.arrayContaining([
            expect.objectContaining({ candidateKey: 'candidate:1' }),
            expect.objectContaining({ candidateKey: 'candidate:101' }),
        ]), 2);
        expect(assess.mock.calls[1]?.[0]).toHaveLength(101);
        expect(result?.manifest).toMatchObject({
            modelAttemptedCount: 101,
            modelRetriedCount: 101,
            modelValidCount: 101,
            modelFailedCount: 0,
        });
    });

    it('uses only normalized prepared evidence at the assessor boundary and fingerprints image bytes', async () => {
        const input = candidates(101).map((candidate, index) => ({
            ...candidate,
            profilePicUrl: `https://raw-url.example/${index + 1}?volatile=1`,
            fullname: index === 0 ? '  A\u030Ada\tLovelace  ' : candidate.fullname,
        }));
        const image = new Uint8Array([1, 2, 3, 4]);
        const inputPreparer = vi.fn(async (sources: readonly { candidateKey: string; fullname: string | null }[]) => (
            sources.map(source => ({
                candidateKey: source.candidateKey,
                fullname: source.fullname,
                imageBytes: image,
            }))
        ));
        const assess = vi.fn(async (modelCandidates: readonly RevenueGenderRoutingModelCandidate[]) => {
            expect(modelCandidates[0]).toMatchObject({
                candidateKey: 'candidate:1',
                fullname: 'Åda Lovelace',
                imageBytes: image,
            });
            expect(modelCandidates[0]).not.toHaveProperty('profilePicUrl');
            return new Map(modelCandidates.map(candidate => [candidate.candidateKey as string, assessment]));
        });

        const result = await routeRevenueGenderCandidates({
            ...base,
            accessMode: 'test_entitlement',
            planId: 'basic',
            candidates: input,
            inputPreparer,
            assess,
        });

        expect(inputPreparer).toHaveBeenCalledTimes(1);
        expect(result?.manifest.rows[0]).toMatchObject({
            hasImage: true,
            hasName: true,
            evidence: 'image_and_name',
        });
        expect(result?.manifest.rows[0]?.imageContentHmac).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(result?.manifest)).not.toContain('raw-url.example');
        expect(JSON.stringify(result?.manifest)).not.toContain('Åda Lovelace');
    });

    it('binds canonical input to normalized image bytes rather than URL text and marks fetch failures correctly', async () => {
        const baseCandidates = candidates(101);
        const assess = async (modelCandidates: readonly RevenueGenderRoutingModelCandidate[]) => new Map(
            modelCandidates.map(candidate => [candidate.candidateKey, assessment]),
        );
        const route = async (profileUrl: string, imageBytes: Uint8Array) => routeRevenueGenderCandidates({
            ...base,
            accessMode: 'test_entitlement',
            planId: 'basic',
            candidates: baseCandidates.map(candidate => ({ ...candidate, profilePicUrl: profileUrl })),
            inputPreparer: async sources => sources.map(source => ({
                candidateKey: source.candidateKey,
                fullname: source.fullname,
                imageBytes,
            })),
            assess,
        });
        const first = await route('https://image.example/a.jpg?refresh=1', new Uint8Array([1, 2, 3]));
        const sameBytes = await route('https://image.example/a.jpg?refresh=2', new Uint8Array([1, 2, 3]));
        const changedBytes = await route('https://image.example/a.jpg?refresh=2', new Uint8Array([1, 2, 4]));

        expect(first?.manifest.canonicalInputHmac).toBe(sameBytes?.manifest.canonicalInputHmac);
        expect(first?.manifest.canonicalInputHmac).not.toBe(changedBytes?.manifest.canonicalInputHmac);

        const failedFetch = await routeRevenueGenderCandidates({
            ...base,
            accessMode: 'test_entitlement',
            planId: 'basic',
            candidates: baseCandidates.map((candidate, index) => index === 0 ? {
                ...candidate,
                profilePicUrl: 'https://image.example/fetch-failed.jpg',
                fullname: null,
            } : candidate),
            inputPreparer: async sources => sources.map(source => ({
                candidateKey: source.candidateKey,
                fullname: source.fullname,
                imageBytes: null,
            })),
            assess: async modelCandidates => new Map(modelCandidates.map(candidate => [candidate.candidateKey, nameOnlyAssessment])),
        });
        expect(failedFetch?.manifest.rows.find(row => row.candidateKey === 'candidate:1')).toMatchObject({
            hasImage: false,
            hasName: false,
            evidence: 'none',
            routingUnavailable: true,
        });
    });

    it('persists a globally unavailable partial retry and exposes only durable selected ordinals', async () => {
        const publication: { value: AnalysisV2GenderRoutingManifestPublishInput | null } = { value: null };
        const rows = Array.from({ length: 112 }, (_, index) => ({
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
            relationshipJobInputHash: input.jobInputHash,
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
                relationshipJobInputHash: input.jobInputHash,
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
            .filter(candidate => attempt === 1
                ? Number(candidate.candidateKey.slice('mutual:'.length)) <= 100
                : candidate.candidateKey === 'mutual:101')
            .map(candidate => [candidate.candidateKey, nameOnlyAssessment])));

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
        expect(assess.mock.calls[1]?.[0]).toEqual(rows.slice(100).map(row => ({
            candidateKey: row.candidateKey,
            fullname: row.fullname,
            imageBytes: null,
        })));
        expect(publication.value?.modelRetriedCount).toBe(12);
        expect(publication.value?.modelFailedCount).toBe(11);
        expect(result?.selectedMutualOrdinals).toHaveLength(100);
        expect(publication.value?.rows.every(row => !('username' in row) && !('profilePicUrl' in row))).toBe(true);
    });
});
