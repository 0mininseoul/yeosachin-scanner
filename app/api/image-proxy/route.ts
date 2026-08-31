import { NextRequest, NextResponse } from 'next/server';
import {
    downloadSecureImage,
    INSTAGRAM_MEDIA_HOST_SUFFIXES,
    SecureImageFetchError,
    TRUSTED_IMAGE_PROXY_HOST_SUFFIXES,
} from '@/lib/services/media/secure-image-fetch';
import {
    verifyAnalysisV2ResultImageProxyToken,
    verifyImageProxyToken,
} from '@/lib/services/media/image-proxy-token';
import {
    readAnalysisV2ResultImageObject,
    resolveAnalysisV2ResultImageLocator,
    type ResolvedResultImage,
} from '@/lib/services/media/result-image-resolver';
import { isAnalysisResultAuthoritativelyPublished } from '@/lib/services/analysis/result-publication-authority';
import { createClient } from '@/lib/supabase/server';
import {
    conciergeImageProxyCacheEnabled,
    imageProxyCacheKey,
    readImageProxyCacheObject,
    writeImageProxyCacheObject,
} from '@/lib/services/media/image-proxy-cache';
import { isImageProxyClientDisconnectEpipe } from '@/lib/observability/image-proxy-request-error';

const IMAGE_PROXY_MAX_BYTES = 3 * 1024 * 1024;
const IMAGE_PROXY_TOTAL_TIMEOUT_MS = 6_000;
const IMAGE_PROXY_DIRECT_TIMEOUT_MS = 4_000;
const IMAGE_PROXY_CACHE_TIMEOUT_MS = 1_500;
const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/avif,image/*;q=0.8';
const IMAGE_RETRY_AFTER_SECONDS = 3;
const IMAGE_PROXY_FAILURE_LOG_THROTTLE_MS = 60_000;
const imageProxyFailureLogAt = new Map<string, number>();

type ImagePayload = {
    bytes: Buffer;
    contentType: string;
};

type ImageAttempt =
    | { source: 'direct' | 'trusted_proxy'; kind: 'success'; result: ImagePayload }
    | { source: 'direct' | 'trusted_proxy'; kind: 'failure'; error: unknown };

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
    return new Promise(resolve => {
        let settled = false;
        const timeoutId = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve(undefined);
        }, timeoutMs);
        promise.then(value => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            resolve(value);
        }).catch(() => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            resolve(undefined);
        });
    });
}

function withTimeoutReject<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => reject(new SecureImageFetchError(
            'timeout',
            'transient',
            'Image proxy source timed out',
        )), timeoutMs);
        promise.then(value => {
            clearTimeout(timeoutId);
            resolve(value);
        }).catch(error => {
            clearTimeout(timeoutId);
            reject(error);
        });
    });
}

function isSafeImagePayload(payload: ImagePayload): boolean {
    const contentType = payload.contentType.split(';', 1)[0]?.trim().toLowerCase();
    return payload.bytes.byteLength > 0
        && (contentType === 'application/octet-stream'
            || (contentType?.startsWith('image/') === true
                && contentType !== 'image/svg+xml'));
}

function retryableImageUnavailableResponse() {
    return NextResponse.json({
        code: 'IMAGE_UNAVAILABLE',
        error: 'Image temporarily unavailable. Please retry.',
        retryable: true,
    }, {
        status: 503,
        headers: {
            'Cache-Control': 'private, no-store, max-age=0',
            'CDN-Cache-Control': 'private, no-store',
            'Vercel-CDN-Cache-Control': 'private, no-store',
            'Retry-After': String(IMAGE_RETRY_AFTER_SECONDS),
            Vary: 'Cookie',
        },
    });
}

function logImageProxyOutcome(outcome: {
    scope: 'generic' | 'result';
    outcome: 'unavailable' | 'rejected';
    cacheEnabled: boolean;
    elapsedMs: number;
    error?: unknown;
    benignClientDisconnect?: boolean;
}) {
    // The progress rail can request dozens of images at once. Success records
    // add no release-actionable signal, so keep only privacy-safe rejection
    // and final-unavailable warnings for 403/503 monitoring.
    if (outcome.outcome !== 'unavailable' && outcome.outcome !== 'rejected') return;
    if (outcome.benignClientDisconnect === true) return;
    if (process.env.NODE_ENV === 'production') {
        const key = `${outcome.scope}:${outcome.outcome}`;
        const now = Date.now();
        const previous = imageProxyFailureLogAt.get(key);
        if (previous !== undefined && now - previous < IMAGE_PROXY_FAILURE_LOG_THROTTLE_MS) {
            return;
        }
        imageProxyFailureLogAt.set(key, now);
    }
    const safeError = outcome.error instanceof SecureImageFetchError
        ? {
            reason: outcome.error.reason,
            disposition: outcome.error.disposition,
        }
        : outcome.error
            ? { reason: 'unknown', disposition: 'transient' as const }
            : undefined;
    console.warn('[image-proxy]', {
        scope: outcome.scope,
        outcome: outcome.outcome,
        cacheEnabled: outcome.cacheEnabled,
        elapsedMs: Math.max(0, Math.round(outcome.elapsedMs)),
        ...(safeError ? { error: safeError } : {}),
    });
}

function imageCacheHeaders(
    expiresAt: string,
    ownerScoped: boolean
): Record<string, string> {
    if (ownerScoped) {
        return {
            'Cache-Control': 'private, no-store',
            'CDN-Cache-Control': 'private, no-store',
            'Vercel-CDN-Cache-Control': 'private, no-store',
            Vary: 'Cookie',
        };
    }
    const remainingSeconds = Math.max(
        0,
        Number(expiresAt) - Math.ceil(Date.now() / 1_000)
    );
    if (remainingSeconds === 0) {
        return {
            'Cache-Control': 'private, no-store',
            'CDN-Cache-Control': 'private, no-store',
            'Vercel-CDN-Cache-Control': 'private, no-store',
        };
    }

    const browserCache = `public, max-age=${remainingSeconds}, must-revalidate`;
    const cdnCache = `public, s-maxage=${remainingSeconds}, must-revalidate`;
    return {
        'Cache-Control': browserCache,
        'CDN-Cache-Control': cdnCache,
        'Vercel-CDN-Cache-Control': cdnCache,
    };
}

function imageResponse(
    bytes: Buffer,
    contentType: string,
    expiresAt: string,
    ownerScoped: boolean
) {
    return new NextResponse(new Uint8Array(bytes), {
        headers: {
            'Content-Type': contentType,
            'Content-Length': String(bytes.byteLength),
            ...imageCacheHeaders(expiresAt, ownerScoped),
            'Cross-Origin-Resource-Policy': 'same-origin',
            'X-Content-Type-Options': 'nosniff',
        },
    });
}

function retainedImageResponse(
    bytes: Buffer,
    tokenExpiresAt: string,
    objectExpiresAt: string
): NextResponse | null {
    const nowSeconds = Math.ceil(Date.now() / 1_000);
    const tokenRemaining = Number(tokenExpiresAt) - nowSeconds;
    const objectRemaining = Math.floor(
        (Date.parse(objectExpiresAt) - Date.now()) / 1_000
    );
    const maxAge = Math.max(
        0,
        Math.min(tokenRemaining, objectRemaining, 30 * 60)
    );
    if (maxAge === 0) return null;
    return new NextResponse(new Uint8Array(bytes), {
        headers: {
            'Content-Type': 'image/webp',
            'Content-Length': String(bytes.byteLength),
            'Cache-Control':
                `private, max-age=${maxAge}, must-revalidate`,
            'CDN-Cache-Control': 'private, no-store',
            'Vercel-CDN-Cache-Control': 'private, no-store',
            Vary: 'Cookie',
            'Cross-Origin-Resource-Policy': 'same-origin',
            'X-Content-Type-Options': 'nosniff',
        },
    });
}

function errorResponse(error: string, status: number) {
    return NextResponse.json({ error }, {
        status,
        headers: {
            'Cache-Control': 'private, no-store, max-age=0',
            'CDN-Cache-Control': 'private, no-store',
            'Vercel-CDN-Cache-Control': 'private, no-store',
            Vary: 'Cookie',
        },
    });
}

/**
 * Instagram CDN 이미지 프록시 API
 * Instagram CDN URL은 지역 기반이라 Vercel 서버에서 직접 접근이 불가능할 수 있음
 * 직접 접근 실패 시 weserv.nl 프록시를 통해 재시도
 * 모든 시도 실패 시 재시도 가능한 비캐시 오류 반환
 */
