import {
    constants,
    createDecipheriv,
    createHash,
    createHmac,
    generateKeyPairSync,
    privateDecrypt,
} from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
    createReplayCaptureStore,
    encryptReplayCaptureFragment,
    loadReplayCaptureConfig,
    REPLAY_CAPTURE_LIMITS,
    replayCaptureObjectKey,
} from './replay-input-snapshot';

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
    ANALYSIS_V2_REPLAY_CAPTURE_CONTENT_COMMITMENT_SECRET:
        'test-content-commitment-secret-at-least-32-bytes',
};

function fragmentInput(overrides: Record<string, unknown> = {}) {
    return {
        captureId: CAPTURE_ID,
        opaqueLocator: 'opaque-a',
        kind: 'provider_payload' as const,
        stage: 'collection' as const,
        batchOrdinal: 0,
        ordinal: 0,
        plaintext: Buffer.from('a'),
        recipientPublicKeyBase64: PUBLIC_KEY_B64,
        contentCommitmentSecret:
            ENV.ANALYSIS_V2_REPLAY_CAPTURE_CONTENT_COMMITMENT_SECRET,
        ...overrides,
    };
}

function decryptForTest(
    ciphertext: Buffer,
    input: {
        captureId: string; opaqueLocator: string; kind: string; stage: string;
        batchOrdinal: number; ordinal: number;
        plaintext: Buffer; contentCommitmentSecret: string;
    }
): Buffer {
    const envelope = JSON.parse(ciphertext.toString('utf8')) as {
        ek: string; iv: string; tag: string; ct: string;
    };
    const key = privateDecrypt({
        key: privateKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
    }, Buffer.from(envelope.ek, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    const identity = [
        'replay/v1',
        input.captureId,
        createHash('sha256').update(input.opaqueLocator).digest('hex'),
        input.kind,
        input.stage,
        String(input.batchOrdinal),
        String(input.ordinal),
    ].join('\n');
    const commitment = createHmac('sha256', input.contentCommitmentSecret)
        .update('replay-content-v1')
        .update('\n')
        .update(input.plaintext)
        .digest('hex');
    decipher.setAAD(Buffer.from(`${identity}\n${commitment}`, 'utf8'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]);
}

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
            ANALYSIS_V2_REPLAY_CAPTURE_RECIPIENT_PUBLIC_KEY_B64: 'not-base64',
        })).toThrow('REPLAY_CAPTURE_INVALID_CONFIGURATION');
    });

    it('rejects a replay bucket that aliases the result-image bucket', () => {
        expect(() => loadReplayCaptureConfig({
            ...ENV,
            ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET: ENV.ANALYSIS_V2_REPLAY_CAPTURE_R2_BUCKET,
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
            batchOrdinal: 2,
            ordinal: 7,
            plaintext: Buffer.from('sensitive provider response'),
            recipientPublicKeyBase64: PUBLIC_KEY_B64,
            contentCommitmentSecret:
                ENV.ANALYSIS_V2_REPLAY_CAPTURE_CONTENT_COMMITMENT_SECRET,
        };
        const first = encryptReplayCaptureFragment(input);
        const second = encryptReplayCaptureFragment(input);

        expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
        expect(first.objectKey).toMatch(/^replay\/v1\/[0-9a-f-]{36}\/[a-z0-9-]{1,64}\.enc$/);
        expect(first.objectKey).not.toContain('candidate-0001-a9c3');
        expect(decryptForTest(first.ciphertext, input))
            .toEqual(input.plaintext);
        expect(() => decryptForTest(first.ciphertext, {
            ...input,
            opaqueLocator: 'candidate-0002-b2d4',
        })).toThrow();
    });

    it('rejects cross-fragment envelope swaps', () => {
        const first = encryptReplayCaptureFragment(fragmentInput());
        expect(() => decryptForTest(first.ciphertext, {
            captureId: CAPTURE_ID, opaqueLocator: 'opaque-b', kind: 'provider_payload',
            stage: 'collection', batchOrdinal: 0, ordinal: 0,
            plaintext: Buffer.from('a'),
            contentCommitmentSecret:
                ENV.ANALYSIS_V2_REPLAY_CAPTURE_CONTENT_COMMITMENT_SECRET,
        })).toThrow();
    });
});

