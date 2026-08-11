import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

import {
    ANALYSIS_V2_GENDER_ROUTING_MANIFEST_DATABASE_NAMES,
    createAnalysisV2GenderRoutingManifestStore,
    type AnalysisV2GenderRoutingManifestSupabaseClient,
} from './gender-routing-manifest-store';

const requestId = '7df77338-2672-4ef2-93fe-13a0683ec9b4';
const claimToken = '51b42f42-204d-4dfb-86f8-9658d21c78f1';
const jobInputHash = 'a'.repeat(64);
const checkpointId = 'b'.repeat(64);
const canonicalInputHmac = 'c'.repeat(64);
const completeHeader = {
    status: 'complete',
    attemptCount: 1,
    requestId,
    relationshipCheckpointId: checkpointId,
    policyVersion: 'gender-routing-v1',
    planId: 'basic',
    canonicalInputHmac,
    populationCount: 101,
    detailedCap: 100,
    relationshipJobInputHash: jobInputHash,
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

function client(data: unknown): AnalysisV2GenderRoutingManifestSupabaseClient {
    return { rpc: vi.fn(async () => ({ data, error: null })) };
}

describe('analysis V2 gender-routing manifest store', () => {
    it('begins the service-only manifest with its fenced request lineage and PII-free identity', async () => {
        const db = client({
            status: 'building',
            attemptCount: 1,
            requestId,
            relationshipCheckpointId: checkpointId,
            policyVersion: 'gender-routing-v1',
            planId: 'basic',
            canonicalInputHmac,
            populationCount: 101,
            detailedCap: 100,
            relationshipJobInputHash: jobInputHash,
        });
        const store = createAnalysisV2GenderRoutingManifestStore(db);

        const result = await store.begin({
            requestId,
            jobKey: 'track:relationships:collect',
            claimToken,
            jobInputHash,
            relationshipCheckpointId: checkpointId,
            policyVersion: 'gender-routing-v1',
            planId: 'basic',
            canonicalInputHmac,
            populationCount: 101,
            detailedCap: 100,
        });

        expect(result.status).toBe('building');
        expect(db.rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_GENDER_ROUTING_MANIFEST_DATABASE_NAMES.beginRpc,
            expect.objectContaining({
                p_request_id: requestId,
                p_job_key: 'track:relationships:collect',
                p_claim_token: claimToken,
                p_job_input_hash: jobInputHash,
                p_relationship_checkpoint_id: checkpointId,
                p_canonical_input_hmac: canonicalInputHmac,
            })
        );
        expect(JSON.stringify((db.rpc as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]))
            .not.toContain('username');
    });

    it('publishes a complete immutable candidate set and loads only selected ordinals', async () => {
        const db: AnalysisV2GenderRoutingManifestSupabaseClient = {
            rpc: vi.fn(async (name: string) => {
                if (name === ANALYSIS_V2_GENDER_ROUTING_MANIFEST_DATABASE_NAMES.publishRpc) {
                    return { data: completeHeader, error: null };
                }
                if (name === ANALYSIS_V2_GENDER_ROUTING_MANIFEST_DATABASE_NAMES.loadSelectedUsernamesRpc) {
                    return {
                        data: {
                            selectedCount: 1,
                            rows: [{
                                mutualOrdinal: 9,
                                candidateKey: 'mutual:9',
                                selectionSlot: 'female',
                                ordinal: 1,
                                username: 'worker_only_fixture',
                            }],
                        },
                        error: null,
                    };
                }
                return {
                    data: {
                        selectedCount: 1,
                        rows: [{
                            mutualOrdinal: 9,
                            candidateKey: 'mutual:9',
                            selectionSlot: 'female',
                            ordinal: 1,
                        }],
                    },
                    error: null,
                };
            }),
        };
        const store = createAnalysisV2GenderRoutingManifestStore(db);

        await expect(store.publish({
            requestId,
            jobKey: 'track:relationships:collect',
            claimToken,
            jobInputHash,
            relationshipCheckpointId: checkpointId,
            policyVersion: 'gender-routing-v1',
            planId: 'basic',
            canonicalInputHmac,
            populationCount: 101,
            detailedCap: 100,
            selectedCount: 100,
            modelAttemptedCount: 101,
            modelValidCount: 101,
            modelFailedCount: 0,
            modelRetriedCount: 0,
            quotaShortfalls: { female: 0, uncertainty: 20 },
            bucketCounts: { female_priority: 101, uncertainty: 0, male_deprioritized: 0 },
            selectedBucketCounts: { female_priority: 100, uncertainty: 0, male_deprioritized: 0 },
            rows: Array.from({ length: 101 }, (_, index) => ({
                mutualOrdinal: index + 1,
                candidateKey: `mutual:${index + 1}`,
                username: 'RAW_USERNAME_DO_NOT_PERSIST',
                fullname: 'RAW_FULLNAME_DO_NOT_PERSIST',
                profilePicUrl: 'https://raw-profile.example/do-not-persist.jpg',
                bio: 'RAW_BIO_DO_NOT_PERSIST',
                imageBytes: new Uint8Array([82, 65, 87, 95, 73, 77, 65, 71, 69]),
                target: 'RAW_TARGET_DO_NOT_PERSIST',
                token: 'RAW_TOKEN_DO_NOT_PERSIST',
                hasImage: true,
                hasName: true,
                imageContentHmac: 'd'.repeat(64),
                fullnameHmac: 'e'.repeat(64),
                femaleScore: 0.8,
                maleScore: 0.1,
                uncertaintyScore: 0.1,
                evidence: 'image_and_name' as const,
                bucket: 'female_priority' as const,
                routingUnavailable: false,
                selected: index < 100,
                selectionReason: index < 80 ? 'female_quota' as const : index < 100 ? 'fill' as const : 'not_selected' as const,
                selectionSlot: index < 80 ? 'female' as const : index < 100 ? 'fill' as const : null,
                ordinal: index < 100 ? index + 1 : null,
            })),
        })).resolves.toMatchObject({ status: 'complete', selectedCount: 100 });

        await expect(store.loadSelected({
            requestId,
            relationshipCheckpointId: checkpointId,
            policyVersion: 'gender-routing-v1',
            planId: 'basic',
        })).resolves.toEqual([{
            mutualOrdinal: 9,
            candidateKey: 'mutual:9',
            selectionSlot: 'female',
            ordinal: 1,
        }]);
        await expect(store.loadSelectedUsernames({
            requestId,
            relationshipCheckpointId: checkpointId,
            policyVersion: 'gender-routing-v1',
            planId: 'basic',
        })).resolves.toEqual([{
            mutualOrdinal: 9,
            candidateKey: 'mutual:9',
            selectionSlot: 'female',
            ordinal: 1,
            username: 'worker_only_fixture',
        }]);
        const publishParams = (db.rpc as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
        expect(JSON.stringify(publishParams)).not.toContain('RAW_USERNAME_DO_NOT_PERSIST');
        expect(JSON.stringify(publishParams)).not.toContain('RAW_FULLNAME_DO_NOT_PERSIST');
        expect(JSON.stringify(publishParams)).not.toContain('https://raw-profile.example/do-not-persist.jpg');
        expect(JSON.stringify(publishParams)).not.toContain('RAW_BIO_DO_NOT_PERSIST');
        expect(JSON.stringify(publishParams)).not.toContain('imageBytes');
        expect(JSON.stringify(publishParams)).not.toContain('RAW_TARGET_DO_NOT_PERSIST');
        expect(JSON.stringify(publishParams)).not.toContain('RAW_TOKEN_DO_NOT_PERSIST');
    });

    it('rejects a malformed complete header and a selected-row count drift from the RPC', async () => {
        const malformedComplete = { ...completeHeader } as Record<string, unknown>;
        delete malformedComplete.modelValidCount;
        const headerStore = createAnalysisV2GenderRoutingManifestStore(client(malformedComplete));
        await expect(headerStore.begin({
            requestId,
            jobKey: 'track:relationships:collect',
            claimToken,
            jobInputHash,
            relationshipCheckpointId: checkpointId,
            policyVersion: 'gender-routing-v1',
            planId: 'basic',
            canonicalInputHmac,
            populationCount: 101,
            detailedCap: 100,
        })).rejects.toThrow('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID_RESULT');

        const countDriftStore = createAnalysisV2GenderRoutingManifestStore(client({
            selectedCount: 2,
            rows: [{
                mutualOrdinal: 9,
                candidateKey: 'mutual:9',
                selectionSlot: 'female',
                ordinal: 1,
            }],
        }));
        await expect(countDriftStore.loadSelected({
            requestId,
            relationshipCheckpointId: checkpointId,
            policyVersion: 'gender-routing-v1',
            planId: 'basic',
        })).rejects.toThrow('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID_RESULT');

        const usernameDriftStore = createAnalysisV2GenderRoutingManifestStore(client({
            selectedCount: 2,
            rows: [{
                mutualOrdinal: 9,
                candidateKey: 'mutual:9',
                selectionSlot: 'female',
                ordinal: 1,
                username: 'worker_only_fixture',
            }],
        }));
        await expect(usernameDriftStore.loadSelectedUsernames({
            requestId,
            relationshipCheckpointId: checkpointId,
            policyVersion: 'gender-routing-v1',
            planId: 'basic',
        })).rejects.toThrow('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID_RESULT');
    });

    it('rejects a complete header whose selected count is not the policy-required minimum', async () => {
        const store = createAnalysisV2GenderRoutingManifestStore(client({
            header: {
                ...completeHeader,
                selectedCount: 99,
                selectedFemalePriorityCount: 99,
            },
            selected: {
                selectedCount: 99,
                rows: Array.from({ length: 99 }, (_, index) => ({
                    mutualOrdinal: index + 1,
                    candidateKey: `mutual:${index + 1}`,
                    selectionSlot: 'female',
                    ordinal: index + 1,
                })),
            },
        }));

        await expect(store.loadCurrentComplete({
            requestId,
            jobKey: 'track:relationships:collect',
            claimToken,
            jobInputHash,
            relationshipCheckpointId: checkpointId,
            policyVersion: 'gender-routing-v1',
            planId: 'basic',
        })).rejects.toThrow('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID_RESULT');
    });

    it('rejects score-bearing or unavailable rows when the actual population is within cap', async () => {
        const db = client(completeHeader);
        const store = createAnalysisV2GenderRoutingManifestStore(db);

        await expect(store.publish({
            requestId,
            jobKey: 'track:relationships:collect',
            claimToken,
            jobInputHash,
            relationshipCheckpointId: checkpointId,
            policyVersion: 'gender-routing-v1',
            planId: 'basic',
            canonicalInputHmac,
            populationCount: 1,
            detailedCap: 100,
            selectedCount: 1,
            modelAttemptedCount: 0,
            modelValidCount: 0,
            modelFailedCount: 0,
            modelRetriedCount: 0,
            quotaShortfalls: { female: 0, uncertainty: 0 },
            bucketCounts: { female_priority: 0, uncertainty: 1, male_deprioritized: 0 },
            selectedBucketCounts: { female_priority: 0, uncertainty: 1, male_deprioritized: 0 },
            rows: [{
                mutualOrdinal: 1,
                candidateKey: 'mutual:1',
                hasImage: false,
                hasName: false,
                imageContentHmac: null,
                fullnameHmac: null,
                femaleScore: 0,
                maleScore: 0,
                uncertaintyScore: 1,
                evidence: 'none',
                bucket: 'uncertainty',
                routingUnavailable: true,
                selected: true,
                selectionReason: 'population_within_cap',
                selectionSlot: 'fill',
                ordinal: 1,
            }],
        })).rejects.toThrow('ANALYSIS_V2_GENDER_ROUTING_MANIFEST_VALIDATION_ERROR');
        expect(db.rpc).not.toHaveBeenCalled();
    });
});
