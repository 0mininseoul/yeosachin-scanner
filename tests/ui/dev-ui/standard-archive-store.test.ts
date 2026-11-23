import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
    createGoogleCloudPrivateMediaObjectClient,
    type AnalysisV2DevArchiveObjectClient,
    type AnalysisV2PrivateRetainedMediaObjectClient,
    type GoogleCloudStorageAuthorizedRequester,
} from '@/lib/services/analysis/v2-media-artifact-store';
import {
    createDevStandardArchiveStore,
    DEV_STANDARD_ARCHIVE_MAX_RETENTION_MS,
} from '@/lib/services/dev-ui/standard-archive-store';

const bucketName = 'synthetic-project-dev-live-media';
const slot = 'a'.repeat(32);
const key = Buffer.alloc(32, 8).toString('base64');
const startTime = 1_800_000_000_000;
const binding = {
    grantId: '10000000-0000-4000-8000-000000000001',
    target: 'synthetic_target',
    expiresAt: startTime + DEV_STANDARD_ARCHIVE_MAX_RETENTION_MS,
};
const identity = { kind: 'reverse-likes', inputKey: 'b'.repeat(64) };
const payload = {
    coverage: ['verified_absent', 'not_collected'],
    posts: ['synthetic_post_a', 'synthetic_post_b'],
};

