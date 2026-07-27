import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
    constants,
    createCipheriv,
    createHash,
    createHmac,
    createPublicKey,
    publicEncrypt,
    randomBytes,
    timingSafeEqual,
} from 'node:crypto';

const MAX_OBJECT_BYTES = 8 * 1024 * 1024;
// Leaves deterministic room for base64 expansion, the wrapped AES key, and public metadata.
const MAX_PLAINTEXT_BYTES = (6 * 1024 * 1024) - 4096;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const MAX_FRAGMENT_COUNT = 128;
const MAX_TTL_SECONDS = 24 * 60 * 60;
const MIN_RSA_MODULUS_BITS = 2048;
const MAX_RSA_MODULUS_BITS = 8192;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const R2_HOST = /(?:^|\.)r2\.cloudflarestorage\.com$/;
const OBJECT_KEY = /^replay\/v1\/[0-9a-f-]{36}\/[0-9a-f]{64}\.enc$/;
const SAFE_PART = /^[a-z][a-z0-9_-]{0,31}$/;

export const REPLAY_CAPTURE_LIMITS = {
    maxPlaintextBytes: MAX_PLAINTEXT_BYTES,
    maxObjectBytes: MAX_OBJECT_BYTES,
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
    contentCommitmentSecret: string;
};

export type ReplayFragmentKind = 'provider_payload' | 'normalized_snapshot' | 'execution_trace';
export type ReplayFragmentStage = 'preflight' | 'collection' | 'scoring' | 'finalization';
export type ReplayFragmentInput = {
    captureId: string;
    opaqueLocator: string;
    kind: ReplayFragmentKind;
    stage: ReplayFragmentStage;
    batchOrdinal: number;
    ordinal: number;
    plaintext: Buffer;
    recipientPublicKeyBase64: string;
    contentCommitmentSecret: string;
};
export type ReplayFragmentIdentity = {
    captureId: string;
    opaqueLocatorHash: string;
    kind: ReplayFragmentKind;
    stage: ReplayFragmentStage;
    batchOrdinal: number;
    ordinal: number;
};
export type EncryptedReplayFragment = {
    identity: ReplayFragmentIdentity;
    objectKey: string;
    ciphertext: Buffer;
    ciphertextSha256: string;
    ciphertextByteSize: number;
    recipientKeyFingerprint: string;
    contentCommitment: string;
    envelopeAuthenticator: string;
    storeAuthenticator: string;
    envelopeVersion: 1;
};

type Envelope = {
    v: 1;
    identity: ReplayFragmentIdentity;
    recipientKeyFingerprint: string;
    contentCommitment: string;
    ek: string;
    iv: string;
    tag: string;
    ct: string;
    mac: string;
};
export type ReplayCaptureTransport = {
    putCreateOnly(input: {
        key: string;
        bytes: Buffer;
        sha256: string;
        envelopeAuthenticator: string;
    }): Promise<'created' | 'exists'>;
    get(key: string): Promise<Buffer>;
};
type CommandClient = { send(command: object): Promise<unknown> };
type Dependencies = {
    createTransport?: (config: ReplayCaptureConfig) => ReplayCaptureTransport;
    client?: CommandClient;
};

export class ReplayCaptureError extends Error {
    constructor(readonly code: 'REPLAY_CAPTURE_INVALID_CONFIGURATION' | 'REPLAY_CAPTURE_INVALID_FRAGMENT' | 'REPLAY_CAPTURE_INTEGRITY_FAILURE' | 'REPLAY_CAPTURE_CONFLICT' | 'REPLAY_CAPTURE_TRANSPORT_FAILURE') {
        super(code);
        this.name = 'ReplayCaptureError';
    }
}

function fail(code: ReplayCaptureError['code']): never {
    throw new ReplayCaptureError(code);
}

function validRsaModulusLength(modulusLength: number | undefined): boolean {
    return typeof modulusLength === 'number'
        && modulusLength >= MIN_RSA_MODULUS_BITS
        && modulusLength <= MAX_RSA_MODULUS_BITS;
}

