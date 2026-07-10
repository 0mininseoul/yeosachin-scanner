import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const INSTAGRAM_MEDIA_HOST_SUFFIXES = [
    'instagram.com',
    'cdninstagram.com',
    'fbcdn.net',
    'fbsbx.com',
] as const;

export const TRUSTED_IMAGE_PROXY_HOST_SUFFIXES = ['images.weserv.nl'] as const;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SAFE_IMAGE_CONTENT_TYPES = new Set([
    'application/octet-stream',
    'image/avif',
    'image/gif',
    'image/heic',
    'image/heif',
    'image/jpeg',
    'image/png',
    'image/webp',
]);

export interface ResolvedAddress {
    address: string;
    family: number;
}

export type ResolveHostname = (hostname: string) => Promise<ResolvedAddress[]>;

export interface SecureImageDownloadOptions {
    allowedHostSuffixes: readonly string[];
    fetchImpl?: typeof fetch;
    resolveHostname?: ResolveHostname;
    maxBytes: number;
    timeoutMs: number;
    maxRedirects?: number;
    headers?: HeadersInit;
}

export interface SecureImageDownload {
    bytes: Buffer;
    contentType: string;
    finalUrl: string;
}

async function defaultResolveHostname(hostname: string): Promise<ResolvedAddress[]> {
    return lookup(hostname, { all: true, verbatim: true });
}

export function matchesAllowedHostSuffix(hostname: string, suffix: string): boolean {
    const normalizedSuffix = suffix.toLowerCase().replace(/^\.+|\.+$/g, '');
    return hostname === normalizedSuffix || hostname.endsWith(`.${normalizedSuffix}`);
}

function parseIpv4(address: string): number[] | null {
    const octets = address.split('.');
    if (octets.length !== 4) return null;
    const parsed = octets.map((octet) => Number(octet));
    return parsed.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
        ? parsed
        : null;
}

function parseIpv6(address: string): Uint8Array | null {
    let normalized = address.toLowerCase().split('%', 1)[0];
    const embeddedIpv4 = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (embeddedIpv4) {
        const octets = parseIpv4(embeddedIpv4);
        if (!octets) return null;
        normalized = normalized.slice(0, -embeddedIpv4.length)
            + `${((octets[0] << 8) | octets[1]).toString(16)}:`
            + ((octets[2] << 8) | octets[3]).toString(16);
    }

    const halves = normalized.split('::');
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    if ((halves.length === 1 && missing !== 0) || missing < 0) return null;

    const groups = [
        ...left,
        ...Array.from({ length: missing }, () => '0'),
        ...right,
    ];
    if (groups.length !== 8) return null;

    const bytes = new Uint8Array(16);
    for (let index = 0; index < groups.length; index++) {
        if (!/^[0-9a-f]{1,4}$/.test(groups[index])) return null;
        const value = Number.parseInt(groups[index], 16);
        bytes[index * 2] = value >> 8;
        bytes[index * 2 + 1] = value & 0xff;
    }
    return bytes;
}

function isPublicIpv4(address: string): boolean {
    const octets = parseIpv4(address);
    if (!octets) return false;
    const [a, b, c] = octets;

    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
}

export function isPublicNetworkAddress(address: string): boolean {
    const family = isIP(address);
    if (family === 4) return isPublicIpv4(address);
    if (family !== 6) return false;

    const bytes = parseIpv6(address);
    if (!bytes) return false;
    const allZero = bytes.every((byte) => byte === 0);
    if (allZero) return false;
    const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
    if (loopback) return false;
    if ((bytes[0] & 0xfe) === 0xfc || bytes[0] === 0xfe || bytes[0] === 0xff) return false;
    if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
        return false;
    }

    const ipv4Mapped = bytes.slice(0, 10).every((byte) => byte === 0)
        && bytes[10] === 0xff
        && bytes[11] === 0xff;
    if (ipv4Mapped) {
        return isPublicIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
    }
    return true;
}

function assertPositiveInteger(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
}

