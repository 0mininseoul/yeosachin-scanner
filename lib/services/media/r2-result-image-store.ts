import {
    DeleteObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    PutObjectCommand,
    S3Client,
} from '@aws-sdk/client-s3';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { MAX_RESULT_IMAGE_BYTES } from './result-image-normalizer';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const OBJECT_KEY_PATTERN = /^v1\/[0-9a-f]{32}\/(target|female|private)\/[0-9a-f]{32}\.webp$/;
const R2_ENDPOINT_HOST_PATTERN = /(?:^|\.)r2\.cloudflarestorage\.com$/;
const PRIVATE_CACHE_CONTROL = 'private, max-age=86400';

export interface ResultImageR2Config {
    endpoint: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
}

export type ResultImageKind = 'target' | 'female' | 'private';

export type ResultImageObjectKeyInput = {
    requestId: string;
    kind: ResultImageKind;
    candidateId: string | null;
    sourceFingerprint: string;
};

export type ResultImageIntegrity = {
    objectKey: string;
    expectedByteSize: number;
    expectedSha256: string;
};

type ResultImageR2CommandClient = {
    send(command: object): Promise<unknown>;
};

type ResultImageR2Dependencies = {
    client?: ResultImageR2CommandClient;
};

export class ResultImageR2Error extends Error {
    constructor(
        readonly code:
            | 'R2_RESULT_IMAGE_INVALID_CONFIGURATION'
            | 'R2_RESULT_IMAGE_INVALID_OBJECT_KEY'
            | 'R2_RESULT_IMAGE_INVALID_PAYLOAD'
            | 'R2_RESULT_IMAGE_INTEGRITY_MISMATCH'
            | 'R2_RESULT_IMAGE_OPERATION_FAILED'
    ) {
        super(code);
        this.name = 'ResultImageR2Error';
    }
}

function invalidConfiguration(): never {
    throw new ResultImageR2Error(
        'R2_RESULT_IMAGE_INVALID_CONFIGURATION'
    );
}

function validateConfig(config: ResultImageR2Config): ResultImageR2Config {
    let endpoint: URL;
    try {
        endpoint = new URL(config.endpoint);
    } catch {
        return invalidConfiguration();
    }
    if (
        endpoint.protocol !== 'https:'
        || endpoint.username
        || endpoint.password
        || endpoint.port
        || endpoint.pathname !== '/'
        || endpoint.search
        || endpoint.hash
        || !R2_ENDPOINT_HOST_PATTERN.test(endpoint.hostname.toLowerCase())
        || !BUCKET_PATTERN.test(config.bucket)
        || config.accessKeyId.length < 8
        || config.accessKeyId.length > 256
        || config.secretAccessKey.length < 8
        || config.secretAccessKey.length > 512
    ) {
        return invalidConfiguration();
    }
    return {
        endpoint: endpoint.origin,
        bucket: config.bucket,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
    };
}

export function loadResultImageR2Config(
    env: Readonly<Record<string, string | undefined>> = process.env
): ResultImageR2Config {
    const endpoint = env.ANALYSIS_V2_RESULT_IMAGE_R2_ENDPOINT?.trim();
    const bucket = env.ANALYSIS_V2_RESULT_IMAGE_R2_BUCKET?.trim();
    const accessKeyId =
        env.ANALYSIS_V2_RESULT_IMAGE_R2_ACCESS_KEY_ID?.trim();
    const secretAccessKey =
        env.ANALYSIS_V2_RESULT_IMAGE_R2_SECRET_ACCESS_KEY?.trim();
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
        return invalidConfiguration();
    }
    return validateConfig({
        endpoint,
        bucket,
        accessKeyId,
        secretAccessKey,
    });
}

function hmac128(secret: string, domain: string, value: string): string {
    return createHmac('sha256', secret)
        .update(domain)
        .update('\n')
        .update(value)
        .digest('hex')
        .slice(0, 32);
}

export function resultImageObjectKey(
    input: ResultImageObjectKeyInput,
    hmacSecret: string
): string {
    const requestId = input.requestId.toLowerCase();
    const candidateId = input.candidateId;
    if (
        hmacSecret.length < 32
        || !UUID_PATTERN.test(requestId)
        || !['target', 'female', 'private'].includes(input.kind)
        || !SHA256_PATTERN.test(input.sourceFingerprint)
        || (input.kind === 'target' && candidateId !== null)
        || (
            input.kind !== 'target'
            && (
                typeof candidateId !== 'string'
                || candidateId.length === 0
                || candidateId.length > 128
                || /[\r\n\0]/.test(candidateId)
            )
        )
    ) {
        invalidConfiguration();
    }

    const namespace = hmac128(
        hmacSecret,
        'analysis-namespace',
        requestId
    );
    const objectId = hmac128(
        hmacSecret,
        'result-image',
        `${input.kind}\n${candidateId ?? 'target'}\n${input.sourceFingerprint}`
    );
    return `v1/${namespace}/${input.kind}/${objectId}.webp`;
}

function validateObjectKey(objectKey: string): void {
    if (!OBJECT_KEY_PATTERN.test(objectKey)) {
        throw new ResultImageR2Error(
            'R2_RESULT_IMAGE_INVALID_OBJECT_KEY'
        );
    }
}

function validateDigest(sha256: string): void {
    if (!SHA256_PATTERN.test(sha256)) {
        throw new ResultImageR2Error('R2_RESULT_IMAGE_INVALID_PAYLOAD');
    }
}

function validateByteSize(byteSize: number): void {
    if (
        !Number.isSafeInteger(byteSize)
        || byteSize < 1
        || byteSize > MAX_RESULT_IMAGE_BYTES
    ) {
        throw new ResultImageR2Error('R2_RESULT_IMAGE_INVALID_PAYLOAD');
    }
}