export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams;
    const genericParameters = ['token', 'expires'] as const;
    const resultParameters = ['result', 'expires'] as const;
    const parameterNames = Array.from(searchParams.keys());
    const isGeneric = parameterNames.length === genericParameters.length
        && genericParameters.every(name => searchParams.getAll(name).length === 1)
        && parameterNames.every(name => genericParameters.includes(
            name as typeof genericParameters[number]
        ));
    const isResult = parameterNames.length === resultParameters.length
        && resultParameters.every(name => searchParams.getAll(name).length === 1)
        && parameterNames.every(name => resultParameters.includes(
            name as typeof resultParameters[number]
        ));
    if (!isGeneric && !isResult) {
        return errorResponse('Invalid image proxy token', 400);
    }

    const expires = searchParams.get('expires');
    const token = isGeneric ? searchParams.get('token') : searchParams.get('result');
    if (!token || !expires) {
        return errorResponse('Invalid image proxy token', 400);
    }
    const canonicalQuery = new URLSearchParams(
        isGeneric ? { token, expires } : { result: token, expires }
    ).toString();
    if (new URL(request.url).search.slice(1) !== canonicalQuery) {
        return errorResponse('Invalid image proxy token', 400);
    }

    let resolvedResult: ResolvedResultImage | null = null;
    let authorizedUrl: string | null;
    if (isGeneric) {
        authorizedUrl = verifyImageProxyToken(token, expires);
    } else {
        const locator = verifyAnalysisV2ResultImageProxyToken(
            token,
            expires
        );
        if (!locator) {
            logImageProxyOutcome({
                scope: 'result',
                outcome: 'rejected',
                cacheEnabled: false,
                elapsedMs: 0,
            });
            return errorResponse('Image proxy token rejected', 403);
        }
        const supabase = await createClient();
        const { data: { user }, error } = await supabase.auth.getUser();
        if (error || !user) {
            logImageProxyOutcome({
                scope: 'result',
                outcome: 'rejected',
                cacheEnabled: false,
                elapsedMs: 0,
            });
            return errorResponse('Image proxy token rejected', 403);
        }
        try {
            if (!await isAnalysisResultAuthoritativelyPublished(locator.requestId)) {
                logImageProxyOutcome({
                    scope: 'result',
                    outcome: 'rejected',
                    cacheEnabled: false,
                    elapsedMs: 0,
                });
                return errorResponse('Image proxy token rejected', 403);
            }
        } catch {
            logImageProxyOutcome({
                scope: 'result',
                outcome: 'rejected',
                cacheEnabled: false,
                elapsedMs: 0,
            });
            return errorResponse('Image proxy token rejected', 403);
        }
        resolvedResult = await resolveAnalysisV2ResultImageLocator(
            locator,
            user.id
        );
        authorizedUrl = resolvedResult?.source === 'legacy_url'
            ? resolvedResult.url
            : resolvedResult?.source === 'r2'
                ? 'r2:authorized'
                : null;
    }
    if (!authorizedUrl) {
        logImageProxyOutcome({
            scope: isResult ? 'result' : 'generic',
            outcome: 'rejected',
            cacheEnabled: false,
            elapsedMs: 0,
        });
        return errorResponse('Image proxy token rejected', 403);
    }
    if (resolvedResult?.source === 'r2') {
        try {
            const bytes = await readAnalysisV2ResultImageObject(
                resolvedResult
            );
            const response = retainedImageResponse(
                bytes,
                expires,
                resolvedResult.expiresAt
            );
            if (response) return response;
            logImageProxyOutcome({
                scope: 'result',
                outcome: 'unavailable',
                cacheEnabled: false,
                elapsedMs: 0,
            });
            return retryableImageUnavailableResponse();
        } catch {
            logImageProxyOutcome({
                scope: 'result',
                outcome: 'unavailable',
                cacheEnabled: false,
                elapsedMs: 0,
            });
            return retryableImageUnavailableResponse();
        }
    }

    const startedAt = Date.now();
    const remainingTimeoutMs = () => Math.max(
        1,
        IMAGE_PROXY_TOTAL_TIMEOUT_MS - (Date.now() - startedAt)
    );

    const cacheEnabled = !isResult && conciergeImageProxyCacheEnabled();
    const cacheKey = cacheEnabled ? imageProxyCacheKey(authorizedUrl) : null;

    try {
        if (cacheKey) {
            // A cache hit should return before touching the origin. A miss is
            // bounded so a broken object store cannot consume the full image
            // delivery budget.
            const cached = await withTimeout(
                readImageProxyCacheObject(cacheKey),
                Math.min(IMAGE_PROXY_CACHE_TIMEOUT_MS, remainingTimeoutMs()),
            );
            if (cached && isSafeImagePayload(cached)) {
                return imageResponse(cached.bytes, cached.contentType, expires, false);
            }
        }

        const directTimeoutMs = Math.min(IMAGE_PROXY_DIRECT_TIMEOUT_MS, remainingTimeoutMs());
        const directPromise: Promise<ImageAttempt> = withTimeoutReject(downloadSecureImage(authorizedUrl, {
            allowedHostSuffixes: INSTAGRAM_MEDIA_HOST_SUFFIXES,
            maxBytes: IMAGE_PROXY_MAX_BYTES,
            timeoutMs: directTimeoutMs,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                Accept: IMAGE_ACCEPT,
                Referer: 'https://www.instagram.com/',
            },
        }), directTimeoutMs)
            .then(result => ({ source: 'direct' as const, kind: 'success' as const, result }))
            .catch(error => ({ source: 'direct' as const, kind: 'failure' as const, error }));
        const attempts: Array<Promise<ImageAttempt>> = [directPromise];

        // Result CDN URLs are private server-side data and never enter this
        // trusted compatibility proxy branch. Generic progress media gets a
        // concurrent fallback so a slow origin cannot consume all remaining
        // response time before the safe proxy has a chance to respond.
        if (!isResult) {
            const proxyUrl = `https://images.weserv.nl/?url=${encodeURIComponent(authorizedUrl)}`;
            const proxyTimeoutMs = remainingTimeoutMs();
            attempts.push(
                withTimeoutReject(downloadSecureImage(proxyUrl, {
                    allowedHostSuffixes: TRUSTED_IMAGE_PROXY_HOST_SUFFIXES,
                    maxBytes: IMAGE_PROXY_MAX_BYTES,
                    timeoutMs: proxyTimeoutMs,
                    headers: { Accept: IMAGE_ACCEPT },
                }), proxyTimeoutMs)
                    .then(result => ({ source: 'trusted_proxy' as const, kind: 'success' as const, result }))
                    .catch(error => ({ source: 'trusted_proxy' as const, kind: 'failure' as const, error })),
            );
        }

        const first = await Promise.race(attempts);
        const successful = first.kind === 'success' && isSafeImagePayload(first.result)
            ? first
            : (await Promise.all(attempts)).find(result => (
                result.kind === 'success' && isSafeImagePayload(result.result)
            ));

        if (successful?.kind === 'success' && isSafeImagePayload(successful.result)) {
            if (cacheKey) {
                void writeImageProxyCacheObject(
                    cacheKey,
                    successful.result.bytes,
                    successful.result.contentType,
                );
            }
            return imageResponse(
                successful.result.bytes,
                successful.result.contentType,
                expires,
                isResult,
            );
        }

        const failure = first.kind === 'failure'
            ? first.error
            : (await Promise.all(attempts)).find(result => result.kind === 'failure')?.error;
        logImageProxyOutcome({
            scope: isResult ? 'result' : 'generic',
            outcome: 'unavailable',
            cacheEnabled: Boolean(cacheKey),
            elapsedMs: Date.now() - startedAt,
            ...(failure ? { error: failure } : {}),
            benignClientDisconnect: failure
                ? isImageProxyClientDisconnectEpipe(failure, request.signal)
                : false,
        });
        return retryableImageUnavailableResponse();
    } catch (error) {
        logImageProxyOutcome({
            scope: isResult ? 'result' : 'generic',
            outcome: 'unavailable',
            cacheEnabled: Boolean(cacheKey),
            elapsedMs: Date.now() - startedAt,
            error,
            benignClientDisconnect: isImageProxyClientDisconnectEpipe(error, request.signal),
        });
        return retryableImageUnavailableResponse();
    }
}
