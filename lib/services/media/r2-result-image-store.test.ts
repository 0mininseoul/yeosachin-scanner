import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
    createResultImageR2Reader,
    createResultImageR2Writer,
    loadResultImageR2Config,
    resultImageObjectKey,
} from './r2-result-image-store';

const CONFIG = {
    endpoint: 'https://0123456789abcdef.r2.cloudflarestorage.com',
    bucket: 'analysis-v2-result-images',
    accessKeyId: 'r2-test-access-key',
    secretAccessKey: 'r2-test-secret-key',
};
const HMAC_SECRET = 'test-result-image-hmac-secret-at-least-32-chars';
const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';
const HASH = createHash('sha256').update('webp-bytes').digest('hex');

function fakeClient(
    implementation: (command: { input: Record<string, unknown> }) => unknown
) {
    return {
        send: vi.fn(async (command: { input: Record<string, unknown> }) => (
            implementation(command)
        )),
    };
}

describe('resultImageObjectKey', () => {
    it('creates stable opaque keys without identifiers or source material', () => {
        const sensitiveInput = {
            requestId: REQUEST_ID,
            kind: 'female' as const,
            candidateId: 'candidate-instagram-user',
            sourceFingerprint: HASH,
        };

        const first = resultImageObjectKey(sensitiveInput, HMAC_SECRET);
        const second = resultImageObjectKey(sensitiveInput, HMAC_SECRET);

        expect(first).toBe(second);
        expect(first).toMatch(
            /^v1\/[0-9a-f]{32}\/female\/[0-9a-f]{32}\.webp$/
        );
        expect(first).not.toContain(REQUEST_ID);
        expect(first).not.toContain('candidate-instagram-user');
        expect(first).not.toContain(HASH);
        expect(first).not.toContain('instagram');
    });

    it('separates target, public female, and private candidate namespaces', () => {
        const base = {
            requestId: REQUEST_ID,
            candidateId: 'candidate-1',
            sourceFingerprint: HASH,
        };
        const keys = [
            resultImageObjectKey({
                ...base,
                kind: 'target',
                candidateId: null,
            }, HMAC_SECRET),
            resultImageObjectKey({ ...base, kind: 'female' }, HMAC_SECRET),
            resultImageObjectKey({ ...base, kind: 'private' }, HMAC_SECRET),
        ];

        expect(new Set(keys)).toHaveLength(3);
        expect(keys[0]).toContain('/target/');
        expect(keys[1]).toContain('/female/');
        expect(keys[2]).toContain('/private/');
    });
});