function validR2Config(input: Omit<ReplayCaptureConfig, 'enabled' | 'recipientKeyFingerprint'>): Omit<ReplayCaptureConfig, 'enabled'> {
    let endpoint: URL;
    try { endpoint = new URL(input.endpoint); } catch { return fail('REPLAY_CAPTURE_INVALID_CONFIGURATION'); }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.port
        || endpoint.pathname !== '/' || endpoint.search || endpoint.hash
        || !R2_HOST.test(endpoint.hostname.toLowerCase()) || !BUCKET.test(input.bucket)
        || input.accessKeyId.length < 8 || input.accessKeyId.length > 256
        || input.secretAccessKey.length < 8 || input.secretAccessKey.length > 512
        || typeof input.contentCommitmentSecret !== 'string'
        || input.contentCommitmentSecret.length < 32
        || input.contentCommitmentSecret.length > 512) {
        return fail('REPLAY_CAPTURE_INVALID_CONFIGURATION');
    }
    let recipientKeyFingerprint: string;
    try {
        const pem = Buffer.from(input.recipientPublicKeyBase64, 'base64').toString('utf8');
        const key = createPublicKey(pem);
        if (key.asymmetricKeyType !== 'rsa'
            || !validRsaModulusLength(key.asymmetricKeyDetails?.modulusLength)) {
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
    const contentCommitmentSecret =
        env.ANALYSIS_V2_REPLAY_CAPTURE_CONTENT_COMMITMENT_SECRET?.trim();
    const resultImageBucket = env.ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET?.trim();
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey
        || !recipientPublicKeyBase64 || !contentCommitmentSecret) {
        return fail('REPLAY_CAPTURE_INVALID_CONFIGURATION');
    }
    if (resultImageBucket && resultImageBucket === bucket) return fail('REPLAY_CAPTURE_INVALID_CONFIGURATION');
    return {
        enabled: true,
        ...validR2Config({
            endpoint,
            bucket,
            accessKeyId,
            secretAccessKey,
            recipientPublicKeyBase64,
            contentCommitmentSecret,
        }),
    };
}

function canonicalIdentity(identity: ReplayFragmentIdentity): string {
    return [
        'replay/v1',
        identity.captureId,
        identity.opaqueLocatorHash,
        identity.kind,
        identity.stage,
        String(identity.batchOrdinal),
        String(identity.ordinal),
    ].join('\n');
}

function aad(identity: ReplayFragmentIdentity, contentCommitment: string): Buffer {
    return Buffer.from(
        `${canonicalIdentity(identity)}\n${contentCommitment}`,
        'utf8',
    );
}

type EncryptedEnvelopePayload = {
    ek: Buffer;
    iv: Buffer;
    tag: Buffer;
    ct: Buffer;
};

function updateLengthPrefixed(
    authenticator: ReturnType<typeof createHmac>,
    value: string | Buffer,
): void {
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    authenticator.update(length);
    authenticator.update(bytes);
}

function authenticateEnvelope(
    secret: string,
    envelope: Pick<
        Envelope,
        'v' | 'identity' | 'recipientKeyFingerprint' | 'contentCommitment'
    >,
    payload: EncryptedEnvelopePayload,
): string {
    const authenticator = createHmac('sha256', secret);
    for (const value of [
        'replay-object-envelope-auth-v1',
        String(envelope.v),
        canonicalIdentity(envelope.identity),
        envelope.recipientKeyFingerprint,
        envelope.contentCommitment,
        payload.ek,
        payload.iv,
        payload.tag,
        payload.ct,
    ]) {
        updateLengthPrefixed(authenticator, value);
    }
    return authenticator.digest('hex');
}

function authenticateFragmentForStore(
    secret: string,
    fragment: Pick<
        EncryptedReplayFragment,
        'identity' | 'contentCommitment' | 'ciphertextSha256'
        | 'ciphertextByteSize' | 'recipientKeyFingerprint'
        | 'envelopeAuthenticator' | 'envelopeVersion'
    >,
): string {
    return createHmac('sha256', secret)
        .update([
            'replay-store-auth-v1',
            canonicalIdentity(fragment.identity),
            fragment.contentCommitment,
            fragment.ciphertextSha256,
            String(fragment.ciphertextByteSize),
            fragment.recipientKeyFingerprint,
            fragment.envelopeAuthenticator,
            String(fragment.envelopeVersion),
        ].join('\n'))
        .digest('hex');
}

