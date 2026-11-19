import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
    createGoogleCloudPrivateMediaObjectClient,
    type AnalysisV2PrivateRetainedMediaObjectClient,
    type GoogleCloudStorageAuthorizedRequester,
} from '@/lib/services/analysis/v2-media-artifact-store';
import { createDevStandardEvalStore } from '@/lib/services/dev-ui/standard-eval-store';
import type { DevStandardEvalBundle } from '@/lib/services/dev-ui/standard-eval-types';

const bucketName = 'synthetic-project-dev-live-media';
const slot = 'a'.repeat(32);
const key = Buffer.alloc(32, 8).toString('base64');
const approvalA = '10000000-0000-4000-8000-000000000001';
const approvalB = '10000000-0000-4000-8000-000000000002';
const startTime = 1_800_000_000_000;
const retentionMs = 24 * 60 * 60 * 1_000;

function sampleBundle(expiresAt = startTime + retentionMs): DevStandardEvalBundle {
    const rows = [1, 2, 3].map(index => {
        const candidateId = `candidate:${String(index).repeat(40)}`;
        const selectionId = `profile:${index}`;
        return {
            candidateId,
            input: {
                triage: {
                    assessment: {
                        inferredGender: 'female' as const,
                        confidence: 'medium' as const,
                        ownerConsistency: 'same_person' as const,
                        evidenceSelectionIds: [selectionId],
                    },
                    routingDecision: 'route_to_feature_analysis' as const,
                    routingReason: 'conserve_female_recall' as const,
                    analyzedSelectionIds: [selectionId],
                },
                bio: 'synthetic profile evidence',
                media: [{ selectionId, kind: 'profile' as const, normalizedJpegBase64: '/9j/2Q==' }],
                captions: [],
            },
            featureOperationKey: `feature-analysis:${String(index).repeat(64)}`,
            featureResult: {
                features: {
                    gender: 'female' as const,
                    genderConfidence: 'high' as const,
                    ownerConsistency: 'same_person' as const,
                    appearanceGrade: 3 as const,
                    exposureScore: 1,
                    businessClassification: 'personal' as const,
                    businessConfidence: 'medium' as const,
                    accountContext: 'personal' as const,
                    marriageEvidence: 'none' as const,
                    partnerEvidence: 'none' as const,
                    partnerExclusionContext: 'none' as const,
                    evidenceSelectionIds: {
                        gender: [selectionId], appearance: [selectionId], exposure: [selectionId],
                        business: [selectionId], accountContext: [selectionId], marriagePartner: [],
                    },
                    oneLineOverview: '프로필과 피드에서 확인된 단서를 중심으로 계정의 분위기를 정리한 충분한 총평입니다.',
                },
                finalGenderDecision: 'verified_female' as const,
                analyzedSelectionIds: [selectionId],
            },
        };
    });
    const [a, b, c] = rows;
    return {
        version: 1,
        expiresAt,
        candidates: [a, b, c],
        preliminary: rows.map((row, index) => ({
            candidateId: row.candidateId,
            username: `eval_${index + 1}`,
            appearanceGrade: 3,
            exposureScore: 1,
            accountContext: 'personal',
            hasWeakPartnerEvidence: false,
            hasStrongPartnerEvidence: false,
            uniqueTargetPostsLikedByCandidate: 0,
            boundedCandidateCommentsOnTarget: 0,
            hasCandidateToTargetTagOrCaptionMention: false,
            hasTargetToCandidateTagOrCaptionMention: false,
            recentFemaleMutualRank: null,
            recentMutualBadgeRank: null,
            preScore: 0,
            verificationShortlistRank: null,
        })),
        observed: [],
        notCollected: [],
        partnerOverrides: [],
        originalHighRiskIds: [],
    };
}