function setup() {
    const objectsByName = new Map<string, Buffer>();
    const createRetained = vi.fn<AnalysisV2PrivateRetainedMediaObjectClient['createRetained']>(
        async ({ objectName, contentSha256, bytes }) => {
            expect(contentSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
            const existing = objectsByName.get(objectName);
            if (existing) {
                if (!existing.equals(bytes)) throw new Error('conditional write conflict');
                return { created: false, generation: '1' };
            }
            objectsByName.set(objectName, Buffer.from(bytes));
            return { created: true, generation: '1' };
        },
    );
    const readRetained = vi.fn<AnalysisV2PrivateRetainedMediaObjectClient['readRetained']>(
        async ({ objectName }) => objectsByName.get(objectName) ?? null,
    );
    const listRetained = vi.fn<AnalysisV2DevArchiveObjectClient['listRetained']>(
        async ({ prefix }) => [...objectsByName.keys()].filter(name => name.startsWith(prefix)),
    );
    let now = startTime;
    const options = {
        bucketName,
        slot,
        key,
        objects: { createRetained, readRetained, listRetained },
        now: () => now,
    };
    return {
        objectsByName,
        createRetained,
        options,
        store: createDevStandardArchiveStore(options),
        advanceTo: (time: number) => { now = time; },
    };
}

describe('Dev Standard private archive store', () => {
    it('encrypts opaque fragments and distinguishes a missing input from a recorded null', async () => {
        const { store, objectsByName, createRetained } = setup();
        expect(await store.readBinding()).toBeNull();
        expect(await store.readSeal()).toBeNull();
        await expect(store.readFragment(identity)).rejects.toThrow('DEV_STANDARD_ARCHIVE_STORE_UNBOUND');
        await expect(store.bindCapture(binding)).resolves.toEqual(binding);
        expect(await store.readFragment(identity)).toBeNull();

        await store.writeFragment({ ...identity, value: payload });
        await store.writeFragment({
            ...identity,
            value: { posts: payload.posts, coverage: payload.coverage },
        });
        expect(createRetained).toHaveBeenCalledTimes(2);
        expect(await store.readFragment(identity)).toEqual({ value: payload });

        const absent = { ...identity, inputKey: 'c'.repeat(64) };
        await store.writeFragment({ ...absent, value: null });
        expect(await store.readFragment(absent)).toEqual({ value: null });
        for (const [name, bytes] of objectsByName) {
            expect(name).toMatch(/^analysis-v2-dev-standard-archive\/[0-9a-f]{64}\/(?:fragment\/[a-z][a-z0-9_-]{0,63}\/)?[0-9a-f]{64}\.bin$/);
            expect(name).not.toContain(slot);
            expect(bytes.includes(binding.target)).toBe(false);
            expect(bytes.includes(binding.grantId)).toBe(false);
            expect(bytes.includes(payload.posts[0]!)).toBe(false);
        }
    });

    it('binds a slot once and recognizes an identical retry after a lost write response', async () => {
        const { store, createRetained, objectsByName } = setup();
        createRetained.mockImplementationOnce(async input => {
            objectsByName.set(input.objectName, Buffer.from(input.bytes));
            throw new Error('response timeout');
        });
        await expect(store.bindCapture(binding)).resolves.toEqual(binding);
        await expect(store.bindCapture(binding)).resolves.toEqual(binding);
        expect(createRetained).toHaveBeenCalledTimes(1);
        await expect(store.bindCapture({
            ...binding,
            grantId: '10000000-0000-4000-8000-000000000002',
        })).rejects.toThrow('DEV_STANDARD_ARCHIVE_STORE_CONFLICT');
        await expect(store.bindCapture({
            ...binding,
            target: 'another_target',
        })).rejects.toThrow('DEV_STANDARD_ARCHIVE_STORE_CONFLICT');
    });

    it('recognizes identical concurrent fragments and rejects incompatible writes', async () => {
        const { store } = setup();
        await store.bindCapture(binding);
        await expect(Promise.all([
            store.writeFragment({ ...identity, value: payload }),
            store.writeFragment({ ...identity, value: { ...payload } }),
        ])).resolves.toEqual([undefined, undefined]);
        await expect(store.writeFragment({
            ...identity,
            value: { ...payload, coverage: ['not_collected', 'not_collected'] },
        })).rejects.toThrow('DEV_STANDARD_ARCHIVE_STORE_CONFLICT');
        expect(await store.readFragment(identity)).toEqual({ value: payload });

        const second = { ...identity, inputKey: 'c'.repeat(64) };
        const contenders = await Promise.allSettled([
            store.writeFragment({ ...second, value: true }),
            store.writeFragment({ ...second, value: false }),
        ]);
        expect(contenders.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
        expect(contenders.find(result => result.status === 'rejected')?.reason)
            .toEqual(new Error('DEV_STANDARD_ARCHIVE_STORE_CONFLICT'));
    });

    it('rejects substitution between input keys, fragment categories, and encryption keys', async () => {
        const { store, objectsByName, createRetained, options } = setup();
        await store.bindCapture(binding);
        await store.writeFragment({ ...identity, value: payload });
        const bytes = createRetained.mock.lastCall![0].bytes;

        const otherInput = { ...identity, inputKey: 'd'.repeat(64) };
        await store.writeFragment({ ...otherInput, value: payload });
        const otherInputName = createRetained.mock.lastCall![0].objectName;
        objectsByName.set(otherInputName, Buffer.from(bytes));
        await expect(store.readFragment(otherInput)).rejects.toThrow('DEV_STANDARD_ARCHIVE_STORE_INVALID');

        const otherCategory = { ...identity, kind: 'target-likes' };
        await store.writeFragment({ ...otherCategory, value: payload });
        const otherCategoryName = createRetained.mock.lastCall![0].objectName;
        objectsByName.set(otherCategoryName, Buffer.from(bytes));
        await expect(store.readFragment(otherCategory)).rejects.toThrow('DEV_STANDARD_ARCHIVE_STORE_INVALID');

        const wrongKey = createDevStandardArchiveStore({ ...options, key: Buffer.alloc(32, 9).toString('base64') });
        await expect(wrongKey.readBinding()).rejects.toThrow('DEV_STANDARD_ARCHIVE_STORE_INVALID');
    });

    it('authenticates the seal for the binding and closes the archive to new fragments', async () => {
        const { store, objectsByName, createRetained } = setup();
        await expect(store.seal()).rejects.toThrow('DEV_STANDARD_ARCHIVE_STORE_UNBOUND');
        await store.bindCapture(binding);
        const bindingName = createRetained.mock.lastCall![0].objectName;
        await store.writeFragment({ ...identity, value: payload });
        await expect(store.seal()).resolves.toEqual(binding);
        await expect(store.seal()).resolves.toEqual(binding);
        expect(await store.readSeal()).toEqual(binding);
        await expect(store.writeFragment({ ...identity, value: payload })).resolves.toBeUndefined();
        await expect(store.writeFragment({ ...identity, inputKey: 'e'.repeat(64), value: payload }))
            .rejects.toThrow('DEV_STANDARD_ARCHIVE_STORE_SEALED');
        objectsByName.delete(bindingName);
        await expect(store.readSeal()).rejects.toThrow('DEV_STANDARD_ARCHIVE_STORE_UNBOUND');
    });

    it('detects a missing or corrupted manifested image during verification and replay', async () => {
        const { store, objectsByName, createRetained } = setup();
        await store.bindCapture(binding);
        const image = { kind: 'result-image-v1', inputKey: 'f'.repeat(64) };
        await store.writeFragment({ ...identity, value: payload });
        await store.writeFragment({ ...image, value: { media: 'synthetic_bytes' } });
        const { objectName, bytes } = createRetained.mock.lastCall![0];
        await store.seal();
        await expect(store.verifySealedMembership()).resolves.toEqual(binding);
        const replay = (await store.openSealedArchive())!;
        await expect(replay.readFragment(image)).resolves.toEqual({ value: { media: 'synthetic_bytes' } });

        objectsByName.delete(objectName);
        await expect(store.verifySealedMembership()).rejects.toThrow('DEV_STANDARD_ARCHIVE_STORE_INVALID');
        await expect(replay.readFragment(image)).rejects.toThrow('DEV_STANDARD_ARCHIVE_STORE_INVALID');

        const corrupt = Buffer.from(bytes);
        corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
        objectsByName.set(objectName, corrupt);
        await expect(store.verifySealedMembership()).rejects.toThrow('DEV_STANDARD_ARCHIVE_STORE_INVALID');
        await expect(replay.readFragment(image)).rejects.toThrow('DEV_STANDARD_ARCHIVE_STORE_INVALID');
    });

    it('excludes late objects from replay and rejects substituted authenticated ciphertext', async () => {
        const { store, objectsByName } = setup();
        await store.bindCapture(binding);
        await store.writeFragment({ ...identity, value: payload });
        await store.seal();

        const other = setup();
        const late = { ...identity, inputKey: 'e'.repeat(64) };
        await other.store.bindCapture(binding);
        await other.store.writeFragment({ ...late, value: payload });
        const lateObject = other.createRetained.mock.lastCall![0];
        objectsByName.set(lateObject.objectName, Buffer.from(lateObject.bytes));
        const replay = (await store.openSealedArchive())!;
        await expect(replay.readFragment(late)).resolves.toBeNull();
        await expect(replay.readFragment(identity)).resolves.toEqual({ value: payload });
        await expect(store.seal()).resolves.toEqual(binding);

        await other.store.writeFragment({ ...identity, value: payload });
        const substituted = other.createRetained.mock.lastCall![0];
        objectsByName.set(substituted.objectName, Buffer.from(substituted.bytes));
        await expect(store.verifySealedMembership()).rejects.toThrow('DEV_STANDARD_ARCHIVE_STORE_INVALID');
        await expect(replay.readFragment(identity)).rejects.toThrow('DEV_STANDARD_ARCHIVE_STORE_INVALID');
    });

    it('rejects expired objects, excessive retention, and non-JSON payloads', async () => {
        const { store, advanceTo } = setup();
        await expect(store.bindCapture({
            ...binding,
            expiresAt: binding.expiresAt + 1,
        })).rejects.toThrow('DEV_STANDARD_ARCHIVE_STORE_INVALID');
        await store.bindCapture(binding);
        await expect(store.writeFragment({ ...identity, value: { datum: undefined } }))
            .rejects.toThrow('DEV_STANDARD_ARCHIVE_STORE_INVALID');
        await expect(store.writeFragment({ ...identity, value: new Date() }))
            .rejects.toThrow('DEV_STANDARD_ARCHIVE_STORE_INVALID');
        await store.writeFragment({ ...identity, value: payload });
        await store.seal();
        const replay = (await store.openSealedArchive())!;
        advanceTo(binding.expiresAt);
        await expect(store.readSeal()).rejects.toThrow('DEV_STANDARD_ARCHIVE_STORE_EXPIRED');
        await expect(store.readFragment(identity)).rejects.toThrow('DEV_STANDARD_ARCHIVE_STORE_EXPIRED');
        await expect(replay.readFragment(identity)).rejects.toThrow('DEV_STANDARD_ARCHIVE_STORE_EXPIRED');
        await expect(store.bindCapture({
            ...binding,
            expiresAt: binding.expiresAt + 1000,
        })).rejects.toThrow('DEV_STANDARD_ARCHIVE_STORE_CONFLICT');
    });

    it('limits the GCS prefix to a Dev media bucket before making any request', async () => {
        const request = vi.fn(async (): Promise<never> => { throw { response: { status: 404 } }; });
        const objectName = `analysis-v2-dev-standard-archive/${'a'.repeat(64)}/${'b'.repeat(64)}.bin`;
        const devObjects = createGoogleCloudPrivateMediaObjectClient({ bucketName, requester: { request } });
        await expect(devObjects.readRetained({ objectName, maximumBytes: 1024 })).resolves.toBeNull();
        expect(request).toHaveBeenCalledTimes(1);
        request.mockClear();
        const productionObjects = createGoogleCloudPrivateMediaObjectClient({
            bucketName: 'synthetic-production-media',
            requester: { request },
        });
        await expect(productionObjects.readRetained({ objectName, maximumBytes: 1024 }))
            .rejects.toThrow('ANALYSIS_V2_SOURCE_MEDIA_ARCHIVE_VALIDATION_ERROR');
        const prefix = `analysis-v2-dev-standard-archive/${'a'.repeat(64)}/fragment/`;
        await expect(productionObjects.listRetained({ prefix, maximumCount: 1 }))
            .rejects.toThrow('ANALYSIS_V2_SOURCE_MEDIA_ARCHIVE_VALIDATION_ERROR');
        await expect(devObjects.listRetained({ prefix: 'analysis-v2-retained/', maximumCount: 1 }))
            .rejects.toThrow('ANALYSIS_V2_SOURCE_MEDIA_ARCHIVE_VALIDATION_ERROR');
        expect(request).not.toHaveBeenCalled();
    });

    it('paginates one slot and rejects out-of-scope names and count overflow', async () => {
        const prefix = `analysis-v2-dev-standard-archive/${'a'.repeat(64)}/fragment/`;
        const first = `${prefix}media-v1/${'b'.repeat(64)}.bin`;
        const second = `${prefix}media-v1/${'c'.repeat(64)}.bin`;
        const request = vi.fn<(options: Parameters<GoogleCloudStorageAuthorizedRequester['request']>[0]) => Promise<unknown>>();
        const client = createGoogleCloudPrivateMediaObjectClient({
            bucketName,
            requester: {
                async request<T>(options: Parameters<GoogleCloudStorageAuthorizedRequester['request']>[0]) {
                    return { data: await request(options) as T };
                },
            },
        });
        request.mockResolvedValueOnce({ items: [{ name: first }], nextPageToken: 'synthetic_page' });
        request.mockResolvedValueOnce({ items: [{ name: second }] });
        await expect(client.listRetained({ prefix, maximumCount: 2 })).resolves.toEqual([first, second]);
        expect(request).toHaveBeenNthCalledWith(2, expect.objectContaining({
            params: expect.objectContaining({ prefix, pageToken: 'synthetic_page' }),
        }));
        request.mockResolvedValueOnce({ items: [{ name: first }, { name: second }] });
        await expect(client.listRetained({ prefix, maximumCount: 1 }))
            .rejects.toThrow('ANALYSIS_V2_SOURCE_MEDIA_ARCHIVE_OBJECT_ERROR');
        request.mockResolvedValueOnce({ items: [{ name: second.replace('/fragment/', '/outside/') }] });
        await expect(client.listRetained({ prefix, maximumCount: 1 }))
            .rejects.toThrow('ANALYSIS_V2_SOURCE_MEDIA_ARCHIVE_OBJECT_ERROR');
    });
});
