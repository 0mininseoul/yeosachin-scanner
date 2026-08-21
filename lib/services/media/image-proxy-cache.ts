import { createHash } from 'node:crypto';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { loadResultImageR2Config, type ResultImageR2Config } from './r2-result-image-store';

/**
 * Same bucket/endpoint/credentials as the V2 result-image store
 * (loadResultImageR2Config), a distinct key prefix. The result-image store's
 * writer/reader hardcode a webp-only, per-result HMAC-namespaced object-key
 * scheme (v1/{namespace}/{kind}/{id}.webp) that doesn't fit a generic
 * URL-keyed cache holding arbitrary content types, so this uses its own
 * minimal Put/Head/Get calls against the same bucket rather than that
 * scheme - no new bucket, no migration.
 */
const IMAGE_PROXY_CACHE_KEY_PREFIX = 'image-proxy-cache/v1/';
const IMAGE_PROXY_CACHE_MAX_BYTES = 3 * 1024 * 1024;
const IMAGE_PROXY_CACHE_CONTROL = 'private, max-age=86400';

export interface ImageProxyCacheObject {
    bytes: Buffer;
    contentType: string;
}

type ImageProxyCacheCommandClient = {
    send(command: object): Promise<unknown>;
};

export type ImageProxyCacheDependencies = {
    client?: ImageProxyCacheCommandClient;
};

/**
 * Reads CONCIERGE_IMAGE_PROXY_CACHE_ENABLED; default false. Off preserves
 * the generic image-proxy path byte-for-byte - no R2 read or write at all.
 */
export function conciergeImageProxyCacheEnabled(
    raw = process.env.CONCIERGE_IMAGE_PROXY_CACHE_ENABLED,
): boolean {
    return raw === 'true' || raw === '1';
}

/**
 * A stable cache key for an authorized CDN URL: sha256 of origin+pathname
 * only, excluding the query string. Instagram's URL signature (an
 * expiring query parameter) rotates roughly every ~48h, so excluding it
 * lets a re-signed URL for the same image hash to the same key. Returns
 * null for a malformed or non-https URL (never cached).
 */
export function imageProxyCacheKey(authorizedUrl: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(authorizedUrl);
    } catch {
        return null;
    }
    if (parsed.protocol !== 'https:') return null;
    const stable = `${parsed.origin}${parsed.pathname}`;
    return createHash('sha256').update(stable, 'utf8').digest('hex');
}

function objectKeyFor(cacheKey: string): string {
    return `${IMAGE_PROXY_CACHE_KEY_PREFIX}${cacheKey}`;
}

function resolveClient(
    config: ResultImageR2Config,
    dependencies: ImageProxyCacheDependencies,
): ImageProxyCacheCommandClient {
    return dependencies.client ?? new S3Client({
        endpoint: config.endpoint,
        region: 'auto',
        credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
        },
    });
}

async function readBody(response: unknown): Promise<Buffer> {
    const body = (response as {
        Body?: { transformToByteArray?: () => Promise<Uint8Array> };
    }).Body;
    if (!body?.transformToByteArray) {
        throw new Error('IMAGE_PROXY_CACHE_READ_INVALID');
    }
    return Buffer.from(await body.transformToByteArray());
}

/**
 * Best-effort cache read: any failure at all (R2 not configured, object
 * missing, network error, malformed response, oversized payload) resolves
 * to null - a cache miss, never a thrown error. The caller always has a
 * live-fetch or placeholder fallback and must not be blocked by this.
 */
export async function readImageProxyCacheObject(
    cacheKey: string,
    env: Readonly<Record<string, string | undefined>> = process.env,
    dependencies: ImageProxyCacheDependencies = {},
): Promise<ImageProxyCacheObject | null> {
    try {
        const config = loadResultImageR2Config(env);
        const client = resolveClient(config, dependencies);
        const response = await client.send(new GetObjectCommand({
            Bucket: config.bucket,
            Key: objectKeyFor(cacheKey),
        })) as { ContentType?: unknown };
        const contentType = response.ContentType;
        if (typeof contentType !== 'string' || contentType.length === 0) {
            return null;
        }
        const bytes = await readBody(response);
        if (bytes.byteLength === 0 || bytes.byteLength > IMAGE_PROXY_CACHE_MAX_BYTES) {
            return null;
        }
        return { bytes, contentType };
    } catch {
        return null;
    }
}

/**
 * Best-effort cache write: skips the PUT when the key is already cached,
 * and silently swallows any failure (R2 not configured, network error,
 * oversized payload) - a cache-store problem must never surface to the
 * caller or affect the original image response.
 */
export async function writeImageProxyCacheObject(
    cacheKey: string,
    bytes: Buffer,
    contentType: string,
    env: Readonly<Record<string, string | undefined>> = process.env,
    dependencies: ImageProxyCacheDependencies = {},
): Promise<void> {
    if (bytes.byteLength === 0 || bytes.byteLength > IMAGE_PROXY_CACHE_MAX_BYTES) {
        return;
    }
    try {
        const config = loadResultImageR2Config(env);
        const client = resolveClient(config, dependencies);
        const objectKey = objectKeyFor(cacheKey);
        try {
            await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: objectKey }));
            return;
        } catch {
            // Not found (or a transient HEAD failure) - proceed to write.
        }
        await client.send(new PutObjectCommand({
            Bucket: config.bucket,
            Key: objectKey,
            Body: bytes,
            ContentLength: bytes.byteLength,
            ContentType: contentType,
            CacheControl: IMAGE_PROXY_CACHE_CONTROL,
        }));
    } catch {
        // Cache-store failures must never affect the original response.
    }
}
