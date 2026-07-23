import { createHash } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';
import {
    MAX_FEATURE_MEDIA,
    MAX_PARTNER_SAFETY_CONTACT_MEDIA,
} from '@/lib/domain/analysis/media-policy';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,159}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GENERATION_PATTERN = /^[1-9][0-9]{0,31}$/;
const BUCKET_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{1,61}[a-z0-9])?$/;
const SELECTION_ID_MAX_LENGTH = 240;

export const ANALYSIS_V2_MEDIA_ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;
export const ANALYSIS_V2_MEDIA_BUNDLE_MAX_BYTES = 32 * 1024 * 1024;
export const ANALYSIS_V2_MEDIA_BUNDLE_MAX_ITEMS = Math.max(
    MAX_FEATURE_MEDIA,
    MAX_PARTNER_SAFETY_CONTACT_MEDIA
);
export const ANALYSIS_V2_MEDIA_ARTIFACT_CLEANUP_CONCURRENCY = 8;
export const ANALYSIS_V2_MEDIA_OBJECT_OPERATION_DEADLINE_MS = 25_000;

export type AnalysisV2MediaArtifactKind = 'jpeg' | 'media_bundle';

export const ANALYSIS_V2_MEDIA_ARTIFACT_DATABASE_NAMES = Object.freeze({
    table: 'analysis_v2_media_artifacts',
    registerRpc: 'register_analysis_v2_media_artifact',
    loadRpc: 'load_analysis_v2_media_artifact',
    claimCleanupRpc: 'claim_analysis_v2_media_artifact_cleanup',
    completeCleanupRpc: 'complete_analysis_v2_media_artifact_cleanup',
});

export interface AnalysisV2MediaArtifactJobFence {
    requestId: string;
    jobKey: string;
    claimToken: string;
}

export interface AnalysisV2MediaArtifactRef {
    requestId: string;
    artifactKey: string;
    artifactKind: AnalysisV2MediaArtifactKind;
    contentSha256: string;
    contentType: 'image/jpeg' | 'application/octet-stream';
    objectName: string;
    objectGeneration: string;
    byteSize: number;
}

export interface AnalysisV2MediaArtifactCleanupRef extends AnalysisV2MediaArtifactRef {
    cleanupToken: string;
}

interface CreatedMediaObject {
    created: boolean;
    generation: string;
}

export interface AnalysisV2PrivateMediaObjectClient {
    create(input: {
        objectName: string;
        bytes: Buffer;
        artifactKey: string;
        artifactKind: AnalysisV2MediaArtifactKind;
        contentSha256: string;
        contentType: AnalysisV2MediaArtifactRef['contentType'];
    }): Promise<CreatedMediaObject>;
    read(input: Pick<
        AnalysisV2MediaArtifactRef,
        'objectName' | 'objectGeneration' | 'byteSize'
    >):
        Promise<Buffer>;
    delete(input: Pick<AnalysisV2MediaArtifactRef, 'objectName' | 'objectGeneration'>):
        Promise<void>;
}

export interface AnalysisV2MediaArtifactRegistry {
    register(input: AnalysisV2MediaArtifactJobFence & AnalysisV2MediaArtifactRef):
        Promise<AnalysisV2MediaArtifactRef>;
    load(input: AnalysisV2MediaArtifactJobFence & { artifactKey: string }):
        Promise<AnalysisV2MediaArtifactRef | null>;
    claimCleanup(limit?: number, leaseSeconds?: number):
        Promise<AnalysisV2MediaArtifactCleanupRef[]>;
    completeCleanup(input: AnalysisV2MediaArtifactCleanupRef): Promise<boolean>;
}

export interface AnalysisV2MediaArtifactStore {
    persist(input: AnalysisV2MediaArtifactJobFence & {
        selectionId: string;
        normalizedJpeg: Buffer;
    }): Promise<AnalysisV2MediaArtifactRef>;
    load(input: AnalysisV2MediaArtifactJobFence & { selectionId: string }): Promise<Buffer | null>;
    persistBundle(input: AnalysisV2MediaArtifactJobFence & {
        bundleId: string;
        media: readonly AnalysisV2NormalizedMediaBundleItem[];
    }): Promise<AnalysisV2MediaArtifactRef>;
    loadBundle(input: AnalysisV2MediaArtifactJobFence & {
        bundleId: string;
        expectedSelectionIds: readonly string[];
    }): Promise<AnalysisV2LoadedMediaBundleItem[] | null>;
    cleanupTerminal(input?: {
        limit?: number;
        leaseSeconds?: number;
        maxBatches?: number;
    }): Promise<{
        claimed: number;
        deleted: number;
        failed: number;
    }>;
}

export interface AnalysisV2NormalizedMediaBundleItem {
    selectionId: string;
    normalizedJpeg: Buffer;
}

export interface AnalysisV2LoadedMediaBundleItem {
    selectionId: string;
    normalizedJpeg: Buffer;
}

interface RpcError {
    code?: string;
    message?: string;
}

interface RpcResult {
    data: unknown;
    error: RpcError | null;
}

export interface AnalysisV2MediaArtifactSupabaseClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<RpcResult>;
}

