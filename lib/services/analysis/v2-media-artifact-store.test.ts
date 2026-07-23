import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
    MAX_FEATURE_MEDIA,
    MAX_PARTNER_SAFETY_CONTACT_MEDIA,
} from '@/lib/domain/analysis/media-policy';
import {
    ANALYSIS_V2_MEDIA_ARTIFACT_DATABASE_NAMES,
    ANALYSIS_V2_MEDIA_BUNDLE_MAX_ITEMS,
    analysisV2MediaArtifactKey,
    analysisV2MediaArtifactObjectName,
    analysisV2MediaBundleArtifactKey,
    cleanupConfiguredAnalysisV2TerminalMedia,
    createAnalysisV2MediaArtifactRegistry,
    createAnalysisV2MediaArtifactStore,
    createGoogleCloudPrivateMediaObjectClient,
    deserializeAnalysisV2MediaBundle,
    getAnalysisV2MediaArtifactBucket,
    serializeAnalysisV2MediaBundle,
    type AnalysisV2MediaArtifactCleanupRef,
    type AnalysisV2MediaArtifactRef,
    type AnalysisV2MediaArtifactRegistry,
    type AnalysisV2PrivateMediaObjectClient,
    type GoogleCloudStorageAuthorizedRequester,
} from './v2-media-artifact-store';

const requestId = '11111111-1111-4111-8111-111111111111';
const claimToken = '22222222-2222-4222-8222-222222222222';
const jobKey = 'profile-ai:0';
const jpeg = Buffer.from([0xff, 0xd8, 0x10, 0x20, 0xff, 0xd9]);
const jpeg2 = Buffer.from([0xff, 0xd8, 0x30, 0x40, 0xff, 0xd9]);

function contentHash(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
}

function reference(overrides: Partial<AnalysisV2MediaArtifactRef> = {}):
AnalysisV2MediaArtifactRef {
    const artifactKind = overrides.artifactKind ?? 'jpeg';
    const artifactKey = overrides.artifactKey ?? analysisV2MediaArtifactKey('profile:1');
    const contentSha256 = overrides.contentSha256
        ?? '8d9efcb4f465533a7c1db9175f51c25d814cc97c8a1f76b9969539e2a1833cae';
    return {
        requestId,
        artifactKey,
        artifactKind,
        contentSha256,
        contentType: overrides.contentType ?? (
            artifactKind === 'jpeg' ? 'image/jpeg' : 'application/octet-stream'
        ),
        objectName: analysisV2MediaArtifactObjectName({
            requestId,
            artifactKey,
            contentSha256,
            artifactKind,
        }),
        objectGeneration: '1234567890123456',
        byteSize: jpeg.length,
        ...overrides,
    };
}

function registry(overrides: Partial<AnalysisV2MediaArtifactRegistry> = {}):
AnalysisV2MediaArtifactRegistry {
    return {
        register: vi.fn(async input => reference({
            requestId: input.requestId,
            artifactKey: input.artifactKey,
            contentSha256: input.contentSha256,
            objectName: input.objectName,
            objectGeneration: input.objectGeneration,
            byteSize: input.byteSize,
        })),
        load: vi.fn(async () => null),
        claimCleanup: vi.fn(async () => []),
        completeCleanup: vi.fn(async () => true),
        ...overrides,
    };
}

function objects(overrides: Partial<AnalysisV2PrivateMediaObjectClient> = {}):
AnalysisV2PrivateMediaObjectClient {
    return {
        create: vi.fn(async () => ({ created: true, generation: '1234567890123456' })),
        read: vi.fn(async () => jpeg),
        delete: vi.fn(async () => undefined),
        ...overrides,
    };
}

