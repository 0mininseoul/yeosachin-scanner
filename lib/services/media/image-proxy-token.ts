import {
    createCipheriv,
    createDecipheriv,
    createHash,
    createHmac,
} from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import {
    INSTAGRAM_MEDIA_HOST_SUFFIXES,
    matchesAllowedHostSuffix,
} from './secure-image-fetch';

const TOKEN_BUCKET_SECONDS = 15 * 60;
const TOKEN_MAX_FUTURE_SECONDS = TOKEN_BUCKET_SECONDS * 2;
const TOKEN_CLOCK_SKEW_SECONDS = 30;
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,4096}$/;
const RESULT_CANDIDATE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const RESULT_REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_PUBLIC_PROXY_PATH_LENGTH = 2_048;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

const TRACKING_QUERY_PARAMETERS = new Set([
    'dclid',
    'fbclid',
    'gclid',
    'igsh',
    'igshid',
    'mc_cid',
    'mc_eid',
]);

export interface ImageProxyTokenOptions {
    nowMs?: number;
    secret?: string;
}

export type AnalysisV2ResultImageKind = 'target' | 'female' | 'private';

export interface AnalysisV2ResultImageLocator {
    requestId: string;
    kind: AnalysisV2ResultImageKind;
    candidateId: string | null;
}

function getSigningSecret(override?: string): string {
    const secret = override
        ?? process.env.IMAGE_PROXY_SIGNING_SECRET;
    if (!secret || secret.length < 32) {
        throw new Error('IMAGE_PROXY_SIGNING_SECRET must contain at least 32 characters');
    }
    return secret;
}

function encryptionKey(secret: string): Buffer {
    return createHash('sha256')
        .update('image-proxy-encryption-key-v2\n')
        .update(secret)
        .digest();
}

function tokenAad(domain: string, expiresAt: number): Buffer {
    return Buffer.from(`${domain}\n${expiresAt}`, 'utf8');
}

function sealOpaquePayload(
    payload: Buffer,
    domain: string,
    expiresAt: number,
    secret: string
): string {
    const key = encryptionKey(secret);
    const aad = tokenAad(domain, expiresAt);
    const nonce = createHmac('sha256', key)
        .update(domain)
        .update('\n')
        .update(String(expiresAt))
        .update('\n')
        .update(payload)
        .digest()
        .subarray(0, NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

function openOpaquePayload(
    token: string,
    domain: string,
    expiresAt: number,
    secret: string
): Buffer | null {
    if (!OPAQUE_TOKEN_PATTERN.test(token)) return null;
    try {
        const sealed = Buffer.from(token, 'base64url');
        if (sealed.toString('base64url') !== token) return null;
        if (sealed.length <= NONCE_BYTES + AUTH_TAG_BYTES) return null;
        const nonce = sealed.subarray(0, NONCE_BYTES);
        const tag = sealed.subarray(NONCE_BYTES, NONCE_BYTES + AUTH_TAG_BYTES);
        const ciphertext = sealed.subarray(NONCE_BYTES + AUTH_TAG_BYTES);
        const decipher = createDecipheriv(
            'aes-256-gcm',
            encryptionKey(secret),
            nonce
        );
        decipher.setAAD(tokenAad(domain, expiresAt));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
        return null;
    }
}

export function canonicalizeImageProxyUrl(rawUrl: string): string {
    if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 8_192) {
        throw new Error('Image URL is invalid');
    }

    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error('Image URL is invalid');
    }

    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
        throw new Error('Image URL is not allowed');
    }
    if (parsed.port && parsed.port !== '443') {
        throw new Error('Image URL is not allowed');
    }

    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (!INSTAGRAM_MEDIA_HOST_SUFFIXES.some((suffix) => (
        matchesAllowedHostSuffix(hostname, suffix)
    ))) {
        throw new Error('Image URL host is not allowed');
    }

    parsed.hostname = hostname;
    parsed.hash = '';
    for (const key of Array.from(parsed.searchParams.keys())) {
        const normalizedKey = key.toLowerCase();
        if (normalizedKey.startsWith('utm_') || TRACKING_QUERY_PARAMETERS.has(normalizedKey)) {
            parsed.searchParams.delete(key);
        }
    }
    parsed.searchParams.sort();

    return parsed.href;
}

