import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
    createReplayCaptureStore,
    decryptReplayCaptureEnvelopeForTest,
    encryptReplayCaptureFragment,
    loadReplayCaptureConfig,
    replayCaptureObjectKey,
} from './replay-capture';

const CAPTURE_ID = '123e4567-e89b-42d3-a456-426614174000';
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const PUBLIC_KEY_B64 = Buffer.from(publicKey).toString('base64');
const ENV = {
    ANALYSIS_V2_REPLAY_CAPTURE_ENABLED: 'true',
    ANALYSIS_V2_REPLAY_CAPTURE_R2_BUCKET: 'private-replay-captures',
    ANALYSIS_V2_REPLAY_CAPTURE_R2_ENDPOINT:
        'https://0123456789abcdef.r2.cloudflarestorage.com',
    ANALYSIS_V2_REPLAY_CAPTURE_R2_ACCESS_KEY_ID: 'replay-access-key',
    ANALYSIS_V2_REPLAY_CAPTURE_R2_SECRET_ACCESS_KEY: 'replay-secret-key',
    ANALYSIS_V2_REPLAY_CAPTURE_RECIPIENT_PUBLIC_KEY_B64: PUBLIC_KEY_B64,
};

describe('replay capture configuration', () => {
    it('is disabled by default and creates no transport client', () => {
        const createTransport = vi.fn();
        const store = createReplayCaptureStore({}, { createTransport });

        expect(store.enabled).toBe(false);
        expect(createTransport).not.toHaveBeenCalled();
    });

    it('rejects enabled incomplete or malformed private configuration', () => {
        expect(() => loadReplayCaptureConfig({
            ANALYSIS_V2_REPLAY_CAPTURE_ENABLED: 'true',
        })).toThrow('REPLAY_CAPTURE_INVALID_CONFIGURATION');
        expect(() => loadReplayCaptureConfig({
            ...ENV,
            ANALYSIS_V2_REPLAY_CAPTURE_R2_BUCKET: 'result-images',
            ANALYSIS_V2_REPLAY_CAPTURE_RECIPIENT_PUBLIC_KEY_B64: 'not-base64',
        })).toThrow('REPLAY_CAPTURE_INVALID_CONFIGURATION');
    });
});

describe('replay capture envelope', () => {
    it('encrypts with randomized AES-GCM and decrypts only for the same AAD', () => {
        const input = {
            captureId: CAPTURE_ID,
            opaqueLocator: 'candidate-0001-a9c3',
            kind: 'provider_payload' as const,
            stage: 'collection' as const,
            plaintext: Buffer.from('sensitive provider response'),
            recipientPublicKeyBase64: PUBLIC_KEY_B64,
        };
        const first = encryptReplayCaptureFragment(input);
        const second = encryptReplayCaptureFragment(input);

        expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
        expect(first.objectKey).toMatch(/^replay\/v1\/[0-9a-f-]{36}\/[a-z0-9-]{1,64}\.enc$/);
        expect(first.objectKey).not.toContain('candidate-0001-a9c3');
        expect(decryptReplayCaptureEnvelopeForTest(first, privateKey, input))
            .toEqual(input.plaintext);
        expect(() => decryptReplayCaptureEnvelopeForTest(first, privateKey, {
            ...input,
            opaqueLocator: 'candidate-0002-b2d4',
        })).toThrow();
    });

    it('rejects cross-fragment envelope swaps', () => {
        const first = encryptReplayCaptureFragment({
            captureId: CAPTURE_ID,
            opaqueLocator: 'opaque-a', kind: 'provider_payload', stage: 'collection',
            plaintext: Buffer.from('a'), recipientPublicKeyBase64: PUBLIC_KEY_B64,
        });
        expect(() => decryptReplayCaptureEnvelopeForTest(first, privateKey, {
            captureId: CAPTURE_ID, opaqueLocator: 'opaque-b', kind: 'provider_payload',
            stage: 'collection', plaintext: Buffer.from('a'),
            recipientPublicKeyBase64: PUBLIC_KEY_B64,
        })).toThrow();
    });
});

describe('replay capture exact-key transport', () => {
    it('only performs a bounded put for the generated exact key', async () => {
        const put = vi.fn(async () => undefined);
        const store = createReplayCaptureStore(ENV, {
            createTransport: () => ({ put, get: vi.fn(), delete: vi.fn() }),
        });
        const encrypted = encryptReplayCaptureFragment({
            captureId: CAPTURE_ID, opaqueLocator: 'opaque-a', kind: 'provider_payload',
            stage: 'collection', plaintext: Buffer.from('a'),
            recipientPublicKeyBase64: PUBLIC_KEY_B64,
        });
        await store.put(encrypted);

        expect(put).toHaveBeenCalledWith({
            key: encrypted.objectKey,
            bytes: encrypted.ciphertext,
            sha256: encrypted.ciphertextSha256,
        });
        expect(replayCaptureObjectKey(CAPTURE_ID, 'opaque-a')).not.toContain('opaque-a');
    });
});