describe('analysis V2 media artifact identities', () => {
    it('uses PII-free deterministic hashes and object paths', () => {
        const key = analysisV2MediaArtifactKey('post:opaque:media:0');
        const name = analysisV2MediaArtifactObjectName({
            requestId: requestId.toUpperCase(),
            artifactKey: key,
            contentSha256: 'a'.repeat(64),
        });

        expect(key).toMatch(/^[a-f0-9]{64}$/);
        expect(name).toBe(`analysis-v2/${requestId}/${key}/${'a'.repeat(64)}.jpg`);
        expect(name).not.toContain('username');
        expect(() => analysisV2MediaArtifactKey(' ')).toThrow('invalid selection id');
    });

    it('validates private artifact bucket configuration without exposing a default', () => {
        expect(getAnalysisV2MediaArtifactBucket({})).toBeNull();
        expect(getAnalysisV2MediaArtifactBucket({
            ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET: 'private-ai-artifacts-1',
        })).toBe('private-ai-artifacts-1');
        expect(() => getAnalysisV2MediaArtifactBucket({
            ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET: '../public',
        })).toThrow('invalid bucket');
    });
});

describe('analysis V2 normalized media bundles', () => {
    it('round-trips an ordered set without storing raw selection ids in the bundle header', () => {
        const selectionIds = ['profile:private-source', 'post:opaque:1'];
        const bundle = serializeAnalysisV2MediaBundle([
            { selectionId: selectionIds[0], normalizedJpeg: jpeg },
            { selectionId: selectionIds[1], normalizedJpeg: jpeg2 },
        ]);
        const loaded = deserializeAnalysisV2MediaBundle(bundle, selectionIds);

        expect(loaded).toEqual([
            { selectionId: selectionIds[0], normalizedJpeg: jpeg },
            { selectionId: selectionIds[1], normalizedJpeg: jpeg2 },
        ]);
        expect(bundle.toString('utf8')).not.toContain('private-source');
        expect(analysisV2MediaBundleArtifactKey('candidate:private')).toMatch(/^[a-f0-9]{64}$/);
    });

    it('rejects tampering and selection-order drift', () => {
        const bundle = serializeAnalysisV2MediaBundle([
            { selectionId: 'profile:1', normalizedJpeg: jpeg },
            { selectionId: 'post:1', normalizedJpeg: jpeg2 },
        ]);
        const tampered = Buffer.from(bundle);
        tampered[tampered.length - 3] ^= 0xff;

        expect(() => deserializeAnalysisV2MediaBundle(tampered, ['profile:1', 'post:1']))
            .toThrow('bundle content mismatch');
        expect(() => deserializeAnalysisV2MediaBundle(bundle, ['post:1', 'profile:1']))
            .toThrow('bundle selection mismatch');
    });

    it('supports the full partner-safety contact selection and rejects one item beyond it', () => {
        const selectionIds = Array.from(
            { length: MAX_PARTNER_SAFETY_CONTACT_MEDIA },
            (_, index) => `post:${index}`
        );
        const bundle = serializeAnalysisV2MediaBundle(selectionIds.map(selectionId => ({
            selectionId,
            normalizedJpeg: jpeg,
        })));

        expect(ANALYSIS_V2_MEDIA_BUNDLE_MAX_ITEMS).toBeGreaterThanOrEqual(MAX_FEATURE_MEDIA);
        expect(ANALYSIS_V2_MEDIA_BUNDLE_MAX_ITEMS)
            .toBeGreaterThanOrEqual(MAX_PARTNER_SAFETY_CONTACT_MEDIA);
        expect(deserializeAnalysisV2MediaBundle(bundle, selectionIds)).toHaveLength(
            MAX_PARTNER_SAFETY_CONTACT_MEDIA
        );
        expect(() => serializeAnalysisV2MediaBundle(Array.from({
            length: ANALYSIS_V2_MEDIA_BUNDLE_MAX_ITEMS + 1,
        }, (_, index) => ({
            selectionId: `post:${index}`,
            normalizedJpeg: jpeg,
        })))).toThrow('invalid bundle size');
    });

    it('rejects the aggregate-byte limit before constructing an oversized bundle', () => {
        const largeJpeg = Buffer.alloc(3 * 1024 * 1024, 0x11);
        largeJpeg[0] = 0xff;
        largeJpeg[1] = 0xd8;
        largeJpeg[largeJpeg.length - 2] = 0xff;
        largeJpeg[largeJpeg.length - 1] = 0xd9;
        expect(() => serializeAnalysisV2MediaBundle(Array.from({ length: 11 }, (_, index) => ({
            selectionId: `post:${index}`,
            normalizedJpeg: largeJpeg,
        })))).toThrow('media bundle too large');
    });
});