export async function validateAllowedRemoteImageUrl(
    rawUrl: string,
    allowedHostSuffixes: readonly string[],
    resolveHostname: ResolveHostname = defaultResolveHostname
): Promise<URL> {
    if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 8_192) {
        throw new Error('Image URL is invalid');
    }

    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error('Image URL is invalid');
    }

    if (parsed.protocol !== 'https:') throw new Error('Image URL must use HTTPS');
    if (parsed.username || parsed.password) throw new Error('Credentialed image URLs are not allowed');
    if (parsed.port && parsed.port !== '443') throw new Error('Non-standard image URL ports are not allowed');

    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (isIP(hostname) !== 0) throw new Error('IP-literal image URLs are not allowed');
    if (!allowedHostSuffixes.some((suffix) => matchesAllowedHostSuffix(hostname, suffix))) {
        throw new Error('Image URL host is not allowed');
    }

    const addresses = await resolveHostname(hostname);
    if (addresses.length === 0 || addresses.some(({ address }) => !isPublicNetworkAddress(address))) {
        throw new Error('Image URL resolved to a non-public address');
    }

    parsed.hostname = hostname;
    parsed.hash = '';
    return parsed;
}

async function cancelBody(response: Response): Promise<void> {
    try {
        await response.body?.cancel();
    } catch {
        // Best effort only; the enclosing AbortController closes the request on failure.
    }
}

export async function downloadSecureImage(
    rawUrl: string,
    options: SecureImageDownloadOptions
): Promise<SecureImageDownload> {
    const {
        allowedHostSuffixes,
        fetchImpl = fetch,
        resolveHostname = defaultResolveHostname,
        maxBytes,
        timeoutMs,
        maxRedirects = 3,
        headers,
    } = options;
    assertPositiveInteger(maxBytes, 'maxBytes');
    assertPositiveInteger(timeoutMs, 'timeoutMs');
    if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) {
        throw new Error('maxRedirects must be an integer from 0 to 10');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const abortPromise = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => {
            reject(new Error(`Image download timed out after ${timeoutMs}ms`));
        }, { once: true });
    });

    try {
        let current = await Promise.race([
            validateAllowedRemoteImageUrl(rawUrl, allowedHostSuffixes, resolveHostname),
            abortPromise,
        ]);
        const visited = new Set<string>();

        for (let redirectCount = 0; ; redirectCount++) {
            if (visited.has(current.href)) throw new Error('Image redirect loop detected');
            visited.add(current.href);

            const response = await Promise.race([
                fetchImpl(current, {
                    method: 'GET',
                    redirect: 'manual',
                    signal: controller.signal,
                    headers,
                }),
                abortPromise,
            ]);

            if (REDIRECT_STATUSES.has(response.status)) {
                await cancelBody(response);
                if (redirectCount >= maxRedirects) throw new Error('Image redirect limit exceeded');
                const location = response.headers.get('location');
                if (!location) throw new Error('Image redirect did not include a location');
                const nextUrl = new URL(location, current);
                current = await Promise.race([
                    validateAllowedRemoteImageUrl(
                        nextUrl.href,
                        allowedHostSuffixes,
                        resolveHostname
                    ),
                    abortPromise,
                ]);
                continue;
            }

            if (!response.ok) {
                await cancelBody(response);
                throw new Error(`Image download failed with status ${response.status}`);
            }

            const contentType = response.headers.get('content-type')
                ?.split(';', 1)[0]
                .trim()
                .toLowerCase() || 'application/octet-stream';
            if (!SAFE_IMAGE_CONTENT_TYPES.has(contentType)) {
                await cancelBody(response);
                throw new Error(`Unsupported image content type: ${contentType}`);
            }

            const rawLength = response.headers.get('content-length');
            if (rawLength !== null) {
                const declaredLength = Number(rawLength);
                if (!Number.isFinite(declaredLength) || declaredLength < 0) {
                    await cancelBody(response);
                    throw new Error('Image content length is invalid');
                }
                if (declaredLength > maxBytes) {
                    await cancelBody(response);
                    throw new Error(`Image exceeds ${maxBytes} byte download limit`);
                }
            }

            if (!response.body) throw new Error('Image response did not include a body');
            const reader = response.body.getReader();
            const chunks: Buffer[] = [];
            let totalBytes = 0;
            try {
                while (true) {
                    const { done, value } = await Promise.race([reader.read(), abortPromise]);
                    if (done) break;
                    totalBytes += value.byteLength;
                    if (totalBytes > maxBytes) {
                        controller.abort();
                        await reader.cancel();
                        throw new Error(`Image exceeds ${maxBytes} byte download limit`);
                    }
                    chunks.push(Buffer.from(value));
                }
            } finally {
                reader.releaseLock();
            }

            return {
                bytes: Buffer.concat(chunks, totalBytes),
                contentType,
                finalUrl: current.href,
            };
        }
    } catch (error) {
        if (controller.signal.aborted && !(error instanceof Error && error.message.includes('byte download limit'))) {
            throw new Error(`Image download timed out after ${timeoutMs}ms`, { cause: error });
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}
