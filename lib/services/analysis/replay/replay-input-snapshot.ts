import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
    constants,
    createCipheriv,
    createHash,
    createPublicKey,
    publicEncrypt,
    randomBytes,
} from 'node:crypto';

const MAX_FRAGMENT_BYTES = 8 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const MAX_FRAGMENT_COUNT = 128;
const MAX_TTL_SECONDS = 24 * 60 * 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const R2_HOST = /(?:^|\.)r2\.cloudflarestorage\.com$/;
const OBJECT_KEY = /^replay\/v1\/[0-9a-f-]{36}\/[0-9a-f]{64}\.enc$/;
const SAFE_PART = /^[a-z][a-z0-9_-]{0,31}$/;

export const REPLAY_CAPTURE_LIMITS = {
    maxFragmentBytes: MAX_FRAGMENT_BYTES,
    maxCaptureBytes: MAX_CAPTURE_BYTES,
    maxFragmentCount: MAX_FRAGMENT_COUNT,
    maxTtlSeconds: MAX_TTL_SECONDS,
} as const;

export type ReplayCaptureConfig = {
    enabled: true;
    endpoint: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    recipientPublicKeyBase64: string;
    recipientKeyFingerprint: string;
};

export type ReplayFragmentKind = 'provider_payload' | 'normalized_snapshot' | 'execution_trace';
export type ReplayFragmentStage = 'preflight' | 'collection' | 'scoring' | 'finalization';
export type ReplayFragmentInput = {
    captureId: string;
    opaqueLocator: string;
    kind: ReplayFragmentKind;
    stage: ReplayFragmentStage;
    plaintext: Buffer;
    recipientPublicKeyBase64: string;
};
export type EncryptedReplayFragment = {
    objectKey: string;
    ciphertext: Buffer;
    ciphertextSha256: string;
    ciphertextByteSize: number;
    recipientKeyFingerprint: string;
    envelopeVersion: 1;
};

type Envelope = {
    v: 1;
    ek: string;
    iv: string;
    tag: string;
    ct: string;
};
export type ReplayCaptureTransport = {
    put(input: { key: string; bytes: Buffer; sha256: string }): Promise<void>;
    get(input: { key: string; sha256: string; byteSize: number }): Promise<Buffer>;
    delete(key: string): Promise<void>;
};
type CommandClient = { send(command: object): Promise<unknown> };
type Dependencies = {
    createTransport?: (config: ReplayCaptureConfig) => ReplayCaptureTransport;
    client?: CommandClient;
};

export class ReplayCaptureError extends Error {
    constructor(readonly code: 'REPLAY_CAPTURE_INVALID_CONFIGURATION' | 'REPLAY_CAPTURE_INVALID_FRAGMENT' | 'REPLAY_CAPTURE_INTEGRITY_FAILURE' | 'REPLAY_CAPTURE_TRANSPORT_FAILURE') {
        super(code);
        this.name = 'ReplayCaptureError';
    }
}

function fail(code: ReplayCaptureError['code']): never {
    throw new ReplayCaptureError(code);
}

function validR2Config(input: Omit<ReplayCaptureConfig, 'enabled' | 'recipientKeyFingerprint'>): Omit<ReplayCaptureConfig, 'enabled'> {
    let endpoint: URL;
    try { endpoint = new URL(input.endpoint); } catch { return fail('REPLAY_CAPTURE_INVALID_CONFIGURATION'); }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.port
        || endpoint.pathname !== '/' || endpoint.search || endpoint.hash
        || !R2_HOST.test(endpoint.hostname.toLowerCase()) || !BUCKET.test(input.bucket)
        || input.accessKeyId.length < 8 || input.accessKeyId.length > 256
        || input.secretAccessKey.length < 8 || input.secretAccessKey.length > 512) {
        return fail('REPLAY_CAPTURE_INVALID_CONFIGURATION');
    }
    let recipientKeyFingerprint: string;
    try {
        const pem = Buffer.from(input.recipientPublicKeyBase64, 'base64').toString('utf8');
        const key = createPublicKey(pem);
        if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
            return fail('REPLAY_CAPTURE_INVALID_CONFIGURATION');
        }
        recipientKeyFingerprint = createHash('sha256')
            .update(key.export({ type: 'spki', format: 'der' }))
            .digest('hex');
    } catch { return fail('REPLAY_CAPTURE_INVALID_CONFIGURATION'); }
    return { ...input, endpoint: endpoint.origin, recipientKeyFingerprint };
}