describe('replay capture exact-key transport', () => {
    it('uses an S3 create-only precondition', async () => {
        const client = {
            send: vi.fn(async (command: object) => {
                void command;
                return {};
            }),
        };
        const store = createReplayCaptureStore(ENV, { client });
        const encrypted = encryptReplayCaptureFragment(fragmentInput());

        await store.put(encrypted);

        const command = client.send.mock.calls[0]?.[0] as {
            constructor: { name: string };
            input: Record<string, unknown>;
        };
        expect(command.constructor.name).toBe('PutObjectCommand');
        expect(command.input).toMatchObject({
            Key: encrypted.objectKey,
            IfNoneMatch: '*',
        });
    });

    it('handles an S3 precondition failure with one bounded exact-key get', async () => {
        const original = encryptReplayCaptureFragment(fragmentInput());
        const client = {
            send: vi.fn(async (command: {
                constructor: { name: string };
                input: Record<string, unknown>;
            }) => {
                if (command.constructor.name === 'PutObjectCommand') {
                    throw {
                        name: 'PreconditionFailed',
                        $metadata: { httpStatusCode: 412 },
                    };
                }
                return {
                    Body: {
                        transformToByteArray: async () => Uint8Array.from(
                            original.ciphertext
                        ),
                    },
                    ContentLength: original.ciphertextByteSize,
                };
            }),
        };
        const store = createReplayCaptureStore(ENV, { client });

        const recovered = await store.put(
            encryptReplayCaptureFragment(fragmentInput())
        );

        expect(recovered?.ciphertextSha256).toBe(original.ciphertextSha256);
        const getCommand = client.send.mock.calls[1]?.[0];
        expect(getCommand?.constructor.name).toBe('GetObjectCommand');
        expect(getCommand?.input).toMatchObject({
            Key: original.objectKey,
            Range: `bytes=0-${REPLAY_CAPTURE_LIMITS.maxObjectBytes}`,
        });
    });

    it('only performs a bounded put for the generated exact key', async () => {
        const putCreateOnly = vi.fn(async () => 'created' as const);
        const store = createReplayCaptureStore(ENV, {
            createTransport: () => ({ putCreateOnly, get: vi.fn() }),
        });
        const encrypted = encryptReplayCaptureFragment(fragmentInput());
        await store.put(encrypted);

        expect(putCreateOnly).toHaveBeenCalledWith({
            key: encrypted.objectKey,
            bytes: encrypted.ciphertext,
            sha256: encrypted.ciphertextSha256,
        });
        expect(replayCaptureObjectKey(encrypted.identity)).not.toContain('opaque-a');
    });

    it('separates stages and ordinals for the same opaque candidate', () => {
        const collection = encryptReplayCaptureFragment(fragmentInput());
        const scoring = encryptReplayCaptureFragment(fragmentInput({ stage: 'scoring' }));
        const nextOrdinal = encryptReplayCaptureFragment(fragmentInput({ ordinal: 1 }));

        expect(new Set([
            collection.objectKey, scoring.objectKey, nextOrdinal.objectKey,
        ])).toHaveLength(3);
    });
});

describe('replay capture upload integrity fence', () => {
    it('rejects a fragment authenticated with a different configured secret', async () => {
        const putCreateOnly = vi.fn(async () => 'created' as const);
        const store = createReplayCaptureStore(ENV, {
            createTransport: () => ({ putCreateOnly, get: vi.fn() }),
        });
        const fragment = encryptReplayCaptureFragment(fragmentInput({
            contentCommitmentSecret:
                'different-content-commitment-secret-at-least-32-bytes',
        }));

        await expect(store.put(fragment))
            .rejects.toThrow('REPLAY_CAPTURE_INTEGRITY_FAILURE');
        expect(putCreateOnly).not.toHaveBeenCalled();
    });

    it.each([
        ['ciphertext', (fragment: ReturnType<typeof encryptReplayCaptureFragment>) => ({
            ...fragment, ciphertext: Buffer.from('tampered'),
        })],
        ['hash', (fragment: ReturnType<typeof encryptReplayCaptureFragment>) => ({
            ...fragment, ciphertextSha256: 'f'.repeat(64),
        })],
        ['size', (fragment: ReturnType<typeof encryptReplayCaptureFragment>) => ({
            ...fragment, ciphertextByteSize: fragment.ciphertextByteSize + 1,
        })],
        ['recipient fingerprint', (fragment: ReturnType<typeof encryptReplayCaptureFragment>) => ({
            ...fragment, recipientKeyFingerprint: 'f'.repeat(64),
        })],
    ])('rejects a tampered %s before upload', async (_name, mutate) => {
        const putCreateOnly = vi.fn(async () => 'created' as const);
        const store = createReplayCaptureStore(ENV, {
            createTransport: () => ({ putCreateOnly, get: vi.fn() }),
        });
        const fragment = encryptReplayCaptureFragment(fragmentInput());

        await expect(store.put(mutate(fragment))).rejects.toThrow('REPLAY_CAPTURE_INTEGRITY_FAILURE');
        expect(putCreateOnly).not.toHaveBeenCalled();
    });

    it.each([
        ['object key', (fragment: ReturnType<typeof encryptReplayCaptureFragment>) => ({
            ...fragment, objectKey: fragment.objectKey.replace(/[0-9a-f]{64}[.]enc$/, `${'f'.repeat(64)}.enc`),
        })],
        ['kind', (fragment: ReturnType<typeof encryptReplayCaptureFragment>) => ({
            ...fragment, identity: { ...fragment.identity, kind: 'execution_trace' as const },
        })],
        ['stage', (fragment: ReturnType<typeof encryptReplayCaptureFragment>) => ({
            ...fragment, identity: { ...fragment.identity, stage: 'scoring' as const },
        })],
        ['batch', (fragment: ReturnType<typeof encryptReplayCaptureFragment>) => ({
            ...fragment, identity: { ...fragment.identity, batchOrdinal: 1 },
        })],
        ['ordinal', (fragment: ReturnType<typeof encryptReplayCaptureFragment>) => ({
            ...fragment, identity: { ...fragment.identity, ordinal: 1 },
        })],
    ])('rejects tampered canonical %s before upload', async (_name, mutate) => {
        const putCreateOnly = vi.fn(async () => 'created' as const);
        const store = createReplayCaptureStore(ENV, {
            createTransport: () => ({ putCreateOnly, get: vi.fn() }),
        });
        await expect(store.put(mutate(encryptReplayCaptureFragment(fragmentInput()))))
            .rejects.toThrow('REPLAY_CAPTURE_INTEGRITY_FAILURE');
        expect(putCreateOnly).not.toHaveBeenCalled();
    });
});

