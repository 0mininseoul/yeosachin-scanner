import { describe, expect, it, vi } from 'vitest';
import {
    conciergeImageProxyCacheEnabled,
    imageProxyCacheKey,
    readImageProxyCacheObject,
    writeImageProxyCacheObject,
} from './image-proxy-cache';

const ENV = {
    ANALYSIS_V2_RESULT_IMAGE_R2_ENDPOINT: 'https://0123456789abcdef.r2.cloudflarestorage.com',
    ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET: 'analysis-v2-result-images',
    ANALYSIS_V2_RESULT_IMAGE_R2_ACCESS_KEY_ID: 'r2-test-access-key',
    ANALYSIS_V2_RESULT_IMAGE_R2_SECRET_ACCESS_KEY: 'r2-test-secret-key',
};

function fakeClient(
    implementation: (command: { constructor: { name: string }; input: Record<string, unknown> }) => unknown,
) {
    return {
        send: vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => (
            implementation(command)
        )),
    };
}

describe('conciergeImageProxyCacheEnabled', () => {
    it('reads the flag with a default-off, explicit-true/1-only shape', () => {
        expect(conciergeImageProxyCacheEnabled(undefined)).toBe(false);
        expect(conciergeImageProxyCacheEnabled('')).toBe(false);
        expect(conciergeImageProxyCacheEnabled('false')).toBe(false);
        expect(conciergeImageProxyCacheEnabled('true')).toBe(true);
        expect(conciergeImageProxyCacheEnabled('1')).toBe(true);
    });
});

describe('imageProxyCacheKey', () => {
    it('is stable across different (expiring) signature query strings for the same image', () => {
        const a = imageProxyCacheKey('https://scontent.cdninstagram.com/v/photo.jpg?oe=aaa&oh=111');
        const b = imageProxyCacheKey('https://scontent.cdninstagram.com/v/photo.jpg?oe=bbb&oh=222');

        expect(a).not.toBeNull();
        expect(a).toBe(b);
    });

    it('differs for a different pathname or origin', () => {
        const base = imageProxyCacheKey('https://scontent.cdninstagram.com/v/photo.jpg?oe=aaa');
        const otherPath = imageProxyCacheKey('https://scontent.cdninstagram.com/v/other.jpg?oe=aaa');
        const otherHost = imageProxyCacheKey('https://scontent2.cdninstagram.com/v/photo.jpg?oe=aaa');

        expect(otherPath).not.toBe(base);
        expect(otherHost).not.toBe(base);
    });

    it('rejects a malformed or non-https URL instead of caching it', () => {
        expect(imageProxyCacheKey('not-a-url')).toBeNull();
        expect(imageProxyCacheKey('http://scontent.cdninstagram.com/v/photo.jpg')).toBeNull();
    });
});

describe('readImageProxyCacheObject', () => {
    it('returns the cached bytes and content type on a hit', async () => {
        const bytes = Buffer.from([1, 2, 3, 4]);
        const client = fakeClient(command => {
            expect(command.constructor.name).toBe('GetObjectCommand');
            expect(command.input).toMatchObject({
                Bucket: ENV.ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET,
                Key: 'image-proxy-cache/v1/cache-key-abc',
            });
            return {
                ContentType: 'image/jpeg',
                Body: { transformToByteArray: async () => Uint8Array.from(bytes) },
            };
        });

        const result = await readImageProxyCacheObject('cache-key-abc', ENV, { client });

        expect(result).toEqual({ bytes, contentType: 'image/jpeg' });
    });

    it('is a miss (null), never a throw, when the object is not found', async () => {
        const client = fakeClient(() => {
            throw new Error('NoSuchKey');
        });

        await expect(readImageProxyCacheObject('missing', ENV, { client })).resolves.toBeNull();
    });

    it('is a miss when R2 is not configured, without throwing', async () => {
        await expect(readImageProxyCacheObject('any', {}, {})).resolves.toBeNull();
    });

    it('is a miss when the response is missing a usable content type or body', async () => {
        const noContentType = fakeClient(() => ({
            Body: { transformToByteArray: async () => Uint8Array.from([1]) },
        }));
        await expect(readImageProxyCacheObject('k', ENV, { client: noContentType })).resolves.toBeNull();

        const noBody = fakeClient(() => ({ ContentType: 'image/jpeg' }));
        await expect(readImageProxyCacheObject('k', ENV, { client: noBody })).resolves.toBeNull();
    });
});

describe('writeImageProxyCacheObject', () => {
    it('writes bytes and content type under the expected key when not already cached', async () => {
        const bytes = Buffer.from([9, 9, 9]);
        const calls: string[] = [];
        const client = fakeClient(command => {
            calls.push(command.constructor.name);
            if (command.constructor.name === 'HeadObjectCommand') {
                throw new Error('NoSuchKey');
            }
            expect(command.input).toEqual({
                Bucket: ENV.ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET,
                Key: 'image-proxy-cache/v1/cache-key-xyz',
                Body: bytes,
                ContentLength: bytes.byteLength,
                ContentType: 'image/png',
                CacheControl: 'private, max-age=86400',
            });
            return {};
        });

        await writeImageProxyCacheObject('cache-key-xyz', bytes, 'image/png', ENV, { client });

        expect(calls).toEqual(['HeadObjectCommand', 'PutObjectCommand']);
    });

    it('skips the write (no PutObjectCommand) when the key already exists', async () => {
        const calls: string[] = [];
        const client = fakeClient(command => {
            calls.push(command.constructor.name);
            return {};
        });

        await writeImageProxyCacheObject('already-cached', Buffer.from([1]), 'image/jpeg', ENV, { client });

        expect(calls).toEqual(['HeadObjectCommand']);
    });

    it('never throws when R2 is not configured or the store operation fails', async () => {
        await expect(writeImageProxyCacheObject('k', Buffer.from([1]), 'image/jpeg', {}, {}))
            .resolves.toBeUndefined();

        const failingClient = fakeClient(() => {
            throw new Error('boom');
        });
        await expect(writeImageProxyCacheObject('k', Buffer.from([1]), 'image/jpeg', ENV, { client: failingClient }))
            .resolves.toBeUndefined();
    });

    it('does not attempt to write an empty payload', async () => {
        const client = fakeClient(() => ({}));

        await writeImageProxyCacheObject('k', Buffer.alloc(0), 'image/jpeg', ENV, { client });

        expect(client.send).not.toHaveBeenCalled();
    });
});