describe('analysis V2 media artifact registry', () => {
    it('uses only RPCs and verifies the exact registered response', async () => {
        const expected = reference();
        const rpc = vi.fn(async (name: string) => ({
            data: name === ANALYSIS_V2_MEDIA_ARTIFACT_DATABASE_NAMES.registerRpc
                ? expected
                : null,
            error: null,
        }));
        const store = createAnalysisV2MediaArtifactRegistry({ rpc });

        await expect(store.register({
            ...expected,
            jobKey,
            claimToken,
        })).resolves.toEqual(expected);
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_MEDIA_ARTIFACT_DATABASE_NAMES.registerRpc,
            expect.objectContaining({
                p_request_id: requestId,
                p_job_key: jobKey,
                p_claim_token: claimToken,
                p_object_generation: expected.objectGeneration,
            })
        );
    });

    it('rejects malformed or over-broad cleanup responses', async () => {
        const store = createAnalysisV2MediaArtifactRegistry({
            rpc: vi.fn(async () => ({ data: [reference()], error: null })),
        });
        await expect(store.claimCleanup(1)).rejects.toThrow('invalid cleanup token');
        await expect(store.claimCleanup(501)).rejects.toThrow('invalid cleanup limit');
    });

    it('rejects a load response for a different artifact identity', async () => {
        const requestedKey = analysisV2MediaArtifactKey('profile:1');
        const driftedKey = analysisV2MediaArtifactKey('profile:2');
        const drifted = reference({ artifactKey: driftedKey });
        drifted.objectName = analysisV2MediaArtifactObjectName(drifted);
        const store = createAnalysisV2MediaArtifactRegistry({
            rpc: vi.fn(async () => ({ data: drifted, error: null })),
        });

        await expect(store.load({ requestId, jobKey, claimToken, artifactKey: requestedKey }))
            .rejects.toThrow('load drift');
    });
});