describe('replay capture create-only retry', () => {
    it('recovers the original object after response loss without overwrite', async () => {
        let stored: Buffer | undefined;
        let firstAttempt = true;
        const putCreateOnly = vi.fn(async (input: { bytes: Buffer }) => {
            if (!stored) {
                stored = Buffer.from(input.bytes);
                if (firstAttempt) {
                    firstAttempt = false;
                    throw new Error('response lost');
                }
                return 'created' as const;
            }
            return 'exists' as const;
        });
        const get = vi.fn(async () => Buffer.from(stored!));
        const store = createReplayCaptureStore(ENV, {
            createTransport: () => ({ putCreateOnly, get }),
        });
        const original = encryptReplayCaptureFragment(fragmentInput());
        await expect(store.put(original)).rejects.toThrow('response lost');
        const retry = encryptReplayCaptureFragment(fragmentInput());

        const recovered = await store.put(retry);

        expect(recovered?.ciphertextSha256).toBe(original.ciphertextSha256);
        expect(recovered?.ciphertext).toEqual(original.ciphertext);
        expect(stored).toEqual(original.ciphertext);
        expect(get).toHaveBeenCalledWith(original.objectKey);
    });

    it('rejects a conflicting existing object at the canonical key', async () => {
        const conflicting = encryptReplayCaptureFragment(fragmentInput({ stage: 'scoring' }));
        const store = createReplayCaptureStore(ENV, {
            createTransport: () => ({
                putCreateOnly: vi.fn(async () => 'exists' as const),
                get: vi.fn(async () => conflicting.ciphertext),
            }),
        });
        await expect(store.put(encryptReplayCaptureFragment(fragmentInput())))
            .rejects.toThrow('REPLAY_CAPTURE_CONFLICT');
    });

    it('rejects same-identity recovery when the stable content commitment differs', async () => {
        const original = encryptReplayCaptureFragment(fragmentInput({
            plaintext: Buffer.from('original-private-payload'),
        }));
        const store = createReplayCaptureStore(ENV, {
            createTransport: () => ({
                putCreateOnly: vi.fn(async () => 'exists' as const),
                get: vi.fn(async () => original.ciphertext),
            }),
        });
        const changed = encryptReplayCaptureFragment(fragmentInput({
            plaintext: Buffer.from('different-private-payload'),
        }));

        await expect(store.put(changed)).rejects.toThrow('REPLAY_CAPTURE_CONFLICT');
        expect(changed.contentCommitment).not.toBe(original.contentCommitment);
        expect(changed.contentCommitment).not.toContain('private-payload');
    });
});

describe('replay capture deletion boundary', () => {
    it('exposes no arbitrary or cross-capture delete operation', () => {
        const first = createReplayCaptureStore(ENV, {
            createTransport: () => ({
                putCreateOnly: vi.fn(),
                get: vi.fn(),
            }),
        });
        const second = createReplayCaptureStore(ENV, {
            createTransport: () => ({
                putCreateOnly: vi.fn(),
                get: vi.fn(),
            }),
        });

        expect('delete' in first).toBe(false);
        expect('delete' in second).toBe(false);
    });
});

describe('replay capture encoded object bounds', () => {
    it('accepts the maximum plaintext with an encoded object no larger than 8 MiB', () => {
        const fragment = encryptReplayCaptureFragment(fragmentInput({
            plaintext: Buffer.alloc(REPLAY_CAPTURE_LIMITS.maxPlaintextBytes),
        }));
        expect(fragment.ciphertextByteSize)
            .toBeLessThanOrEqual(REPLAY_CAPTURE_LIMITS.maxObjectBytes);
    });

    it('rejects plaintext one byte over the maximum', () => {
        expect(() => encryptReplayCaptureFragment(fragmentInput({
            plaintext: Buffer.alloc(REPLAY_CAPTURE_LIMITS.maxPlaintextBytes + 1),
        }))).toThrow('REPLAY_CAPTURE_INVALID_FRAGMENT');
    });
});