/** Disabled unless the literal string `true` is supplied; disabled config has no required fields. */
export function loadReplayCaptureConfig(env: Readonly<Record<string, string | undefined>> = process.env): ReplayCaptureConfig | { enabled: false } {
    if (env.ANALYSIS_V2_REPLAY_CAPTURE_ENABLED !== 'true') return { enabled: false };
    const endpoint = env.ANALYSIS_V2_REPLAY_CAPTURE_R2_ENDPOINT?.trim();
    const bucket = env.ANALYSIS_V2_REPLAY_CAPTURE_R2_BUCKET?.trim();
    const accessKeyId = env.ANALYSIS_V2_REPLAY_CAPTURE_R2_ACCESS_KEY_ID?.trim();
    const secretAccessKey = env.ANALYSIS_V2_REPLAY_CAPTURE_R2_SECRET_ACCESS_KEY?.trim();
    const recipientPublicKeyBase64 = env.ANALYSIS_V2_REPLAY_CAPTURE_RECIPIENT_PUBLIC_KEY_B64?.trim();
    const resultImageBucket = env.ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET?.trim();
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey || !recipientPublicKeyBase64) {
        return fail('REPLAY_CAPTURE_INVALID_CONFIGURATION');
    }
    if (resultImageBucket && resultImageBucket === bucket) return fail('REPLAY_CAPTURE_INVALID_CONFIGURATION');
    return { enabled: true, ...validR2Config({ endpoint, bucket, accessKeyId, secretAccessKey, recipientPublicKeyBase64 }) };
}

function aad(input: Pick<ReplayFragmentInput, 'captureId' | 'opaqueLocator' | 'kind' | 'stage'>): Buffer {
    return Buffer.from(JSON.stringify({ v: 1, captureId: input.captureId, opaqueLocator: input.opaqueLocator, kind: input.kind, stage: input.stage }), 'utf8');
}

export function replayCaptureObjectKey(captureId: string, opaqueLocator: string): string {
    if (!UUID.test(captureId) || !SAFE_PART.test(opaqueLocator)) fail('REPLAY_CAPTURE_INVALID_FRAGMENT');
    return `replay/v1/${captureId}/${createHash('sha256').update(opaqueLocator).digest('hex')}.enc`;
}

function validateInput(input: ReplayFragmentInput): void {
    if (!UUID.test(input.captureId) || !SAFE_PART.test(input.opaqueLocator)
        || !['provider_payload', 'normalized_snapshot', 'execution_trace'].includes(input.kind)
        || !['preflight', 'collection', 'scoring', 'finalization'].includes(input.stage)
        || !Buffer.isBuffer(input.plaintext) || input.plaintext.length < 1 || input.plaintext.length > MAX_FRAGMENT_BYTES) {
        fail('REPLAY_CAPTURE_INVALID_FRAGMENT');
    }
}

export function encryptReplayCaptureFragment(input: ReplayFragmentInput): EncryptedReplayFragment {
    validateInput(input);
    let publicKey;
    try { publicKey = createPublicKey(Buffer.from(input.recipientPublicKeyBase64, 'base64').toString('utf8')); } catch { return fail('REPLAY_CAPTURE_INVALID_CONFIGURATION'); }
    if (publicKey.asymmetricKeyType !== 'rsa' || (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) fail('REPLAY_CAPTURE_INVALID_CONFIGURATION');
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(input));
    const ciphertext = Buffer.concat([cipher.update(input.plaintext), cipher.final()]);
    const envelope: Envelope = {
        v: 1,
        ek: publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key).toString('base64'),
        iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ciphertext.toString('base64'),
    };
    const bytes = Buffer.from(JSON.stringify(envelope), 'utf8');
    if (bytes.length > MAX_FRAGMENT_BYTES + 2048) fail('REPLAY_CAPTURE_INVALID_FRAGMENT');
    return {
        objectKey: replayCaptureObjectKey(input.captureId, input.opaqueLocator),
        ciphertext: bytes,
        ciphertextSha256: createHash('sha256').update(bytes).digest('hex'),
        ciphertextByteSize: bytes.length,
        recipientKeyFingerprint: createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex'),
        envelopeVersion: 1,
    };
}