function inMemoryObjects() {
    const data = new Map<string, Buffer>();
    const createRetained = vi.fn<AnalysisV2PrivateRetainedMediaObjectClient['createRetained']>(async input => {
        expect(input.contentSha256).toBe(createHash('sha256').update(input.bytes).digest('hex'));
        const old = data.get(input.objectName);
        if (old) {
            if (!old.equals(input.bytes)) throw new Error('conditional create conflict');
            return { created: false, generation: '1' };
        }
        data.set(input.objectName, Buffer.from(input.bytes));
        return { created: true, generation: '1' };
    });
    const readRetained = vi.fn<AnalysisV2PrivateRetainedMediaObjectClient['readRetained']>(async input => (
        data.get(input.objectName) ?? null
    ));
    return { data, createRetained, readRetained };
}

function setup() {
    const objects = inMemoryObjects();
    let now = startTime;
    const options = { bucketName, slot, key, objects, now: () => now };
    return {
        objects,
        options,
        store: createDevStandardEvalStore(options),
        advance: (time: number) => { now = time; },
    };
}

describe('Dev Standard evaluation storage', () => {
    it('binds one approval atomically without storing its ID as plaintext', async () => {
        const { store, objects } = setup();

        expect(await store.ownsRun(approvalA)).toBe(false);
        expect(await Promise.all([store.bindRun(approvalA), store.bindRun(approvalB)])).toEqual([true, false]);
        expect(await store.bindRun(approvalA)).toBe(true);
        expect(await store.ownsRun(approvalA)).toBe(true);
        expect(await store.ownsRun(approvalB)).toBe(false);
        expect(objects.data.size).toBe(1);
        const [[objectName, bytes]] = [...objects.data];
        expect(objectName).toMatch(/^analysis-v2-dev-eval-control\/[0-9a-f]{64}\/[0-9a-f]{64}\.bin$/);
        expect(objectName).not.toContain(approvalA);
        expect(bytes).toHaveLength(32);
        expect(bytes.includes(approvalA)).toBe(false);
    });

    it('encrypts a single bundle and accepts only its exact canonical retry', async () => {
        const { store, objects } = setup();
        const bundle = sampleBundle();
        await expect(store.seal(bundle)).rejects.toThrow('DEV_STANDARD_EVAL_STORE_UNBOUND');
        await store.bindRun(approvalA);

        expect(await store.load()).toBeNull();
        await Promise.all([store.seal(bundle), store.seal(structuredClone(bundle))]);
        expect(await store.load()).toEqual(bundle);
        await expect(store.seal(sampleBundle(bundle.expiresAt - 1))).rejects.toThrow('DEV_STANDARD_EVAL_STORE_CONFLICT');
        expect(await store.load()).toEqual(bundle);
        expect(objects.data.size).toBe(2);
        for (const bytes of objects.data.values()) {
            expect(bytes.includes('synthetic profile evidence')).toBe(false);
        }
    });

    it('requires a valid sealed bundle and grants one consumption across concurrent readers', async () => {
        const { store, options, objects } = setup();
        await store.bindRun(approvalA);
        expect(await store.claimEvaluation()).toBe(false);
        expect(objects.data.size).toBe(1);
        await store.seal(sampleBundle());

        const claims = await Promise.all([
            store.claimEvaluation(),
            createDevStandardEvalStore(options).claimEvaluation(),
        ]);
        expect(claims.sort()).toEqual([false, true]);
        expect(await store.claimEvaluation()).toBe(false);
        expect(objects.data.size).toBe(3);
        const bundlePath = [...objects.data.keys()].find(name => name.startsWith('analysis-v2-dev-eval/'))!;
        objects.data.delete(bundlePath);
        expect(await store.bindRun(approvalB)).toBe(false);
        expect(await store.claimEvaluation()).toBe(false);
        expect(objects.data.size).toBe(2);
    });

    it('rejects expired, altered, and cross-slot bundles before returning data', async () => {
        const { store, options, objects, advance } = setup();
        await store.bindRun(approvalA);
        await store.seal(sampleBundle());
        const bytes = [...objects.data.values()].find(value => value.length > 32)!;
        const wrongSlotReader = createDevStandardEvalStore({
            ...options,
            slot: 'b'.repeat(32),
            objects: { ...objects, readRetained: async () => bytes },
        });
        await expect(wrongSlotReader.load()).rejects.toThrow('DEV_STANDARD_EVAL_STORE_INVALID');

        bytes[bytes.length - 1] ^= 1;
        await expect(store.load()).rejects.toThrow('DEV_STANDARD_EVAL_STORE_INVALID');
        bytes[bytes.length - 1] ^= 1;
        advance(startTime + retentionMs);
        await expect(store.load()).rejects.toThrow('DEV_STANDARD_EVAL_STORE_EXPIRED');
        await expect(store.claimEvaluation()).rejects.toThrow('DEV_STANDARD_EVAL_STORE_EXPIRED');
    });

    it('fails closed on malformed configuration and object responses', async () => {
        const { options, store, objects } = setup();
        const nonCanonicalKey = `${key.slice(0, -2)}h=`;
        for (const override of [{ key: nonCanonicalKey }, { key: ` ${key}` }, { slot: 'A'.repeat(32) }, { slot: `${slot}\n` }, { bucketName: 'ordinary-media' }]) {
            expect(() => createDevStandardEvalStore({ ...options, ...override })).toThrow('DEV_STANDARD_EVAL_STORE_CONFIG');
        }
        await expect(store.bindRun('not-an-approval')).rejects.toThrow('DEV_STANDARD_EVAL_STORE_INVALID');
        await expect(store.bindRun(`${approvalA}\n`)).rejects.toThrow('DEV_STANDARD_EVAL_STORE_INVALID');
        objects.readRetained.mockResolvedValueOnce(Buffer.alloc(32 * 1024 * 1024 + 1));
        await expect(store.load()).rejects.toThrow('DEV_STANDARD_EVAL_STORE_INVALID');
        objects.createRetained.mockResolvedValueOnce({ created: 'yes', generation: '1' } as never);
        await expect(store.bindRun(approvalA)).rejects.toThrow('DEV_STANDARD_EVAL_STORE_INVALID');
    });

    it.each(['analysis-v2-dev-eval', 'analysis-v2-dev-eval-control'])('allows the exact %s namespace on the Dev retained GCS adapter only', async prefix => {
        const objectName = `${prefix}/${'a'.repeat(64)}/${'b'.repeat(64)}.bin`;
        const bytes = Buffer.alloc(32, 8);
        const metadata = { name: objectName, contentType: 'application/octet-stream', size: '32', generation: '1' };
        const request = vi.fn(async ({ responseType }: { responseType: string }) => ({
            data: responseType === 'arraybuffer' ? bytes : metadata,
        }));
        const client = createGoogleCloudPrivateMediaObjectClient({
            bucketName,
            requester: { request } as GoogleCloudStorageAuthorizedRequester,
        });

        await expect(client.createRetained({
            objectName, bytes, contentSha256: createHash('sha256').update(bytes).digest('hex'),
            contentType: 'application/octet-stream',
        })).resolves.toEqual({ created: true, generation: '1' });
        await expect(client.readRetained({ objectName, maximumBytes: 32 })).resolves.toEqual(bytes);
        await expect(client.readRetained({ objectName: objectName.replace('dev-eval', 'dev-evaluation'), maximumBytes: 32 }))
            .rejects.toThrow('VALIDATION_ERROR');
        await expect(client.readRetained({ objectName: `${objectName}\n`, maximumBytes: 32 })).rejects.toThrow('VALIDATION_ERROR');
        const productionClient = createGoogleCloudPrivateMediaObjectClient({
            bucketName: 'ordinary-artifacts',
            requester: { request } as GoogleCloudStorageAuthorizedRequester,
        });
        await expect(productionClient.readRetained({ objectName, maximumBytes: 32 })).rejects.toThrow('VALIDATION_ERROR');
    });
});
