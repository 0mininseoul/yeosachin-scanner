import { createHmac, timingSafeEqual } from 'node:crypto';
import {
    INSTAGRAM_MEDIA_HOST_SUFFIXES,
    matchesAllowedHostSuffix,
} from './secure-image-fetch';

const TOKEN_BUCKET_SECONDS = 15 * 60;
const TOKEN_MAX_FUTURE_SECONDS = TOKEN_BUCKET_SECONDS * 2;
const TOKEN_CLOCK_SKEW_SECONDS = 30;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

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

function getSigningSecret(override?: string): string {
    const secret = override
        ?? process.env.IMAGE_PROXY_SIGNING_SECRET;
    if (!secret || secret.length < 32) {
        throw new Error('IMAGE_PROXY_SIGNING_SECRET must contain at least 32 characters');
    }
    return secret;
}

function tokenPayload(canonicalUrl: string, expiresAt: number): string {
    return `image-proxy-v1\n${expiresAt}\n${canonicalUrl}`;
}

function createSignature(canonicalUrl: string, expiresAt: number, secret: string): string {
    return createHmac('sha256', secret)
        .update(tokenPayload(canonicalUrl, expiresAt))
        .digest('base64url');
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
    const signature = createSignature(
        canonicalUrl,
        expiresAt,
        getSigningSecret(options.secret)
    );
    const searchParams = new URLSearchParams({
        url: canonicalUrl,
        expires: String(expiresAt),
        signature,
    });
    return `/api/image-proxy?${searchParams.toString()}`;
}

export function verifyImageProxyToken(
    rawUrl: string,
    rawExpiresAt: string,
    rawSignature: string,
    options: ImageProxyTokenOptions = {}
): string | null {
    if (!/^\d{10}$/.test(rawExpiresAt) || !SIGNATURE_PATTERN.test(rawSignature)) {
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

    let canonicalUrl: string;
    try {
        canonicalUrl = canonicalizeImageProxyUrl(rawUrl);
    } catch {
        return null;
    }
    if (canonicalUrl !== rawUrl) return null;

    const expected = Buffer.from(createSignature(
        canonicalUrl,
        expiresAt,
        getSigningSecret(options.secret)
    ));
    const supplied = Buffer.from(rawSignature);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        return null;
    }

    return canonicalUrl;
}