function digestMatches(bytes: Buffer, expectedSha256: string): boolean {
    const actual = createHash('sha256').update(bytes).digest();
    const expected = Buffer.from(expectedSha256, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function assertMetadataIntegrity(
    response: unknown,
    expectedByteSize: number,
    expectedSha256: string
): { byteSize: number; sha256: string } {
    if (!response || typeof response !== 'object') {
        throw new ResultImageR2Error(
            'R2_RESULT_IMAGE_INTEGRITY_MISMATCH'
        );
    }
    const record = response as {
        ContentLength?: unknown;
        ContentType?: unknown;
        Metadata?: Record<string, unknown>;
    };
    const storedHash = record.Metadata?.sha256;
    if (
        record.ContentLength !== expectedByteSize
        || record.ContentType !== 'image/webp'
        || storedHash !== expectedSha256
    ) {
        throw new ResultImageR2Error(
            'R2_RESULT_IMAGE_INTEGRITY_MISMATCH'
        );
    }
    return { byteSize: expectedByteSize, sha256: expectedSha256 };
}

function createClient(config: ResultImageR2Config): S3Client {
    return new S3Client({
        endpoint: config.endpoint,
        region: 'auto',
        credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
        },
    });
}

async function redactedOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (error instanceof ResultImageR2Error) {
            throw error;
        }
        throw new ResultImageR2Error(
            'R2_RESULT_IMAGE_OPERATION_FAILED'
        );
    }
}

function prepareIntegrity(input: ResultImageIntegrity): void {
    validateObjectKey(input.objectKey);
    validateByteSize(input.expectedByteSize);
    validateDigest(input.expectedSha256);
}

export function createResultImageR2Writer(
    rawConfig: ResultImageR2Config,
    dependencies: ResultImageR2Dependencies = {}
) {
    const config = validateConfig(rawConfig);
    const client = dependencies.client ?? createClient(config);

    return {
        async put(input: {
            objectKey: string;
            bytes: Buffer | Uint8Array;
            sha256: string;
        }): Promise<void> {
            validateObjectKey(input.objectKey);
            validateDigest(input.sha256);
            const bytes = Buffer.from(input.bytes);
            validateByteSize(bytes.byteLength);
            if (!digestMatches(bytes, input.sha256)) {
                throw new ResultImageR2Error(
                    'R2_RESULT_IMAGE_INTEGRITY_MISMATCH'
                );
            }
            await redactedOperation(async () => {
                await client.send(new PutObjectCommand({
                    Bucket: config.bucket,
                    Key: input.objectKey,
                    Body: bytes,
                    ContentLength: bytes.byteLength,
                    ContentType: 'image/webp',
                    CacheControl: PRIVATE_CACHE_CONTROL,
                    Metadata: { sha256: input.sha256 },
                }));
            });
        },

        async head(input: ResultImageIntegrity): Promise<{
            byteSize: number;
            sha256: string;
        }> {
            prepareIntegrity(input);
            return redactedOperation(async () => {
                const response = await client.send(new HeadObjectCommand({
                    Bucket: config.bucket,
                    Key: input.objectKey,
                }));
                return assertMetadataIntegrity(
                    response,
                    input.expectedByteSize,
                    input.expectedSha256
                );
            });
        },

        async delete(objectKey: string): Promise<void> {
            validateObjectKey(objectKey);
            await redactedOperation(async () => {
                await client.send(new DeleteObjectCommand({
                    Bucket: config.bucket,
                    Key: objectKey,
                }));
            });
        },
    };
}

async function readBody(response: unknown): Promise<Buffer> {
    if (!response || typeof response !== 'object') {
        throw new ResultImageR2Error(
            'R2_RESULT_IMAGE_INTEGRITY_MISMATCH'
        );
    }
    const body = (response as {
        Body?: { transformToByteArray?: () => Promise<Uint8Array> };
    }).Body;
    if (!body?.transformToByteArray) {
        throw new ResultImageR2Error(
            'R2_RESULT_IMAGE_INTEGRITY_MISMATCH'
        );
    }
    return Buffer.from(await body.transformToByteArray());
}

export function createResultImageR2Reader(
    rawConfig: ResultImageR2Config,
    dependencies: ResultImageR2Dependencies = {}
) {
    const config = validateConfig(rawConfig);
    const client = dependencies.client ?? createClient(config);

    return {
        async head(input: ResultImageIntegrity): Promise<{
            byteSize: number;
            sha256: string;
        }> {
            prepareIntegrity(input);
            return redactedOperation(async () => {
                const response = await client.send(new HeadObjectCommand({
                    Bucket: config.bucket,
                    Key: input.objectKey,
                }));
                return assertMetadataIntegrity(
                    response,
                    input.expectedByteSize,
                    input.expectedSha256
                );
            });
        },

        async get(input: ResultImageIntegrity): Promise<Buffer> {
            prepareIntegrity(input);
            return redactedOperation(async () => {
                const response = await client.send(new GetObjectCommand({
                    Bucket: config.bucket,
                    Key: input.objectKey,
                }));
                assertMetadataIntegrity(
                    response,
                    input.expectedByteSize,
                    input.expectedSha256
                );
                const bytes = await readBody(response);
                if (
                    bytes.byteLength !== input.expectedByteSize
                    || bytes.byteLength > MAX_RESULT_IMAGE_BYTES
                    || !digestMatches(bytes, input.expectedSha256)
                ) {
                    throw new ResultImageR2Error(
                        'R2_RESULT_IMAGE_INTEGRITY_MISMATCH'
                    );
                }
                return bytes;
            });
        },
    };
}