function createR2Transport(config: ReplayCaptureConfig, client: CommandClient = new S3Client({ endpoint: config.endpoint, region: 'auto', credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } })): ReplayCaptureTransport {
    const safe = async <T>(operation: () => Promise<T>): Promise<T> => {
        try { return await operation(); } catch (error) { if (error instanceof ReplayCaptureError) throw error; return fail('REPLAY_CAPTURE_TRANSPORT_FAILURE'); }
    };
    return {
        put: async ({ key, bytes, sha256 }) => safe(async () => {
            validateExactKey(key); if (!SHA256.test(sha256) || bytes.length < 1 || bytes.length > MAX_FRAGMENT_BYTES + 2048) fail('REPLAY_CAPTURE_INVALID_FRAGMENT');
            await client.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: bytes, ContentLength: bytes.length, ContentType: 'application/octet-stream', CacheControl: `private, max-age=${MAX_TTL_SECONDS}`, Metadata: { sha256 } }));
        }),
        get: async ({ key, sha256, byteSize }) => safe(async () => {
            validateExactKey(key); if (!SHA256.test(sha256) || byteSize < 1 || byteSize > MAX_FRAGMENT_BYTES + 2048) fail('REPLAY_CAPTURE_INVALID_FRAGMENT');
            const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key })) as { Body?: { transformToByteArray(): Promise<Uint8Array> }; ContentLength?: number; Metadata?: Record<string, string> };
            if (!response.Body || response.ContentLength !== byteSize || response.Metadata?.sha256 !== sha256) fail('REPLAY_CAPTURE_INTEGRITY_FAILURE');
            const bytes = Buffer.from(await response.Body.transformToByteArray());
            if (bytes.length !== byteSize || createHash('sha256').update(bytes).digest('hex') !== sha256) fail('REPLAY_CAPTURE_INTEGRITY_FAILURE');
            return bytes;
        }),
        delete: async (key) => safe(async () => { validateExactKey(key); await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key })); }),
    };
}
function validateExactKey(key: string): void { if (!OBJECT_KEY.test(key)) fail('REPLAY_CAPTURE_INVALID_FRAGMENT'); }

function assertFragmentIntegrity(fragment: EncryptedReplayFragment, recipientKeyFingerprint: string): void {
    validateExactKey(fragment.objectKey);
    if (!Buffer.isBuffer(fragment.ciphertext)
        || fragment.ciphertext.length < 1
        || fragment.ciphertext.length > MAX_FRAGMENT_BYTES + 2048
        || fragment.ciphertextByteSize !== fragment.ciphertext.length
        || !SHA256.test(fragment.ciphertextSha256)
        || !SHA256.test(fragment.recipientKeyFingerprint)
        || fragment.recipientKeyFingerprint !== recipientKeyFingerprint
        || createHash('sha256').update(fragment.ciphertext).digest('hex') !== fragment.ciphertextSha256) {
        fail('REPLAY_CAPTURE_INTEGRITY_FAILURE');
    }
}

export function createReplayCaptureStore(env: Readonly<Record<string, string | undefined>> = process.env, dependencies: Dependencies = {}) {
    const config = loadReplayCaptureConfig(env);
    if (!config.enabled) return { enabled: false as const, put: async () => undefined, get: async () => undefined, delete: async () => undefined };
    const transport = dependencies.createTransport?.(config) ?? createR2Transport(config, dependencies.client);
    return {
        enabled: true as const,
        put: async (fragment: EncryptedReplayFragment) => {
            assertFragmentIntegrity(fragment, config.recipientKeyFingerprint);
            await transport.put({ key: fragment.objectKey, bytes: fragment.ciphertext, sha256: fragment.ciphertextSha256 });
        },
        get: transport.get,
        delete: transport.delete,
    };
}