function authenticatedHexEquals(actual: string, expected: string): boolean {
    if (!SHA256.test(actual) || !SHA256.test(expected)) return false;
    return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function validateIdentity(identity: ReplayFragmentIdentity): void {
    if (!UUID.test(identity.captureId)
        || !SHA256.test(identity.opaqueLocatorHash)
        || !['provider_payload', 'normalized_snapshot', 'execution_trace'].includes(identity.kind)
        || !['preflight', 'collection', 'scoring', 'finalization'].includes(identity.stage)
        || !Number.isSafeInteger(identity.batchOrdinal)
        || identity.batchOrdinal < 0
        || identity.batchOrdinal > 127
        || !Number.isSafeInteger(identity.ordinal)
        || identity.ordinal < 0
        || identity.ordinal > 1023) {
        fail('REPLAY_CAPTURE_INVALID_FRAGMENT');
    }
}

export function replayCaptureObjectKey(identity: ReplayFragmentIdentity): string {
    validateIdentity(identity);
    const identityHash = createHash('sha256')
        .update(canonicalIdentity(identity))
        .digest('hex');
    return `replay/v1/${identity.captureId}/${identityHash}.enc`;
}

function validateInput(input: ReplayFragmentInput): void {
    if (!UUID.test(input.captureId) || !SAFE_PART.test(input.opaqueLocator)
        || !['provider_payload', 'normalized_snapshot', 'execution_trace'].includes(input.kind)
        || !['preflight', 'collection', 'scoring', 'finalization'].includes(input.stage)
        || !Number.isSafeInteger(input.batchOrdinal)
        || input.batchOrdinal < 0
        || input.batchOrdinal > 127
        || !Number.isSafeInteger(input.ordinal)
        || input.ordinal < 0
        || input.ordinal > 1023
        || !Buffer.isBuffer(input.plaintext)
        || input.plaintext.length < 1
        || input.plaintext.length > MAX_PLAINTEXT_BYTES
        || input.contentCommitmentSecret.length < 32
        || input.contentCommitmentSecret.length > 512) {
        fail('REPLAY_CAPTURE_INVALID_FRAGMENT');
    }
}

export function encryptReplayCaptureFragment(input: ReplayFragmentInput): EncryptedReplayFragment {
    validateInput(input);
    let publicKey;
    try { publicKey = createPublicKey(Buffer.from(input.recipientPublicKeyBase64, 'base64').toString('utf8')); } catch { return fail('REPLAY_CAPTURE_INVALID_CONFIGURATION'); }
    if (publicKey.asymmetricKeyType !== 'rsa'
        || !validRsaModulusLength(publicKey.asymmetricKeyDetails?.modulusLength)) {
        fail('REPLAY_CAPTURE_INVALID_CONFIGURATION');
    }
    const recipientKeyFingerprint = createHash('sha256')
        .update(publicKey.export({ type: 'spki', format: 'der' }))
        .digest('hex');
    const identity: ReplayFragmentIdentity = {
        captureId: input.captureId,
        opaqueLocatorHash: createHash('sha256')
            .update(input.opaqueLocator)
            .digest('hex'),
        kind: input.kind,
        stage: input.stage,
        batchOrdinal: input.batchOrdinal,
        ordinal: input.ordinal,
    };
    validateIdentity(identity);
    const contentCommitment = createHmac(
        'sha256',
        input.contentCommitmentSecret,
    )
        .update('replay-content-v1')
        .update('\n')
        .update(input.plaintext)
        .digest('hex');
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(identity, contentCommitment));
    const ciphertext = Buffer.concat([cipher.update(input.plaintext), cipher.final()]);
    const encryptedKey = publicEncrypt({
        key: publicKey,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
    }, key);
    const tag = cipher.getAuthTag();
    const envelopeWithoutAuthenticator = {
        v: 1,
        identity,
        recipientKeyFingerprint,
        contentCommitment,
        ek: encryptedKey.toString('base64'),
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        ct: ciphertext.toString('base64'),
    } as const;
    const envelopeAuthenticator = authenticateEnvelope(
        input.contentCommitmentSecret,
        envelopeWithoutAuthenticator,
        { ek: encryptedKey, iv, tag, ct: ciphertext },
    );
    const envelope: Envelope = {
        ...envelopeWithoutAuthenticator,
        mac: envelopeAuthenticator,
    };
    const bytes = Buffer.from(JSON.stringify(envelope), 'utf8');
    if (bytes.length > MAX_OBJECT_BYTES) fail('REPLAY_CAPTURE_INVALID_FRAGMENT');
    const encrypted = {
        identity,
        objectKey: replayCaptureObjectKey(identity),
        ciphertext: bytes,
        ciphertextSha256: createHash('sha256').update(bytes).digest('hex'),
        ciphertextByteSize: bytes.length,
        recipientKeyFingerprint,
        contentCommitment,
        envelopeAuthenticator,
        envelopeVersion: 1,
    } satisfies Omit<EncryptedReplayFragment, 'storeAuthenticator'>;
    return {
        ...encrypted,
        storeAuthenticator: authenticateFragmentForStore(
            input.contentCommitmentSecret,
            encrypted,
        ),
    };
}

