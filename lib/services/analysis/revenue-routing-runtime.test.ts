import { createHmac } from 'node:crypto';
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
const preparedImageBase64 = Buffer.from(preparedImage).toString('base64');

async function prepareEveryImage(sources: readonly { candidateKey: string; fullname: string | null }[]) {
    return sources.map(source => ({
        candidateKey: source.candidateKey,
        fullname: source.fullname,
        imageBytes: preparedImage,
    }));
}

describe('revenue gender-routing runtime', () => {
    it('loads a current complete manifest before preparation or assessment, even when the CDN evidence would now fail', async () => {
        const completeHeader = {
            status: 'complete' as const,
            attemptCount: 1,
            requestId: base.requestId,
            relationshipCheckpointId: 'a'.repeat(64),
            policyVersion: 'gender-routing-v1' as const,
            planId: 'basic' as const,
            canonicalInputHmac: 'b'.repeat(64),
            populationCount: 101,
            detailedCap: 100 as const,
            relationshipJobInputHash: 'd'.repeat(64),
            selectedCount: 100,
            modelAttemptedCount: 101,
            modelValidCount: 101,
            modelFailedCount: 0,
            modelRetriedCount: 0,
            quotaFemaleShortfall: 0,
            quotaUncertaintyShortfall: 20,
            femalePriorityCount: 101,
            uncertaintyCount: 0,
            maleDeprioritizedCount: 0,
            selectedFemalePriorityCount: 100,
            selectedUncertaintyCount: 0,
            selectedMaleDeprioritizedCount: 0,
        };
        const manifestStore = {
            loadCurrentComplete: vi.fn(async () => ({
                header: completeHeader,
                selected: Array.from({ length: 100 }, (_, index) => ({
                    mutualOrdinal: index + 1,
                    candidateKey: `mutual:${index + 1}`,
                    selectionSlot: 'female' as const,
                    ordinal: index + 1,
                })),
            })),
            begin: vi.fn(),
            publish: vi.fn(),
            loadSelected: vi.fn(),
            loadSelectedUsernames: vi.fn(),
        } as unknown as AnalysisV2GenderRoutingManifestStore;
        const inputPreparer = vi.fn(async () => {
            throw new Error('CDN_CHANGED');
        });

        const result = await routeAndPersistRevenueGenderCandidates({
            ...base,
            relationshipCheckpointId: 'a'.repeat(64),
            accessMode: 'test_entitlement',
            planId: 'basic',
            candidates: Array.from({ length: 101 }, (_, index) => ({
                mutualOrdinal: index + 1,
                candidateKey: `mutual:${index + 1}`,
                profilePicUrl: 'https://cdn.example/now-failing.jpg',
                fullname: 'Now changed',
            })),
            inputPreparer,
            jobKey: 'track:relationships:collect',
            claimToken: '123e4567-e89b-42d3-a456-426614174001',
            jobInputHash: 'd'.repeat(64),
            manifestStore,
        });

        expect(manifestStore.loadCurrentComplete).toHaveBeenCalledTimes(1);
        expect(inputPreparer).not.toHaveBeenCalled();
        expect(manifestStore.begin).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            canonicalInputHmac: 'b'.repeat(64),
            selectedMutualOrdinals: Array.from({ length: 100 }, (_, index) => index + 1),
        });
    });

    it('rejects a missing assessor before preparation when no complete manifest exists', async () => {
        const manifestStore = {
            loadCurrentComplete: vi.fn(async () => null),
            begin: vi.fn(),
            publish: vi.fn(),
            loadSelected: vi.fn(),
            loadSelectedUsernames: vi.fn(),
        } as unknown as AnalysisV2GenderRoutingManifestStore;
        const inputPreparer = vi.fn(async () => {
            throw new Error('DOWNLOADER_MUST_NOT_RUN');
        });

        await expect(routeAndPersistRevenueGenderCandidates({
            ...base,
            relationshipCheckpointId: 'a'.repeat(64),
            accessMode: 'test_entitlement',
            planId: 'basic',
            candidates: Array.from({ length: 101 }, (_, index) => ({
                mutualOrdinal: index + 1,
                candidateKey: `mutual:${index + 1}`,
                profilePicUrl: 'https://cdn.example/would-download.jpg',
                fullname: 'Would prepare',
            })),
            inputPreparer,
            jobKey: 'track:relationships:collect',
            claimToken: '123e4567-e89b-42d3-a456-426614174001',
            jobInputHash: 'd'.repeat(64),
            manifestStore,
        })).rejects.toThrow('ANALYSIS_V2_GENDER_ROUTING_ASSESSOR_MISSING');

        expect(inputPreparer).not.toHaveBeenCalled();
        expect(manifestStore.begin).not.toHaveBeenCalled();
    });

    it('fails closed when a preparer substitutes a fullname for the same candidate key', async () => {
        const assess = vi.fn();
        await expect(routeRevenueGenderCandidates({
            ...base,
            accessMode: 'test_entitlement',
            planId: 'basic',
            candidates: candidates(101),
            inputPreparer: async sources => sources.map(source => ({
                candidateKey: source.candidateKey,
                fullname: source.candidateKey === 'candidate:1' ? 'Substituted name' : source.fullname,
                imageBytes: null,
            })),
            assess,
        })).rejects.toThrow('REVENUE_GENDER_ROUTING_PREPARATION_DRIFT');
        expect(assess).not.toHaveBeenCalled();
    });

    it('uses deterministic assessor microbatches of at most ten and preserves exact retry evidence', async () => {
        const input = candidates(201);
        const calls: Array<{ attempt: number; evidence: Map<string, string | null> }> = [];
        const assess = vi.fn(async (rows: readonly RevenueGenderRoutingModelCandidate[], attempt: 1 | 2) => {
            calls.push({ attempt, evidence: new Map(rows.map(row => [row.candidateKey, row.imageBase64])) });
            return new Map(rows
                .filter(row => attempt === 2 || Number(row.candidateKey.slice('candidate:'.length)) <= 180)
                .map(row => [row.candidateKey, assessment]));
        });

        const result = await routeRevenueGenderCandidates({
            ...base,
            accessMode: 'test_entitlement',
            planId: 'standard',
            candidates: input,
            inputPreparer: prepareEveryImage,
            assess,
        });

        expect(assess.mock.calls.every(([rows]) => rows.length <= 10)).toBe(true);
        expect(calls.filter(call => call.attempt === 1)).toHaveLength(21);
        const firstEvidence = calls.find(call => call.attempt === 1 && call.evidence.has('candidate:200'))!;
        const retryEvidence = calls.find(call => call.attempt === 2 && call.evidence.has('candidate:200'))!;
        expect(retryEvidence.evidence.get('candidate:200')).toBe(firstEvidence.evidence.get('candidate:200'));
        expect(result?.manifest.rows.find(row => row.candidateKey === 'candidate:200')?.imageContentHmac).toMatch(/^[a-f0-9]{64}$/);
    });

    it('rejects aggregate normalized image evidence before building an unbounded Standard payload', async () => {
        const assess = vi.fn();
        await expect(routeRevenueGenderCandidates({
            ...base,
            accessMode: 'test_entitlement',
            planId: 'standard',
            candidates: candidates(201),
            inputPreparer: async sources => sources.map(source => ({
                candidateKey: source.candidateKey,
                fullname: source.fullname,
                imageBytes: Uint8Array.from({ length: 256 * 1024 }, (_, index) => (
                    index === 0 ? Number(source.candidateKey.slice('candidate:'.length)) : 0
                )),
            })),
            assess,
        })).rejects.toThrow('REVENUE_GENDER_ROUTING_IMAGE_BUDGET_EXCEEDED');
        expect(assess).not.toHaveBeenCalled();
    });
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
            imageBase64: preparedImageBase64,
        }));
        const assess = vi.fn(async (rows: readonly { candidateKey: string }[], attempt: 1 | 2) => {
            expect(attempt).toBe(1);
            return new Map(rows.map(row => [row.candidateKey, assessment]));
        });

        const result = await routeRevenueGenderCandidates({
            ...base,
            accessMode: 'test_entitlement',
            planId: 'basic',
            candidates: input,
            inputPreparer: prepareEveryImage,
            assess,
        });

        expect(assess).toHaveBeenCalledTimes(11);
        expect(assess.mock.calls.flatMap(([rows]) => rows)).toEqual(modelInput.map(row => (
            expect.objectContaining({ ...row, inputHmac: expect.stringMatching(/^[a-f0-9]{64}$/) })
        )));
        expect(assess.mock.calls.every(([rows, attempt]) => rows.length <= 10 && attempt === 1)).toBe(true);
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
            imageBase64: preparedImageBase64,
        }));
        const assess = vi.fn(async (rows: readonly { candidateKey: string }[], attempt: 1 | 2) => (
            new Map(rows
                .filter(row => attempt === 2 || Number(row.candidateKey.slice('candidate:'.length)) <= 100)
                .map(row => [row.candidateKey, assessment]))
        ));

        const result = await routeRevenueGenderCandidates({
            ...base,
            accessMode: 'test_entitlement',
            planId: 'basic',
            candidates: input,
            inputPreparer: prepareEveryImage,
            assess,
        });

        expect(assess.mock.calls.filter(([, attempt]) => attempt === 1).flatMap(([rows]) => rows)).toEqual(
            modelInput.map(row => expect.objectContaining({
                ...row,
                inputHmac: expect.stringMatching(/^[a-f0-9]{64}$/),
            }))
        );
        expect(assess.mock.calls.filter(([, attempt]) => attempt === 2).flatMap(([rows]) => rows)).toEqual(
            modelInput.slice(100).map(row => expect.objectContaining({
                ...row,
                inputHmac: expect.stringMatching(/^[a-f0-9]{64}$/),
            }))
        );
        expect(result?.manifest.modelRetriedCount).toBe(20);
        expect(result?.manifest.modelFailedCount).toBe(0);
    });

    it('binds immutable base64 model evidence to the persisted content HMAC on both attempts', async () => {
        const image = new Uint8Array([0xff, 0xd8, 0xff, 0x01]);
        const imageBase64 = Buffer.from(image).toString('base64');
        const input = candidates(120);
        const assess = vi.fn(async (
            rows: readonly RevenueGenderRoutingModelCandidate[],
            attempt: 1 | 2,
        ) => {
            for (const row of rows) {
                expect(row).toMatchObject({ imageBase64 });
                expect(row).not.toHaveProperty('imageBytes');
            }
            return new Map(rows
                .filter(row => attempt === 2 || Number(row.candidateKey.slice('candidate:'.length)) <= 100)
                .map(row => [row.candidateKey, assessment]));
        });

        const result = await routeRevenueGenderCandidates({
            ...base,
            accessMode: 'test_entitlement',
            planId: 'basic',
            candidates: input,
            inputPreparer: async sources => sources.map(source => ({
                candidateKey: source.candidateKey,
                fullname: source.fullname,
                imageBytes: new Uint8Array(image),
            })),
            assess,
        });

        const expectedHmac = createHmac('sha256', base.hmacSecret)
            .update('gender-routing:image-content:v1\0')
            .update(Buffer.from(imageBase64, 'base64'))
            .digest('hex');
        expect(assess).toHaveBeenCalledTimes(14);
        expect(result?.manifest.rows.every(row => row.imageContentHmac === expectedHmac)).toBe(true);
    });

    it('does not retry at exactly ten percent initial failures and retains those candidates as unavailable', async () => {
        const input = candidates(110);
        const assess = vi.fn(async (
            rows: readonly { candidateKey: string }[],
            attempt: 1 | 2,
        ) => {
            void attempt;
            return new Map(rows
                .filter(row => Number(row.candidateKey.slice('candidate:'.length)) <= 99)
                .map(row => [row.candidateKey, assessment]));
        });

        const result = await routeRevenueGenderCandidates({
            ...base,
            accessMode: 'test_entitlement',
            planId: 'basic',
            candidates: input,
            inputPreparer: prepareEveryImage,
            assess,
        });

        expect(assess).toHaveBeenCalledTimes(11);
        expect(result?.manifest.modelRetriedCount).toBe(0);
        expect(result?.manifest.modelFailedCount).toBe(11);
        expect(result?.manifest.rows.filter(row => row.routingUnavailable)).toHaveLength(11);
    });

    it('uses integer greater-than-ten-percent semantics and never re-bills valid rows in a mixed microbatch retry', async () => {
        const input = candidates(120);
        const assess = vi.fn(async (
            rows: readonly { candidateKey: string }[], attempt: 1 | 2,
        ) => new Map(rows
            .filter(row => attempt === 2 || Number(row.candidateKey.slice('candidate:'.length)) <= 107)
            .map(row => [row.candidateKey, assessment])));

        const result = await routeRevenueGenderCandidates({
            ...base,
            accessMode: 'test_entitlement',
            planId: 'basic',
            candidates: input,
            inputPreparer: prepareEveryImage,
            assess,
        });

        const retried = assess.mock.calls
            .filter(([, attempt]) => attempt === 2)
            .flatMap(([rows]) => rows.map(row => row.candidateKey));
        expect(retried).toEqual(input.slice(107).map(row => row.candidateKey));
        expect(retried).not.toContain('candidate:1');
        expect(result?.manifest).toMatchObject({
            modelAttemptedCount: 120,
            modelRetriedCount: 13,
            modelFailedCount: 0,
        });
    });

    it('does not retry an exact integer ten-percent failure burden', async () => {
        const input = candidates(120);
        const assess = vi.fn(async (
            rows: readonly { candidateKey: string }[],
            attempt: 1 | 2,
        ) => {
            void attempt;
            return new Map(rows
                .filter(row => Number(row.candidateKey.slice('candidate:'.length)) <= 108)
                .map(row => [row.candidateKey, assessment]));
        });

        const result = await routeRevenueGenderCandidates({
            ...base,
            accessMode: 'test_entitlement',
            planId: 'basic',
            candidates: input,
            inputPreparer: prepareEveryImage,
            assess,
        });

        expect(assess.mock.calls.filter(([, attempt]) => attempt === 2)).toHaveLength(0);
        expect(result?.manifest).toMatchObject({
            modelRetriedCount: 0,
            modelFailedCount: 12,
        });
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

        const retries = assess.mock.calls.filter(([, attempt]) => attempt === 2);
        expect(retries.flatMap(([rows]) => rows).map(row => row.candidateKey)).toEqual(input.map(row => row.candidateKey));
        expect(retries.every(([rows]) => rows.length <= 10)).toBe(true);
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
            username: 'handle_should_not_reach_assessor',
            bio: 'bio_should_not_reach_assessor',
            cachedProfile: { should_not_reach_assessor: true },
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
            const first = modelCandidates.find(candidate => candidate.candidateKey === 'candidate:1');
            if (first) expect(first).toMatchObject({
                candidateKey: 'candidate:1', fullname: 'Åda Lovelace', imageBase64: Buffer.from(image).toString('base64'),
            });
            expect(modelCandidates[0]).not.toHaveProperty('profilePicUrl');
            expect(modelCandidates[0]).not.toHaveProperty('username');
            expect(modelCandidates[0]).not.toHaveProperty('bio');
            expect(modelCandidates[0]).not.toHaveProperty('cachedProfile');
            expect(modelCandidates[0]?.inputHmac).toMatch(/^[a-f0-9]{64}$/);
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
        expect(JSON.stringify(inputPreparer.mock.calls)).not.toContain('handle_should_not_reach_assessor');
        expect(JSON.stringify(inputPreparer.mock.calls)).not.toContain('bio_should_not_reach_assessor');
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
            loadCurrentComplete: vi.fn(async () => null),
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

        expect(assess).toHaveBeenCalledTimes(14);
        expect(assess.mock.calls.filter(([, attempt]) => attempt === 2).flatMap(([modelCandidates]) => modelCandidates)).toEqual(
            rows.slice(100).map(row => expect.objectContaining({
                candidateKey: row.candidateKey,
                fullname: row.fullname,
                imageBase64: null,
                inputHmac: expect.stringMatching(/^[a-f0-9]{64}$/),
            }))
        );
        expect(publication.value?.modelRetriedCount).toBe(12);
        expect(publication.value?.modelFailedCount).toBe(11);
        expect(result?.selectedMutualOrdinals).toHaveLength(100);
        expect(publication.value?.rows.every(row => !('username' in row) && !('profilePicUrl' in row))).toBe(true);
    });
});