export function createImageProxyPath(
    rawUrl: string | null | undefined,
    options: ImageProxyTokenOptions = {}
): string | undefined {
    if (!rawUrl) return undefined;

    let canonicalUrl: string;
    try {
        canonicalUrl = canonicalizeImageProxyUrl(rawUrl);
    } catch {
        return undefined;
    }

    const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1_000);
    const expiresAt = (Math.floor(nowSeconds / TOKEN_BUCKET_SECONDS) + 2)
        * TOKEN_BUCKET_SECONDS;
    const token = sealOpaquePayload(
        deflateRawSync(Buffer.from(canonicalUrl, 'utf8'), { level: 9 }),
        'image-proxy-url-v2',
        expiresAt,
        getSigningSecret(options.secret)
    );
    const searchParams = new URLSearchParams({
        token,
        expires: String(expiresAt),
    });
    const path = `/api/image-proxy?${searchParams.toString()}`;
    return path.length <= MAX_PUBLIC_PROXY_PATH_LENGTH ? path : undefined;
}

export function verifyImageProxyToken(
    token: string,
    rawExpiresAt: string,
    options: ImageProxyTokenOptions = {}
): string | null {
    if (!/^\d{10}$/.test(rawExpiresAt)) {
        return null;
    }

    const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1_000);
    const expiresAt = Number(rawExpiresAt);
    if (
        expiresAt < nowSeconds - TOKEN_CLOCK_SKEW_SECONDS
        || expiresAt > nowSeconds + TOKEN_MAX_FUTURE_SECONDS + TOKEN_CLOCK_SKEW_SECONDS
    ) {
        return null;
    }

    const compressed = openOpaquePayload(
        token,
        'image-proxy-url-v2',
        expiresAt,
        getSigningSecret(options.secret)
    );
    if (!compressed) return null;

    let rawUrl: string;
    try {
        rawUrl = inflateRawSync(compressed, { maxOutputLength: 8_193 }).toString('utf8');
    } catch {
        return null;
    }
    try {
        const canonicalUrl = canonicalizeImageProxyUrl(rawUrl);
        return canonicalUrl === rawUrl ? canonicalUrl : null;
    } catch {
        return null;
    }
}

function validateResultLocator(
    locator: AnalysisV2ResultImageLocator
): AnalysisV2ResultImageLocator | null {
    const requestId = locator.requestId.toLowerCase();
    if (!RESULT_REQUEST_ID_PATTERN.test(requestId)) return null;
    if (!['target', 'female', 'private'].includes(locator.kind)) return null;
    if (locator.kind === 'target') {
        if (locator.candidateId !== null) return null;
    } else if (!locator.candidateId || !RESULT_CANDIDATE_ID_PATTERN.test(locator.candidateId)) {
        return null;
    }
    return { requestId, kind: locator.kind, candidateId: locator.candidateId };
}

export function createAnalysisV2ResultImageProxyPath(
    locator: AnalysisV2ResultImageLocator,
    options: ImageProxyTokenOptions = {}
): string | undefined {
    const validated = validateResultLocator(locator);
    if (!validated) return undefined;
    const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1_000);
    const expiresAt = (Math.floor(nowSeconds / TOKEN_BUCKET_SECONDS) + 2)
        * TOKEN_BUCKET_SECONDS;
    const payload = Buffer.from(JSON.stringify({
        r: validated.requestId,
        k: validated.kind,
        c: validated.candidateId,
    }), 'utf8');
    const result = sealOpaquePayload(
        payload,
        'image-proxy-result-locator-v1',
        expiresAt,
        getSigningSecret(options.secret)
    );
    const searchParams = new URLSearchParams({ result, expires: String(expiresAt) });
    const path = `/api/image-proxy?${searchParams.toString()}`;
    return path.length <= MAX_PUBLIC_PROXY_PATH_LENGTH ? path : undefined;
}

export function verifyAnalysisV2ResultImageProxyToken(
    token: string,
    rawExpiresAt: string,
    options: ImageProxyTokenOptions = {}
): AnalysisV2ResultImageLocator | null {
    if (!/^\d{10}$/.test(rawExpiresAt)) return null;
    const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1_000);
    const expiresAt = Number(rawExpiresAt);
    if (
        expiresAt < nowSeconds - TOKEN_CLOCK_SKEW_SECONDS
        || expiresAt > nowSeconds + TOKEN_MAX_FUTURE_SECONDS + TOKEN_CLOCK_SKEW_SECONDS
    ) {
        return null;
    }
    const payload = openOpaquePayload(
        token,
        'image-proxy-result-locator-v1',
        expiresAt,
        getSigningSecret(options.secret)
    );
    if (!payload || payload.length > 512) return null;
    try {
        const parsed = JSON.parse(payload.toString('utf8')) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const value = parsed as Record<string, unknown>;
        if (
            Object.keys(value).sort().join(',') !== 'c,k,r'
            || typeof value.r !== 'string'
            || typeof value.k !== 'string'
            || (value.c !== null && typeof value.c !== 'string')
        ) return null;
        return validateResultLocator({
            requestId: value.r,
            kind: value.k as AnalysisV2ResultImageKind,
            candidateId: value.c as string | null,
        });
    } catch {
        return null;
    }
}