function createR2Transport(config: ReplayCaptureConfig, client: CommandClient = new S3Client({ endpoint: config.endpoint, region: 'auto', credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey } })): ReplayCaptureTransport {
    const safe = async <T>(operation: () => Promise<T>): Promise<T> => {
        try { return await operation(); } catch (error) { if (error instanceof ReplayCaptureError) throw error; return fail('REPLAY_CAPTURE_TRANSPORT_FAILURE'); }
    };
    return {
        putCreateOnly: async ({
            key,
            bytes,
            sha256,
            envelopeAuthenticator,
        }) => {
            validateExactKey(key);
            if (!SHA256.test(sha256)
                || !SHA256.test(envelopeAuthenticator)
                || bytes.length < 1
                || bytes.length > MAX_OBJECT_BYTES) {
                fail('REPLAY_CAPTURE_INVALID_FRAGMENT');
            }
            try {
                await client.send(new PutObjectCommand({
                    Bucket: config.bucket,
                    Key: key,
                    Body: bytes,
                    ContentLength: bytes.length,
                    ContentType: 'application/octet-stream',
                    CacheControl: `private, max-age=${MAX_TTL_SECONDS}`,
                    Metadata: {
                        sha256,
                        envelopeAuthenticator,
                    },
                    IfNoneMatch: '*',
                }));
                return 'created' as const;
            } catch (error) {
                const providerError = error as {
                    name?: string;
                    $metadata?: { httpStatusCode?: number };
                };
                if (providerError.name === 'PreconditionFailed'
                    || providerError.$metadata?.httpStatusCode === 412) {
                    return 'exists' as const;
                }
                return fail('REPLAY_CAPTURE_TRANSPORT_FAILURE');
            }
        },
        get: async (key) => safe(async () => {
            validateExactKey(key);
            const response = await client.send(new GetObjectCommand({
                Bucket: config.bucket,
                Key: key,
                Range: `bytes=0-${MAX_OBJECT_BYTES}`,
            })) as {
                Body?: { transformToByteArray(): Promise<Uint8Array> };
                ContentLength?: number;
            };
            if (!response.Body || !Number.isSafeInteger(response.ContentLength)
                || response.ContentLength! < 1 || response.ContentLength! > MAX_OBJECT_BYTES) {
                fail('REPLAY_CAPTURE_INTEGRITY_FAILURE');
            }
            const bytes = Buffer.from(await response.Body.transformToByteArray());
            if (bytes.length !== response.ContentLength || bytes.length > MAX_OBJECT_BYTES) {
                fail('REPLAY_CAPTURE_INTEGRITY_FAILURE');
            }
            return bytes;
        }),
    };
}
function validateExactKey(key: string): void { if (!OBJECT_KEY.test(key)) fail('REPLAY_CAPTURE_INVALID_FRAGMENT'); }

function decodeCanonicalBase64(value: unknown): Buffer | undefined {
    if (typeof value !== 'string' || value.length < 1) return undefined;
    const decoded = Buffer.from(value, 'base64');
    return decoded.toString('base64') === value ? decoded : undefined;
}