const lazySupabaseAdminClient: AnalysisV2MediaArtifactSupabaseClient = {
    async rpc(name, params) {
        const { supabaseAdmin } = await import('@/lib/supabase/admin');
        return supabaseAdmin.rpc(name, params);
    },
};

function sha256(value: string | Buffer): string {
    return createHash('sha256').update(value).digest('hex');
}

export function analysisV2MediaArtifactKey(selectionId: string): string {
    const normalized = selectionId.trim();
    if (!normalized || normalized.length > SELECTION_ID_MAX_LENGTH) {
        throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_VALIDATION_ERROR: invalid selection id.');
    }
    return sha256(`analysis-v2-media-artifact-key:v1\n${normalized}`);
}

export function analysisV2MediaBundleArtifactKey(bundleId: string): string {
    const normalized = bundleId.trim();
    if (!normalized || normalized.length > SELECTION_ID_MAX_LENGTH) {
        throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_VALIDATION_ERROR: invalid bundle id.');
    }
    return sha256(`analysis-v2-media-bundle-key:v1\n${normalized}`);
}

export function analysisV2MediaArtifactObjectName(input: {
    requestId: string;
    artifactKey: string;
    contentSha256: string;
    artifactKind?: AnalysisV2MediaArtifactKind;
}): string {
    const requestId = normalizedUuid(input.requestId, 'request id');
    requiredHash(input.artifactKey, 'artifact key');
    requiredHash(input.contentSha256, 'content hash');
    const extension = (input.artifactKind ?? 'jpeg') === 'jpeg' ? 'jpg' : 'bin';
    return `analysis-v2/${requestId}/${input.artifactKey}/${input.contentSha256}.${extension}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizedUuid(value: unknown, field: string): string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
        throw new Error(`ANALYSIS_V2_MEDIA_ARTIFACT_VALIDATION_ERROR: invalid ${field}.`);
    }
    return value.toLowerCase();
}

function requiredJobKey(value: unknown): string {
    if (typeof value !== 'string' || !JOB_KEY_PATTERN.test(value)) {
        throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_VALIDATION_ERROR: invalid job key.');
    }
    return value;
}

function requiredHash(value: unknown, field: string): string {
    if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
        throw new Error(`ANALYSIS_V2_MEDIA_ARTIFACT_VALIDATION_ERROR: invalid ${field}.`);
    }
    return value;
}

function requiredGeneration(value: unknown): string {
    if (typeof value !== 'string' || !GENERATION_PATTERN.test(value)) {
        throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_PERSISTENCE_ERROR: invalid generation.');
    }
    return value;
}

function requiredArtifactKind(value: unknown): AnalysisV2MediaArtifactKind {
    if (value !== 'jpeg' && value !== 'media_bundle') {
        throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_PERSISTENCE_ERROR: invalid artifact kind.');
    }
    return value;
}

function contentTypeFor(kind: AnalysisV2MediaArtifactKind): AnalysisV2MediaArtifactRef['contentType'] {
    return kind === 'jpeg' ? 'image/jpeg' : 'application/octet-stream';
}

function maximumBytesFor(kind: AnalysisV2MediaArtifactKind): number {
    return kind === 'jpeg'
        ? ANALYSIS_V2_MEDIA_ARTIFACT_MAX_BYTES
        : ANALYSIS_V2_MEDIA_BUNDLE_MAX_BYTES;
}

function requiredByteSize(value: unknown, kind: AnalysisV2MediaArtifactKind): number {
    const minimum = kind === 'jpeg' ? 4 : 16;
    if (
        typeof value !== 'number'
        || !Number.isSafeInteger(value)
        || value < minimum
        || value > maximumBytesFor(kind)
    ) {
        throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_PERSISTENCE_ERROR: invalid byte size.');
    }
    return value;
}

function assertJpeg(bytes: Buffer): void {
    if (
        bytes.length < 4
        || bytes.length > ANALYSIS_V2_MEDIA_ARTIFACT_MAX_BYTES
        || bytes[0] !== 0xff
        || bytes[1] !== 0xd8
        || bytes[bytes.length - 2] !== 0xff
        || bytes[bytes.length - 1] !== 0xd9
    ) {
        throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_VALIDATION_ERROR: invalid normalized JPEG.');
    }
}

function assertFence(input: AnalysisV2MediaArtifactJobFence): AnalysisV2MediaArtifactJobFence {
    return {
        requestId: normalizedUuid(input.requestId, 'request id'),
        jobKey: requiredJobKey(input.jobKey),
        claimToken: normalizedUuid(input.claimToken, 'claim token'),
    };
}

function parseArtifactRef(value: unknown): AnalysisV2MediaArtifactRef {
    if (!isRecord(value)) {
        throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_PERSISTENCE_ERROR: invalid artifact.');
    }
    const result = {
        requestId: normalizedUuid(value.requestId, 'request id'),
        artifactKey: requiredHash(value.artifactKey, 'artifact key'),
        artifactKind: requiredArtifactKind(value.artifactKind),
        contentSha256: requiredHash(value.contentSha256, 'content hash'),
        contentType: value.contentType,
        objectName: value.objectName,
        objectGeneration: requiredGeneration(value.objectGeneration),
        byteSize: 0,
    };
    result.byteSize = requiredByteSize(value.byteSize, result.artifactKind);
    if (
        result.contentType !== contentTypeFor(result.artifactKind)
        ||
        typeof result.objectName !== 'string'
        || result.objectName !== analysisV2MediaArtifactObjectName(result)
    ) {
        throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_PERSISTENCE_ERROR: invalid object name.');
    }
    return result as AnalysisV2MediaArtifactRef;
}

function artifactRefsEqual(
    left: AnalysisV2MediaArtifactRef,
    right: AnalysisV2MediaArtifactRef
): boolean {
    return left.requestId === right.requestId
        && left.artifactKey === right.artifactKey
        && left.artifactKind === right.artifactKind
        && left.contentSha256 === right.contentSha256
        && left.contentType === right.contentType
        && left.objectName === right.objectName
        && left.objectGeneration === right.objectGeneration
        && left.byteSize === right.byteSize;
}

function parseCleanupRef(value: unknown): AnalysisV2MediaArtifactCleanupRef {
    if (!isRecord(value)) {
        throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_PERSISTENCE_ERROR: invalid cleanup artifact.');
    }
    return {
        ...parseArtifactRef(value),
        cleanupToken: normalizedUuid(value.cleanupToken, 'cleanup token'),
    };
}

function safeRpcCode(error: RpcError): string {
    return typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'unknown';
}

function throwRpcError(error: RpcError, operation: string): never {
    const allowlisted = new Set([
        'ANALYSIS_V2_MEDIA_ARTIFACT_INVALID',
        'ANALYSIS_V2_MEDIA_ARTIFACT_FENCE_MISMATCH',
        'ANALYSIS_V2_MEDIA_ARTIFACT_CONFLICT',
        'ANALYSIS_V2_MEDIA_ARTIFACT_CLEANUP_FENCE_MISMATCH',
    ]);
    if (error.message && allowlisted.has(error.message)) {
        throw new Error(error.message);
    }
    throw new Error(
        `ANALYSIS_V2_MEDIA_ARTIFACT_PERSISTENCE_ERROR: ${operation} failed (${safeRpcCode(error)}).`
    );
}

export function createAnalysisV2MediaArtifactRegistry(
    client: AnalysisV2MediaArtifactSupabaseClient = lazySupabaseAdminClient
): AnalysisV2MediaArtifactRegistry {
    return {
        async register(input) {
            const fence = assertFence(input);
            const expected = parseArtifactRef(input);
            const { data, error } = await client.rpc(
                ANALYSIS_V2_MEDIA_ARTIFACT_DATABASE_NAMES.registerRpc,
                {
                    p_request_id: fence.requestId,
                    p_job_key: fence.jobKey,
                    p_claim_token: fence.claimToken,
                    p_artifact_key: expected.artifactKey,
                    p_artifact_kind: expected.artifactKind,
                    p_content_sha256: expected.contentSha256,
                    p_content_type: expected.contentType,
                    p_object_name: expected.objectName,
                    p_object_generation: expected.objectGeneration,
                    p_byte_size: expected.byteSize,
                }
            );
            if (error) throwRpcError(error, 'register');
            const stored = parseArtifactRef(data);
            if (JSON.stringify(stored) !== JSON.stringify(expected)) {
                throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_PERSISTENCE_ERROR: register drift.');
            }
            return stored;
        },

        async load(input) {
            const fence = assertFence(input);
            const artifactKey = requiredHash(input.artifactKey, 'artifact key');
            const { data, error } = await client.rpc(
                ANALYSIS_V2_MEDIA_ARTIFACT_DATABASE_NAMES.loadRpc,
                {
                    p_request_id: fence.requestId,
                    p_job_key: fence.jobKey,
                    p_claim_token: fence.claimToken,
                    p_artifact_key: artifactKey,
                }
            );
            if (error) throwRpcError(error, 'load');
            if (data === null) return null;
            const stored = parseArtifactRef(data);
            if (stored.requestId !== fence.requestId || stored.artifactKey !== artifactKey) {
                throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_PERSISTENCE_ERROR: load drift.');
            }
            return stored;
        },

        async claimCleanup(limit = 100, leaseSeconds = 300) {
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
                throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_VALIDATION_ERROR: invalid cleanup limit.');
            }
            if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 900) {
                throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_VALIDATION_ERROR: invalid cleanup lease.');
            }
            const { data, error } = await client.rpc(
                ANALYSIS_V2_MEDIA_ARTIFACT_DATABASE_NAMES.claimCleanupRpc,
                { p_limit: limit, p_lease_seconds: leaseSeconds }
            );
            if (error) throwRpcError(error, 'claim cleanup');
            if (!Array.isArray(data) || data.length > limit) {
                throw new Error(
                    'ANALYSIS_V2_MEDIA_ARTIFACT_PERSISTENCE_ERROR: invalid cleanup batch.'
                );
            }
            return data.map(parseCleanupRef);
        },

        async completeCleanup(input) {
            const artifact = parseCleanupRef(input);
            const { data, error } = await client.rpc(
                ANALYSIS_V2_MEDIA_ARTIFACT_DATABASE_NAMES.completeCleanupRpc,
                {
                    p_request_id: artifact.requestId,
                    p_artifact_key: artifact.artifactKey,
                    p_object_generation: artifact.objectGeneration,
                    p_cleanup_token: artifact.cleanupToken,
                }
            );
            if (error) throwRpcError(error, 'complete cleanup');
            if (typeof data !== 'boolean') {
                throw new Error(
                    'ANALYSIS_V2_MEDIA_ARTIFACT_PERSISTENCE_ERROR: invalid cleanup result.'
                );
            }
            return data;
        },
    };
}

function gcsStatusCode(error: unknown): number | null {
    if (!isRecord(error)) return null;
    const code = error.code;
    if (typeof code === 'number' && Number.isSafeInteger(code)) return code;
    const response = error.response;
    if (!isRecord(response)) return null;
    const status = response.status;
    return typeof status === 'number' && Number.isSafeInteger(status) ? status : null;
}

function throwSafeGcsError(error: unknown, operation: string): never {
    const status = gcsStatusCode(error);
    const safeStatus = status !== null && status >= 100 && status <= 599
        ? String(status)
        : 'unknown';
    throw new Error(
        `ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR: ${operation} failed (${safeStatus}).`
    );
}

interface GoogleCloudStorageObjectMetadata {
    name?: unknown;
    generation?: unknown;
    size?: unknown;
    contentType?: unknown;
}

interface GoogleCloudStorageRequestOptions {
    url: string;
    method: 'GET' | 'POST' | 'DELETE';
    params?: Record<string, string>;
    headers?: Record<string, string>;
    data?: Buffer;
    responseType?: 'json' | 'arraybuffer';
    timeout?: number;
    maxContentLength?: number;
    signal?: AbortSignal;
    retry?: boolean;
    retryConfig?: {
        retry: number;
        noResponseRetries: number;
        httpMethodsToRetry: string[];
        statusCodesToRetry: number[][];
        totalTimeout: number;
    };
}

export interface GoogleCloudStorageAuthorizedRequester {
    request<T>(options: GoogleCloudStorageRequestOptions): Promise<{ data: T }>;
}

function verifiedObjectMetadata(
    metadata: GoogleCloudStorageObjectMetadata,
    expected: { objectName: string; contentType: string; byteSize: number }
): string {
    const generation = requiredGeneration(metadata.generation);
    const size = typeof metadata.size === 'string' ? Number(metadata.size) : metadata.size;
    if (
        metadata.name !== expected.objectName
        || metadata.contentType !== expected.contentType
        || size !== expected.byteSize
    ) {
        throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR: metadata mismatch.');
    }
    return generation;
}

function encodedObjectName(objectName: string): string {
    return encodeURIComponent(objectName);
}

function parseObjectNameIdentity(objectName: string): {
    requestId: string;
    artifactKey: string;
    contentSha256: string;
    artifactKind: AnalysisV2MediaArtifactKind;
} {
    const match = objectName.match(
        /^analysis-v2\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([a-f0-9]{64})\/([a-f0-9]{64})\.(jpg|bin)$/
    );
    if (!match) {
        throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_VALIDATION_ERROR: object name mismatch.');
    }
    const artifactKind = match[4] === 'jpg' ? 'jpeg' : 'media_bundle';
    const identity = {
        requestId: match[1],
        artifactKey: match[2],
        contentSha256: match[3],
        artifactKind,
    } satisfies Parameters<typeof analysisV2MediaArtifactObjectName>[0];
    if (objectName !== analysisV2MediaArtifactObjectName(identity)) {
        throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_VALIDATION_ERROR: object name mismatch.');
    }
    return identity;
}

function assertObjectCreateIdentity(input: {
    objectName: string;
    bytes: Buffer;
    artifactKey: string;
    artifactKind: AnalysisV2MediaArtifactKind;
    contentSha256: string;
}): void {
    const artifactKey = requiredHash(input.artifactKey, 'artifact key');
    const contentSha256 = requiredHash(input.contentSha256, 'content hash');
    if (sha256(input.bytes) !== contentSha256) {
        throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_VALIDATION_ERROR: content hash mismatch.');
    }
    const objectIdentity = parseObjectNameIdentity(input.objectName);
    if (
        objectIdentity.artifactKey !== artifactKey
        || objectIdentity.contentSha256 !== contentSha256
        || objectIdentity.artifactKind !== input.artifactKind
    ) {
        throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_VALIDATION_ERROR: object name mismatch.');
    }
}

function mediaBytes(value: unknown): Buffer {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof ArrayBuffer) return Buffer.from(value);
    if (value instanceof Uint8Array) return Buffer.from(value);
    throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR: invalid media response.');
}

const MEDIA_BUNDLE_MAGIC = Buffer.from('ABMEDIA2', 'ascii');
const MEDIA_BUNDLE_HEADER_BYTES = 4;
const MEDIA_BUNDLE_MAX_HEADER_BYTES = 16 * 1024;

interface MediaBundleHeaderItem {
    artifactKey: string;
    contentSha256: string;
    byteSize: number;
}

function parseBundleHeader(value: unknown): MediaBundleHeaderItem[] {
    if (
        !Array.isArray(value)
        || value.length < 1
        || value.length > ANALYSIS_V2_MEDIA_BUNDLE_MAX_ITEMS
    ) {
        throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR: invalid bundle header.');
    }
    const parsed = value.map(item => {
        if (
            !isRecord(item)
            || Object.keys(item).sort().join(',') !== 'artifactKey,byteSize,contentSha256'
        ) {
            throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR: invalid bundle item.');
        }
        const artifactKey = requiredHash(item.artifactKey, 'bundle artifact key');
        const contentSha256 = requiredHash(item.contentSha256, 'bundle content hash');
        const byteSize = requiredByteSize(item.byteSize, 'jpeg');
        return { artifactKey, contentSha256, byteSize };
    });
    if (new Set(parsed.map(item => item.artifactKey)).size !== parsed.length) {
        throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR: duplicate bundle item.');
    }
    return parsed;
}

export function serializeAnalysisV2MediaBundle(
    media: readonly AnalysisV2NormalizedMediaBundleItem[]
): Buffer {
    if (media.length < 1 || media.length > ANALYSIS_V2_MEDIA_BUNDLE_MAX_ITEMS) {
        throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_VALIDATION_ERROR: invalid bundle size.');
    }
    const seen = new Set<string>();
    const header: MediaBundleHeaderItem[] = media.map(item => {
        assertJpeg(item.normalizedJpeg);
        const artifactKey = analysisV2MediaArtifactKey(item.selectionId);
        if (seen.has(artifactKey)) {
            throw new Error(
                'ANALYSIS_V2_MEDIA_ARTIFACT_VALIDATION_ERROR: duplicate bundle selection.'
            );
        }
        seen.add(artifactKey);
        return {
            artifactKey,
            contentSha256: sha256(item.normalizedJpeg),
            byteSize: item.normalizedJpeg.length,
        };
    });
    const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
    if (headerBytes.length > MEDIA_BUNDLE_MAX_HEADER_BYTES) {
        throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_VALIDATION_ERROR: bundle header too large.');
    }
    const headerLength = Buffer.allocUnsafe(MEDIA_BUNDLE_HEADER_BYTES);
    headerLength.writeUInt32BE(headerBytes.length);
    const totalBytes = MEDIA_BUNDLE_MAGIC.length
        + MEDIA_BUNDLE_HEADER_BYTES
        + headerBytes.length
        + media.reduce((sum, item) => sum + item.normalizedJpeg.length, 0);
    if (totalBytes > ANALYSIS_V2_MEDIA_BUNDLE_MAX_BYTES) {
        throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_VALIDATION_ERROR: media bundle too large.');
    }
    const bundle = Buffer.concat([
        MEDIA_BUNDLE_MAGIC,
        headerLength,
        headerBytes,
        ...media.map(item => item.normalizedJpeg),
    ], totalBytes);
    return bundle;
}

export function deserializeAnalysisV2MediaBundle(
    bundle: Buffer,
    expectedSelectionIds: readonly string[]
): AnalysisV2LoadedMediaBundleItem[] {
    if (
        bundle.length < MEDIA_BUNDLE_MAGIC.length + MEDIA_BUNDLE_HEADER_BYTES + 2
        || bundle.length > ANALYSIS_V2_MEDIA_BUNDLE_MAX_BYTES
        || !bundle.subarray(0, MEDIA_BUNDLE_MAGIC.length).equals(MEDIA_BUNDLE_MAGIC)
        || expectedSelectionIds.length < 1
        || expectedSelectionIds.length > ANALYSIS_V2_MEDIA_BUNDLE_MAX_ITEMS
    ) {
        throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR: invalid media bundle.');
    }
    const expectedKeys = expectedSelectionIds.map(analysisV2MediaArtifactKey);
    if (new Set(expectedKeys).size !== expectedKeys.length) {
        throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR: duplicate expected selection.');
    }
    const headerStart = MEDIA_BUNDLE_MAGIC.length + MEDIA_BUNDLE_HEADER_BYTES;
    const headerLength = bundle.readUInt32BE(MEDIA_BUNDLE_MAGIC.length);
    if (
        headerLength < 2
        || headerLength > MEDIA_BUNDLE_MAX_HEADER_BYTES
        || headerStart + headerLength > bundle.length
    ) {
        throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR: invalid bundle header.');
    }
    let rawHeader: unknown;
    try {
        rawHeader = JSON.parse(bundle.subarray(headerStart, headerStart + headerLength).toString());
    } catch {
        throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR: invalid bundle header.');
    }
    const header = parseBundleHeader(rawHeader);
    if (
        header.length !== expectedKeys.length
        || header.some((item, index) => item.artifactKey !== expectedKeys[index])
    ) {
        throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR: bundle selection mismatch.');
    }
    let offset = headerStart + headerLength;
    const result = header.map((item, index) => {
        const end = offset + item.byteSize;
        if (end > bundle.length) {
            throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR: truncated media bundle.');
        }
        const normalizedJpeg = Buffer.from(bundle.subarray(offset, end));
        offset = end;
        assertJpeg(normalizedJpeg);
        if (sha256(normalizedJpeg) !== item.contentSha256) {
            throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR: bundle content mismatch.');
        }
        return { selectionId: expectedSelectionIds[index], normalizedJpeg };
    });
    if (offset !== bundle.length) {
        throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR: trailing bundle bytes.');
    }
    return result;
}

export function createGoogleCloudPrivateMediaObjectClient(input: {
    bucketName: string;
    requester?: GoogleCloudStorageAuthorizedRequester;
}): AnalysisV2PrivateMediaObjectClient {
    const bucketName = input.bucketName.trim();
    if (!BUCKET_PATTERN.test(bucketName) || bucketName.includes('..')) {
        throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_CONFIG_ERROR: invalid bucket.');
    }
    const requester = input.requester ?? new GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/devstorage.read_write'],
    }) as GoogleCloudStorageAuthorizedRequester;
    const metadataUrl = (objectName: string) =>
        `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucketName)}`
        + `/o/${encodedObjectName(objectName)}`;
    const downloadUrl = (objectName: string) =>
        `https://storage.googleapis.com/download/storage/v1/b/${encodeURIComponent(bucketName)}`
        + `/o/${encodedObjectName(objectName)}`;
    const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/`
        + `${encodeURIComponent(bucketName)}/o`;
    const retryOptions = (method: GoogleCloudStorageRequestOptions['method']) => ({
        retry: true,
        retryConfig: {
            retry: 2,
            noResponseRetries: 2,
            httpMethodsToRetry: [method],
            statusCodesToRetry: [[408, 408], [429, 429], [500, 599]],
            totalTimeout: 20_000,
        },
    });
    return {
        async create(object) {
            const operationSignal = AbortSignal.timeout(
                ANALYSIS_V2_MEDIA_OBJECT_OPERATION_DEADLINE_MS
            );
            if (object.artifactKind === 'jpeg') {
                assertJpeg(object.bytes);
            } else if (
                object.artifactKind !== 'media_bundle'
                || object.bytes.length < 16
                || object.bytes.length > ANALYSIS_V2_MEDIA_BUNDLE_MAX_BYTES
            ) {
                throw new Error(
                    'ANALYSIS_V2_MEDIA_ARTIFACT_VALIDATION_ERROR: invalid media bundle.'
                );
            }
            if (object.contentType !== contentTypeFor(object.artifactKind)) {
                throw new Error(
                    'ANALYSIS_V2_MEDIA_ARTIFACT_VALIDATION_ERROR: invalid content type.'
                );
            }
            assertObjectCreateIdentity(object);
            let created = false;
            let metadata: GoogleCloudStorageObjectMetadata;
            try {
                const response = await requester.request<GoogleCloudStorageObjectMetadata>({
                    url: uploadUrl,
                    method: 'POST',
                    params: {
                        uploadType: 'media',
                        name: object.objectName,
                        ifGenerationMatch: '0',
                    },
                    headers: {
                        'Content-Type': object.contentType,
                        'Content-Length': String(object.bytes.length),
                    },
                    data: object.bytes,
                    responseType: 'json',
                    timeout: 15_000,
                    signal: operationSignal,
                    ...retryOptions('POST'),
                });
                metadata = response.data;
                created = true;
            } catch (error) {
                if (gcsStatusCode(error) !== 412) throwSafeGcsError(error, 'upload');
                try {
                    const response = await requester.request<GoogleCloudStorageObjectMetadata>({
                        url: metadataUrl(object.objectName),
                        method: 'GET',
                        responseType: 'json',
                        timeout: 15_000,
                        signal: operationSignal,
                        ...retryOptions('GET'),
                    });
                    metadata = response.data;
                } catch (metadataError) {
                    throwSafeGcsError(metadataError, 'existing metadata read');
                }
            }
            const generation = verifiedObjectMetadata(metadata, {
                objectName: object.objectName,
                contentType: object.contentType,
                byteSize: object.bytes.length,
            });
            if (!created) {
                let response: { data: unknown };
                try {
                    response = await requester.request<unknown>({
                        url: downloadUrl(object.objectName),
                        method: 'GET',
                        params: { alt: 'media', generation },
                        responseType: 'arraybuffer',
                        timeout: 15_000,
                        maxContentLength: object.bytes.length,
                        signal: operationSignal,
                        ...retryOptions('GET'),
                    });
                } catch (readError) {
                    throwSafeGcsError(readError, 'existing object read');
                }
                const existingBytes = mediaBytes(response.data);
                if (
                    existingBytes.length !== object.bytes.length
                    || sha256(existingBytes) !== object.contentSha256
                ) {
                    throw new Error(
                        'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR: existing content mismatch.'
                    );
                }
            }
            return {
                created,
                generation,
            };
        },

        async read(object) {
            const generation = requiredGeneration(object.objectGeneration);
            parseObjectNameIdentity(object.objectName);
            if (
                !Number.isSafeInteger(object.byteSize)
                || object.byteSize < 4
                || object.byteSize > ANALYSIS_V2_MEDIA_BUNDLE_MAX_BYTES
            ) {
                throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR: invalid expected size.');
            }
            const operationSignal = AbortSignal.timeout(
                ANALYSIS_V2_MEDIA_OBJECT_OPERATION_DEADLINE_MS
            );
            let response: { data: unknown };
            try {
                response = await requester.request<unknown>({
                    url: downloadUrl(object.objectName),
                    method: 'GET',
                    params: { alt: 'media', generation },
                    responseType: 'arraybuffer',
                    timeout: 15_000,
                    maxContentLength: object.byteSize,
                    signal: operationSignal,
                    ...retryOptions('GET'),
                });
            } catch (error) {
                throwSafeGcsError(error, 'object read');
            }
            const bytes = mediaBytes(response.data);
            if (bytes.length !== object.byteSize) {
                throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR: object size mismatch.');
            }
            return bytes;
        },

        async delete(object) {
            const generation = requiredGeneration(object.objectGeneration);
            parseObjectNameIdentity(object.objectName);
            const operationSignal = AbortSignal.timeout(
                ANALYSIS_V2_MEDIA_OBJECT_OPERATION_DEADLINE_MS
            );
            try {
                await requester.request<unknown>({
                    url: metadataUrl(object.objectName),
                    method: 'DELETE',
                    params: { generation, ifGenerationMatch: generation },
                    timeout: 15_000,
                    signal: operationSignal,
                    ...retryOptions('DELETE'),
                });
            } catch (error) {
                if (gcsStatusCode(error) !== 404) throwSafeGcsError(error, 'object delete');
            }
        },
    };
}

async function runBounded<T>(
    values: readonly T[],
    limit: number,
    task: (value: T) => Promise<void>
): Promise<PromiseSettledResult<void>[]> {
    const results: PromiseSettledResult<void>[] = new Array(values.length);
    let next = 0;
    async function worker(): Promise<void> {
        while (next < values.length) {
            const index = next++;
            try {
                await task(values[index]);
                results[index] = { status: 'fulfilled', value: undefined };
            } catch (reason) {
                results[index] = { status: 'rejected', reason };
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
    return results;
}

const DETERMINISTIC_REGISTRATION_REJECTIONS = new Set([
    'ANALYSIS_V2_MEDIA_ARTIFACT_INVALID',
    'ANALYSIS_V2_MEDIA_ARTIFACT_FENCE_MISMATCH',
    'ANALYSIS_V2_MEDIA_ARTIFACT_CONFLICT',
]);

function isDeterministicRegistrationRejection(error: unknown): boolean {
    return error instanceof Error && DETERMINISTIC_REGISTRATION_REJECTIONS.has(error.message);
}

export function createAnalysisV2MediaArtifactStore(input: {
    registry?: AnalysisV2MediaArtifactRegistry;
    objects: AnalysisV2PrivateMediaObjectClient;
}): AnalysisV2MediaArtifactStore {
    const registry = input.registry ?? createAnalysisV2MediaArtifactRegistry();

    async function deleteCreatedObject(reference: AnalysisV2MediaArtifactRef): Promise<void> {
        try {
            await input.objects.delete(reference);
        } catch {
            // The mandatory private-bucket lifecycle is the asynchronous orphan backstop.
        }
    }

    async function registerObject(
        fence: AnalysisV2MediaArtifactJobFence,
        reference: AnalysisV2MediaArtifactRef,
        created: boolean
    ): Promise<AnalysisV2MediaArtifactRef> {
        try {
            return await registry.register({ ...fence, ...reference });
        } catch (error) {
            if (!created) throw error;
            if (isDeterministicRegistrationRejection(error)) {
                await deleteCreatedObject(reference);
                throw error;
            }

            // The registration transaction may have committed even when its response was lost.
            // Re-read under the same live lease before deciding that this generation is orphaned.
            try {
                const stored = await registry.load({
                    ...fence,
                    artifactKey: reference.artifactKey,
                });
                if (stored && artifactRefsEqual(stored, reference)) return stored;
                if (stored === null) await deleteCreatedObject(reference);
            } catch {
                // An expired lease or unavailable registry makes the outcome ambiguous. Deleting
                // here could destroy a committed generation, so lifecycle cleanup is the backstop.
            }
            throw error;
        }
    }

    return {
        async persist(value) {
            const fence = assertFence(value);
            assertJpeg(value.normalizedJpeg);
            const artifactKey = analysisV2MediaArtifactKey(value.selectionId);
            const contentSha256 = sha256(value.normalizedJpeg);
            const objectName = analysisV2MediaArtifactObjectName({
                requestId: fence.requestId,
                artifactKey,
                contentSha256,
                artifactKind: 'jpeg',
            });
            const object = await input.objects.create({
                objectName,
                bytes: value.normalizedJpeg,
                artifactKey,
                artifactKind: 'jpeg',
                contentSha256,
                contentType: 'image/jpeg',
            });
            const reference: AnalysisV2MediaArtifactRef = {
                requestId: fence.requestId,
                artifactKey,
                artifactKind: 'jpeg',
                contentSha256,
                contentType: 'image/jpeg',
                objectName,
                objectGeneration: object.generation,
                byteSize: value.normalizedJpeg.length,
            };
            return registerObject(fence, reference, object.created);
        },

        async load(value) {
            const fence = assertFence(value);
            const artifactKey = analysisV2MediaArtifactKey(value.selectionId);
            const reference = await registry.load({ ...fence, artifactKey });
            if (!reference) return null;
            if (reference.artifactKind !== 'jpeg' || reference.contentType !== 'image/jpeg') {
                throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR: artifact kind mismatch.');
            }
            const bytes = await input.objects.read(reference);
            assertJpeg(bytes);
            if (bytes.length !== reference.byteSize || sha256(bytes) !== reference.contentSha256) {
                throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR: content mismatch.');
            }
            return bytes;
        },

        async persistBundle(value) {
            const fence = assertFence(value);
            const bytes = serializeAnalysisV2MediaBundle(value.media);
            const artifactKey = analysisV2MediaBundleArtifactKey(value.bundleId);
            const contentSha256 = sha256(bytes);
            const objectName = analysisV2MediaArtifactObjectName({
                requestId: fence.requestId,
                artifactKey,
                contentSha256,
                artifactKind: 'media_bundle',
            });
            const object = await input.objects.create({
                objectName,
                bytes,
                artifactKey,
                artifactKind: 'media_bundle',
                contentSha256,
                contentType: 'application/octet-stream',
            });
            const reference: AnalysisV2MediaArtifactRef = {
                requestId: fence.requestId,
                artifactKey,
                artifactKind: 'media_bundle',
                contentSha256,
                contentType: 'application/octet-stream',
                objectName,
                objectGeneration: object.generation,
                byteSize: bytes.length,
            };
            return registerObject(fence, reference, object.created);
        },

        async loadBundle(value) {
            const fence = assertFence(value);
            const artifactKey = analysisV2MediaBundleArtifactKey(value.bundleId);
            const reference = await registry.load({ ...fence, artifactKey });
            if (!reference) return null;
            if (
                reference.artifactKind !== 'media_bundle'
                || reference.contentType !== 'application/octet-stream'
            ) {
                throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR: artifact kind mismatch.');
            }
            const bytes = await input.objects.read(reference);
            if (bytes.length !== reference.byteSize || sha256(bytes) !== reference.contentSha256) {
                throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR: content mismatch.');
            }
            return deserializeAnalysisV2MediaBundle(bytes, value.expectedSelectionIds);
        },

        async cleanupTerminal(options = {}) {
            const limit = options.limit ?? 500;
            const maxBatches = options.maxBatches ?? 4;
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
                throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_VALIDATION_ERROR: invalid cleanup limit.');
            }
            if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 10) {
                throw new Error(
                    'ANALYSIS_V2_MEDIA_ARTIFACT_VALIDATION_ERROR: invalid cleanup batch count.'
                );
            }

            let claimedCount = 0;
            let deletedCount = 0;
            for (let batch = 0; batch < maxBatches; batch += 1) {
                const claimed = await registry.claimCleanup(limit, options.leaseSeconds);
                if (claimed.length === 0) break;
                const results = await runBounded(
                    claimed,
                    ANALYSIS_V2_MEDIA_ARTIFACT_CLEANUP_CONCURRENCY,
                    async artifact => {
                        await input.objects.delete(artifact);
                        await registry.completeCleanup(artifact);
                    }
                );
                claimedCount += claimed.length;
                deletedCount += results.filter(result => result.status === 'fulfilled').length;
                if (claimed.length < limit) break;
            }
            return {
                claimed: claimedCount,
                deleted: deletedCount,
                failed: claimedCount - deletedCount,
            };
        },
    };
}

export function getAnalysisV2MediaArtifactBucket(
    env: Readonly<Record<string, string | undefined>> = process.env
): string | null {
    const value = env.ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET?.trim();
    if (!value) return null;
    if (!BUCKET_PATTERN.test(value) || value.includes('..')) {
        throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_CONFIG_ERROR: invalid bucket.');
    }
    return value;
}

export function createConfiguredAnalysisV2MediaArtifactStore(
    env: Readonly<Record<string, string | undefined>> = process.env
): AnalysisV2MediaArtifactStore {
    const bucketName = getAnalysisV2MediaArtifactBucket(env);
    if (!bucketName) {
        throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_CONFIG_ERROR: bucket is required.');
    }
    return createAnalysisV2MediaArtifactStore({
        objects: createGoogleCloudPrivateMediaObjectClient({ bucketName }),
    });
}

export async function cleanupConfiguredAnalysisV2TerminalMedia(input: {
    env?: Readonly<Record<string, string | undefined>>;
    store?: AnalysisV2MediaArtifactStore;
} = {}): Promise<{ claimed: number; deleted: number; failed: number }> {
    const env = input.env ?? process.env;
    if (!input.store && !getAnalysisV2MediaArtifactBucket(env)) {
        return { claimed: 0, deleted: 0, failed: 0 };
    }
    const result = await (
        input.store ?? createConfiguredAnalysisV2MediaArtifactStore(env)
    ).cleanupTerminal();
    if (result.failed > 0) {
        throw new Error('ANALYSIS_V2_MEDIA_ARTIFACT_CLEANUP_INCOMPLETE');
    }
    return result;
}