describe('private R2 result image adapter', () => {
    it('writes private WebP objects with only integrity metadata', async () => {
        const client = fakeClient(() => ({}));
        const writer = createResultImageR2Writer(CONFIG, { client });
        const bytes = Buffer.from('webp-bytes');
        const objectKey = resultImageObjectKey({
            requestId: REQUEST_ID,
            kind: 'target',
            candidateId: null,
            sourceFingerprint: HASH,
        }, HMAC_SECRET);

        await writer.put({ objectKey, bytes, sha256: HASH });

        expect(client.send).toHaveBeenCalledOnce();
        const command = client.send.mock.calls[0]?.[0];
        expect(command?.constructor.name).toBe('PutObjectCommand');
        expect(command?.input).toEqual({
            Bucket: CONFIG.bucket,
            Key: objectKey,
            Body: bytes,
            ContentLength: bytes.byteLength,
            ContentType: 'image/webp',
            CacheControl: 'private, max-age=86400',
            Metadata: { sha256: HASH },
        });
    });

    it('head-verifies exact object size and digest', async () => {
        const client = fakeClient(() => ({
            ContentLength: 10,
            ContentType: 'image/webp',
            Metadata: { sha256: HASH },
        }));
        const writer = createResultImageR2Writer(CONFIG, { client });
        const objectKey = `v1/${'a'.repeat(32)}/female/${'b'.repeat(32)}.webp`;

        await expect(writer.head({
            objectKey,
            expectedByteSize: 10,
            expectedSha256: HASH,
        })).resolves.toEqual({
            byteSize: 10,
            sha256: HASH,
        });
        expect(client.send.mock.calls[0]?.[0]?.constructor.name)
            .toBe('HeadObjectCommand');

        await expect(writer.head({
            objectKey,
            expectedByteSize: 11,
            expectedSha256: HASH,
        })).rejects.toThrow('R2_RESULT_IMAGE_INTEGRITY_MISMATCH');
    });

    it('reads only bounded, integrity-matching WebP bytes', async () => {
        const bytes = Buffer.from('webp-bytes');
        const client = fakeClient(() => ({
            Body: {
                transformToByteArray: async () => Uint8Array.from(bytes),
            },
            ContentLength: bytes.byteLength,
            ContentType: 'image/webp',
            Metadata: { sha256: HASH },
        }));
        const reader = createResultImageR2Reader(CONFIG, { client });
        const objectKey = `v1/${'a'.repeat(32)}/private/${'b'.repeat(32)}.webp`;

        await expect(reader.get({
            objectKey,
            expectedByteSize: bytes.byteLength,
            expectedSha256: HASH,
        })).resolves.toEqual(bytes);
        expect(client.send.mock.calls[0]?.[0]?.constructor.name)
            .toBe('GetObjectCommand');
    });

    it('uses idempotent delete and never leaks provider configuration in errors', async () => {
        const client = fakeClient((command) => {
            if (command.constructor.name === 'DeleteObjectCommand') return {};
            throw new Error(
                `${CONFIG.endpoint} ${CONFIG.accessKeyId} `
                + `${CONFIG.secretAccessKey} ${CONFIG.bucket} secret-object-key`
            );
        });
        const writer = createResultImageR2Writer(CONFIG, { client });
        const objectKey = `v1/${'a'.repeat(32)}/target/${'b'.repeat(32)}.webp`;

        await expect(writer.delete(objectKey)).resolves.toBeUndefined();
        expect(client.send.mock.calls[0]?.[0]?.constructor.name)
            .toBe('DeleteObjectCommand');

        let message = '';
        try {
            await writer.head({
                objectKey,
                expectedByteSize: 10,
                expectedSha256: HASH,
            });
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        expect(message).toBe('R2_RESULT_IMAGE_OPERATION_FAILED');
        expect(message).not.toContain(CONFIG.endpoint);
        expect(message).not.toContain(CONFIG.accessKeyId);
        expect(message).not.toContain(CONFIG.secretAccessKey);
        expect(message).not.toContain(CONFIG.bucket);
        expect(message).not.toContain(objectKey);
    });
});

describe('loadResultImageR2Config', () => {
    it('loads server-only values and rejects public or malformed configuration', () => {
        expect(loadResultImageR2Config({
            ANALYSIS_V2_RESULT_IMAGE_R2_ENDPOINT: CONFIG.endpoint,
            ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET: CONFIG.bucket,
            ANALYSIS_V2_RESULT_IMAGE_R2_ACCESS_KEY_ID: CONFIG.accessKeyId,
            ANALYSIS_V2_RESULT_IMAGE_R2_SECRET_ACCESS_KEY:
                CONFIG.secretAccessKey,
        })).toEqual(CONFIG);

        expect(() => loadResultImageR2Config({
            ANALYSIS_V2_RESULT_IMAGE_R2_ENDPOINT: 'http://localhost:9000',
            ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET: CONFIG.bucket,
            ANALYSIS_V2_RESULT_IMAGE_R2_ACCESS_KEY_ID: CONFIG.accessKeyId,
            ANALYSIS_V2_RESULT_IMAGE_R2_SECRET_ACCESS_KEY:
                CONFIG.secretAccessKey,
        })).toThrow('R2_RESULT_IMAGE_INVALID_CONFIGURATION');
    });
});