function parseAndValidateEnvelope(
    bytes: Buffer,
    expectedIdentity: ReplayFragmentIdentity,
    recipientKeyFingerprint: string,
    expectedContentCommitment: string,
    contentCommitmentSecret: string,
    errorCode: 'REPLAY_CAPTURE_INTEGRITY_FAILURE' | 'REPLAY_CAPTURE_CONFLICT',
): EncryptedReplayFragment {
    const reject = (): never => fail(errorCode);
    if (bytes.length < 1 || bytes.length > MAX_OBJECT_BYTES) reject();
    let envelope: Envelope;
    try {
        envelope = JSON.parse(bytes.toString('utf8')) as Envelope;
    } catch {
        return reject();
    }
    try {
        validateIdentity(envelope.identity);
    } catch {
        return reject();
    }
    const encryptedKey = decodeCanonicalBase64(envelope.ek);
    const iv = decodeCanonicalBase64(envelope.iv);
    const tag = decodeCanonicalBase64(envelope.tag);
    const ciphertext = decodeCanonicalBase64(envelope.ct);
    if (envelope.v !== 1
        || !SHA256.test(envelope.recipientKeyFingerprint)
        || !SHA256.test(envelope.contentCommitment)
        || !SHA256.test(envelope.mac)) {
        reject();
    }
    if (!encryptedKey) return reject();
    if (!iv) return reject();
    if (!tag) return reject();
    if (!ciphertext) return reject();
    if (encryptedKey.length < 256
        || encryptedKey.length > 1024
        || iv.length !== 12
        || tag.length !== 16
        || ciphertext.length < 1
        || ciphertext.length > MAX_PLAINTEXT_BYTES) {
        reject();
    }
    const expectedEnvelopeAuthenticator = authenticateEnvelope(
        contentCommitmentSecret,
        envelope,
        {
            ek: encryptedKey,
            iv,
            tag,
            ct: ciphertext,
        },
    );
    if (!authenticatedHexEquals(envelope.mac, expectedEnvelopeAuthenticator)
        || canonicalIdentity(envelope.identity) !== canonicalIdentity(expectedIdentity)
        || envelope.recipientKeyFingerprint !== recipientKeyFingerprint
        || envelope.contentCommitment !== expectedContentCommitment) {
        reject();
    }
    const objectKey = replayCaptureObjectKey(expectedIdentity);
    const encrypted = {
        identity: expectedIdentity,
        objectKey,
        ciphertext: bytes,
        ciphertextSha256: createHash('sha256').update(bytes).digest('hex'),
        ciphertextByteSize: bytes.length,
        recipientKeyFingerprint,
        contentCommitment: envelope.contentCommitment,
        envelopeAuthenticator: envelope.mac,
        envelopeVersion: 1,
    } satisfies Omit<EncryptedReplayFragment, 'storeAuthenticator'>;
    return {
        ...encrypted,
        storeAuthenticator: authenticateFragmentForStore(
            contentCommitmentSecret,
            encrypted,
        ),
    };
}

function assertFragmentIntegrity(
    fragment: EncryptedReplayFragment,
    recipientKeyFingerprint: string,
    contentCommitmentSecret: string,
): void {
    validateExactKey(fragment.objectKey);
    let parsed: EncryptedReplayFragment;
    try {
        parsed = parseAndValidateEnvelope(
            fragment.ciphertext,
            fragment.identity,
            recipientKeyFingerprint,
            fragment.contentCommitment,
            contentCommitmentSecret,
            'REPLAY_CAPTURE_INTEGRITY_FAILURE',
        );
    } catch {
        return fail('REPLAY_CAPTURE_INTEGRITY_FAILURE');
    }
    if (!Buffer.isBuffer(fragment.ciphertext)
        || fragment.ciphertext.length < 1
        || fragment.ciphertext.length > MAX_OBJECT_BYTES
        || fragment.ciphertextByteSize !== fragment.ciphertext.length
        || !SHA256.test(fragment.ciphertextSha256)
        || !SHA256.test(fragment.recipientKeyFingerprint)
        || !SHA256.test(fragment.contentCommitment)
        || !SHA256.test(fragment.envelopeAuthenticator)
        || !authenticatedHexEquals(
            fragment.storeAuthenticator,
            authenticateFragmentForStore(contentCommitmentSecret, fragment),
        )
        || fragment.recipientKeyFingerprint !== recipientKeyFingerprint
        || fragment.envelopeAuthenticator !== parsed.envelopeAuthenticator
        || fragment.objectKey !== parsed.objectKey
        || createHash('sha256').update(fragment.ciphertext).digest('hex') !== fragment.ciphertextSha256) {
        fail('REPLAY_CAPTURE_INTEGRITY_FAILURE');
    }
}

export function createReplayCaptureStore(env: Readonly<Record<string, string | undefined>> = process.env, dependencies: Dependencies = {}) {
    const config = loadReplayCaptureConfig(env);
    if (!config.enabled) {
        return {
            enabled: false as const,
            put: async () => undefined,
            get: async () => undefined,
        };
    }
    const transport = dependencies.createTransport?.(config) ?? createR2Transport(config, dependencies.client);
    return {
        enabled: true as const,
        put: async (fragment: EncryptedReplayFragment) => {
            assertFragmentIntegrity(
                fragment,
                config.recipientKeyFingerprint,
                config.contentCommitmentSecret,
            );
            const outcome = await transport.putCreateOnly({
                key: fragment.objectKey,
                bytes: fragment.ciphertext,
                sha256: fragment.ciphertextSha256,
                envelopeAuthenticator: fragment.envelopeAuthenticator,
            });
            if (outcome === 'created') return fragment;
            const existing = await transport.get(fragment.objectKey);
            return parseAndValidateEnvelope(
                existing,
                fragment.identity,
                config.recipientKeyFingerprint,
                fragment.contentCommitment,
                config.contentCommitmentSecret,
                'REPLAY_CAPTURE_CONFLICT',
            );
        },
        get: transport.get,
    };
}