describe('analysis V2 media artifact orchestration', () => {
    it('persists immutable JPEG bytes before registering the exact generation', async () => {
        const objectClient = objects();
        const registryClient = registry();
        const store = createAnalysisV2MediaArtifactStore({
            objects: objectClient,
            registry: registryClient,
        });

        const result = await store.persist({
            requestId,
            jobKey,
            claimToken,
            selectionId: 'profile:1',
            normalizedJpeg: jpeg,
        });

        expect(result.contentSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(objectClient.create).toHaveBeenCalledWith(expect.objectContaining({
            bytes: jpeg,
            artifactKey: result.artifactKey,
            contentSha256: result.contentSha256,
        }));
        expect(registryClient.register).toHaveBeenCalledWith(expect.objectContaining({
            requestId,
            jobKey,
            claimToken,
            objectGeneration: '1234567890123456',
        }));
    });

    it('deletes a newly-created object when a stale lease blocks registration', async () => {
        const objectClient = objects();
        const store = createAnalysisV2MediaArtifactStore({
            objects: objectClient,
            registry: registry({
                register: vi.fn(async () => {
                    throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_FENCE_MISMATCH');
                }),
            }),
        });

        await expect(store.persist({
            requestId,
            jobKey,
            claimToken,
            selectionId: 'profile:1',
            normalizedJpeg: jpeg,
        })).rejects.toThrow('FENCE_MISMATCH');
        expect(objectClient.delete).toHaveBeenCalledTimes(1);
    });

    it('reconciles an ambiguously committed registration before deleting its generation', async () => {
        let committed: AnalysisV2MediaArtifactRef | null = null;
        const objectClient = objects();
        const store = createAnalysisV2MediaArtifactStore({
            objects: objectClient,
            registry: registry({
                register: vi.fn(async input => {
                    committed = input;
                    throw new Error('network response lost');
                }),
                load: vi.fn(async () => committed),
            }),
        });

        const persisted = await store.persist({
            requestId,
            jobKey,
            claimToken,
            selectionId: 'profile:1',
            normalizedJpeg: jpeg,
        });
        expect(persisted).toEqual(committed);
        expect(objectClient.delete).not.toHaveBeenCalled();
    });

    it('leaves an ambiguous generation to lifecycle cleanup when reconciliation is unavailable', async () => {
        const objectClient = objects();
        const store = createAnalysisV2MediaArtifactStore({
            objects: objectClient,
            registry: registry({
                register: vi.fn(async () => {
                    throw new Error('network response lost');
                }),
                load: vi.fn(async () => {
                    throw new Error('registry unavailable');
                }),
            }),
        });

        await expect(store.persist({
            requestId,
            jobKey,
            claimToken,
            selectionId: 'profile:1',
            normalizedJpeg: jpeg,
        })).rejects.toThrow('network response lost');
        expect(objectClient.delete).not.toHaveBeenCalled();
    });

    it('loads by stable selection id and verifies bytes against the registry hash', async () => {
        const artifactKey = analysisV2MediaArtifactKey('profile:1');
        const validReference = reference({
            artifactKey,
            contentSha256: 'f'.repeat(64),
        });
        validReference.objectName = analysisV2MediaArtifactObjectName(validReference);
        const store = createAnalysisV2MediaArtifactStore({
            objects: objects(),
            registry: registry({ load: vi.fn(async () => validReference) }),
        });

        await expect(store.load({
            requestId,
            jobKey,
            claimToken,
            selectionId: 'profile:1',
        })).rejects.toThrow('content mismatch');
    });

    it('generation-fences bounded terminal cleanup and leaves failures retryable', async () => {
        const first = { ...reference(), cleanupToken: claimToken };
        const second: AnalysisV2MediaArtifactCleanupRef = {
            ...reference({ artifactKey: 'b'.repeat(64) }),
            objectName: analysisV2MediaArtifactObjectName({
                requestId,
                artifactKey: 'b'.repeat(64),
                contentSha256: reference().contentSha256,
            }),
            cleanupToken: '33333333-3333-4333-8333-333333333333',
        };
        const registryClient = registry({
            claimCleanup: vi.fn(async () => [first, second]),
        });
        const objectClient = objects({
            delete: vi.fn(async artifact => {
                if (artifact.objectName === second.objectName) throw new Error('temporary');
            }),
        });
        const store = createAnalysisV2MediaArtifactStore({
            objects: objectClient,
            registry: registryClient,
        });

        await expect(store.cleanupTerminal()).resolves.toEqual({
            claimed: 2,
            deleted: 1,
            failed: 1,
        });
        expect(registryClient.completeCleanup).toHaveBeenCalledTimes(1);
        expect(registryClient.completeCleanup).toHaveBeenCalledWith(first);
    });

    it.each([101, 300, 900])(
        'drains all %i terminal artifacts across bounded cleanup batches',
        async artifactCount => {
            const pending: AnalysisV2MediaArtifactCleanupRef[] = Array.from(
                { length: artifactCount },
                (_, index) => {
                    const artifactKey = index.toString(16).padStart(64, '0');
                    const base = reference({ artifactKey });
                    return {
                        ...base,
                        objectName: analysisV2MediaArtifactObjectName(base),
                        cleanupToken: claimToken,
                    };
                }
            );
            const claimCleanup = vi.fn(async (limit = 100) => pending.splice(0, limit));
            const registryClient = registry({ claimCleanup });
            const objectClient = objects();
            const store = createAnalysisV2MediaArtifactStore({
                objects: objectClient,
                registry: registryClient,
            });

            await expect(store.cleanupTerminal()).resolves.toEqual({
                claimed: artifactCount,
                deleted: artifactCount,
                failed: 0,
            });
            expect(objectClient.delete).toHaveBeenCalledTimes(artifactCount);
            expect(registryClient.completeCleanup).toHaveBeenCalledTimes(artifactCount);
            expect(claimCleanup).toHaveBeenCalledTimes(artifactCount > 500 ? 2 : 1);
        }
    );

    it('bounds the number of cleanup batches accepted by a worker invocation', async () => {
        const store = createAnalysisV2MediaArtifactStore({
            objects: objects(),
            registry: registry(),
        });

        await expect(store.cleanupTerminal({ maxBatches: 11 }))
            .rejects.toThrow('invalid cleanup batch count');
    });

    it('turns partial deletion into a recovery-visible failure signal', async () => {
        const partialStore = {
            cleanupTerminal: vi.fn(async () => ({ claimed: 2, deleted: 1, failed: 1 })),
        } as unknown as ReturnType<typeof createAnalysisV2MediaArtifactStore>;

        await expect(cleanupConfiguredAnalysisV2TerminalMedia({ store: partialStore }))
            .rejects.toThrow('ANALYSIS_V2_MEDIA_ARTIFACT_CLEANUP_INCOMPLETE');
    });

    it('stores and reloads all normalized feature media through one bundle object', async () => {
        let storedBytes: Buffer | null = null;
        let storedReference: AnalysisV2MediaArtifactRef | null = null;
        const objectClient = objects({
            create: vi.fn(async input => {
                storedBytes = input.bytes;
                return { created: true, generation: '1234567890123456' };
            }),
            read: vi.fn(async () => storedBytes ?? Buffer.alloc(0)),
        });
        const registryClient = registry({
            register: vi.fn(async input => {
                storedReference = input;
                return input;
            }),
            load: vi.fn(async () => storedReference),
        });
        const store = createAnalysisV2MediaArtifactStore({
            objects: objectClient,
            registry: registryClient,
        });

        const persisted = await store.persistBundle({
            requestId,
            jobKey,
            claimToken,
            bundleId: 'candidate:opaque',
            media: [
                { selectionId: 'profile:1', normalizedJpeg: jpeg },
                { selectionId: 'post:1', normalizedJpeg: jpeg2 },
            ],
        });
        expect(persisted).toMatchObject({
            artifactKind: 'media_bundle',
            contentType: 'application/octet-stream',
        });
        expect(objectClient.create).toHaveBeenCalledTimes(1);

        await expect(store.loadBundle({
            requestId,
            jobKey,
            claimToken,
            bundleId: 'candidate:opaque',
            expectedSelectionIds: ['profile:1', 'post:1'],
        })).resolves.toEqual([
            { selectionId: 'profile:1', normalizedJpeg: jpeg },
            { selectionId: 'post:1', normalizedJpeg: jpeg2 },
        ]);
    });
});

describe('Google Cloud private media object adapter', () => {
    it('creates once with a generation precondition and reads/deletes that generation', async () => {
        const artifactKey = 'a'.repeat(64);
        const contentSha256 = contentHash(jpeg);
        const objectName = analysisV2MediaArtifactObjectName({
            requestId,
            artifactKey,
            contentSha256,
        });
        const metadata = {
            name: objectName,
            generation: '1234567890123456',
            size: String(jpeg.length),
            contentType: 'image/jpeg',
        };
        const request = vi.fn(async (options: { method: string; responseType?: string }) => {
            if (options.method === 'POST') return { data: metadata };
            if (options.method === 'GET' && options.responseType === 'arraybuffer') {
                return { data: jpeg };
            }
            return { data: null };
        });
        const client = createGoogleCloudPrivateMediaObjectClient({
            bucketName: 'private-artifacts-1',
            requester: { request } as GoogleCloudStorageAuthorizedRequester,
        });
        const created = await client.create({
            objectName,
            bytes: jpeg,
            artifactKey,
            artifactKind: 'jpeg',
            contentSha256,
            contentType: 'image/jpeg',
        });

        expect(created).toEqual({ created: true, generation: '1234567890123456' });
        expect(request).toHaveBeenCalledWith(expect.objectContaining({
            url: 'https://storage.googleapis.com/upload/storage/v1/b/private-artifacts-1/o',
            method: 'POST',
            params: expect.objectContaining({
                uploadType: 'media',
                name: objectName,
                ifGenerationMatch: '0',
            }),
            data: jpeg,
        }));

        await expect(client.read({
            objectName,
            objectGeneration: created.generation,
            byteSize: jpeg.length,
        })).resolves.toEqual(jpeg);
        await client.delete({
            objectName,
            objectGeneration: created.generation,
        });
        expect(request).toHaveBeenCalledWith(expect.objectContaining({
            method: 'DELETE',
            params: {
                generation: created.generation,
                ifGenerationMatch: created.generation,
            },
        }));
    });

    it('reuses a pre-existing generation only after verifying its exact bytes', async () => {
        const artifactKey = 'a'.repeat(64);
        const existingHash = contentHash(jpeg);
        const objectName = analysisV2MediaArtifactObjectName({
            requestId,
            artifactKey,
            contentSha256: existingHash,
        });
        const request = vi.fn(async (options: { method: string; responseType?: string }) => {
            if (options.method === 'POST') {
                throw Object.assign(new Error('precondition'), { code: 412 });
            }
            if (options.responseType === 'arraybuffer') return { data: jpeg };
            return { data: {
                name: objectName,
                generation: '1234567890123456',
                size: String(jpeg.length),
                contentType: 'image/jpeg',
            } };
        });
        const client = createGoogleCloudPrivateMediaObjectClient({
            bucketName: 'private-artifacts-1',
            requester: { request } as GoogleCloudStorageAuthorizedRequester,
        });

        await expect(client.create({
            objectName,
            bytes: jpeg,
            artifactKey,
            artifactKind: 'jpeg',
            contentSha256: existingHash,
            contentType: 'image/jpeg',
        })).resolves.toEqual({ created: false, generation: '1234567890123456' });
        expect(existingHash).toMatch(/^[a-f0-9]{64}$/);
        expect(request).toHaveBeenCalledWith(expect.objectContaining({
            method: 'GET',
            params: { alt: 'media', generation: '1234567890123456' },
            responseType: 'arraybuffer',
        }));
    });

    it('rejects byte-hash or object-path drift before making a storage request', async () => {
        const request = vi.fn();
        const client = createGoogleCloudPrivateMediaObjectClient({
            bucketName: 'private-artifacts-1',
            requester: { request } as GoogleCloudStorageAuthorizedRequester,
        });

        await expect(client.create({
            objectName: analysisV2MediaArtifactObjectName({
                requestId,
                artifactKey: 'a'.repeat(64),
                contentSha256: 'b'.repeat(64),
            }),
            bytes: jpeg,
            artifactKey: 'a'.repeat(64),
            artifactKind: 'jpeg',
            contentSha256: 'b'.repeat(64),
            contentType: 'image/jpeg',
        })).rejects.toThrow('content hash mismatch');

        const actualHash = contentHash(jpeg);
        await expect(client.create({
            objectName: analysisV2MediaArtifactObjectName({
                requestId,
                artifactKey: 'c'.repeat(64),
                contentSha256: actualHash,
            }),
            bytes: jpeg,
            artifactKey: 'a'.repeat(64),
            artifactKind: 'jpeg',
            contentSha256: actualHash,
            contentType: 'image/jpeg',
        })).rejects.toThrow('object name mismatch');
        await expect(client.delete({
            objectName: 'unrelated/object.jpg',
            objectGeneration: '1234567890123456',
        })).rejects.toThrow('object name mismatch');
        expect(request).not.toHaveBeenCalled();
    });

    it('redacts provider errors that could otherwise retain uploaded image bytes', async () => {
        const artifactKey = 'a'.repeat(64);
        const contentSha256 = contentHash(jpeg);
        const objectName = analysisV2MediaArtifactObjectName({
            requestId,
            artifactKey,
            contentSha256,
        });
        const request = vi.fn(async () => {
            throw {
                message: 'secret-provider-detail',
                response: { status: 500 },
                config: { data: jpeg },
            };
        });
        const client = createGoogleCloudPrivateMediaObjectClient({
            bucketName: 'private-artifacts-1',
            requester: { request } as GoogleCloudStorageAuthorizedRequester,
        });

        let caught: unknown;
        try {
            await client.create({
                objectName,
                bytes: jpeg,
                artifactKey,
                artifactKind: 'jpeg',
                contentSha256,
                contentType: 'image/jpeg',
            });
        } catch (error) {
            caught = error;
        }
        expect(caught).toBeInstanceOf(Error);
        if (!(caught instanceof Error)) throw new Error('Expected a sanitized provider error.');
        expect(caught.message).toBe(
            'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR: upload failed (500).'
        );
        expect(caught).not.toHaveProperty('cause');
    });
});
