import { NextRequest, NextResponse } from 'next/server';
import {
    downloadSecureImage,
    INSTAGRAM_MEDIA_HOST_SUFFIXES,
    TRUSTED_IMAGE_PROXY_HOST_SUFFIXES,
} from '@/lib/services/media/secure-image-fetch';
import {
    verifyAnalysisV2ResultImageProxyToken,
    verifyImageProxyToken,
} from '@/lib/services/media/image-proxy-token';
import { resolveAnalysisV2ResultImageLocator } from '@/lib/services/media/result-image-resolver';
import { createClient } from '@/lib/supabase/server';

const IMAGE_PROXY_MAX_BYTES = 3 * 1024 * 1024;
const IMAGE_PROXY_TOTAL_TIMEOUT_MS = 6_000;
const IMAGE_PROXY_DIRECT_TIMEOUT_MS = 4_000;
const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/avif,image/*;q=0.8';

const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150" viewBox="0 0 150 150">
  <rect width="150" height="150" fill="#1f2937"/>
  <circle cx="75" cy="55" r="25" fill="#4b5563"/>
  <ellipse cx="75" cy="120" rx="40" ry="30" fill="#4b5563"/>
</svg>`;

function getPlaceholderResponse() {
    return new NextResponse(PLACEHOLDER_SVG, {
        headers: {
            'Content-Type': 'image/svg+xml',
            'Cache-Control': 'private, max-age=300',
            'Content-Length': String(Buffer.byteLength(PLACEHOLDER_SVG)),
            'Content-Security-Policy': "default-src 'none'; sandbox",
            'Cross-Origin-Resource-Policy': 'same-origin',
            'X-Content-Type-Options': 'nosniff',
        },
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

function errorResponse(error: string, status: number) {
    return NextResponse.json({ error }, {
        status,
        headers: { 'Cache-Control': 'private, no-store' },
    });
}

/**
 * Instagram CDN 이미지 프록시 API
 * Instagram CDN URL은 지역 기반이라 Vercel 서버에서 직접 접근이 불가능할 수 있음
 * 직접 접근 실패 시 weserv.nl 프록시를 통해 재시도
 * 모든 시도 실패 시 placeholder 이미지 반환
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

    const authorizedUrl = isGeneric
        ? verifyImageProxyToken(token, expires)
        : await (async () => {
            const locator = verifyAnalysisV2ResultImageProxyToken(token, expires);
            if (!locator) return null;
            const supabase = await createClient();
            const { data: { user }, error } = await supabase.auth.getUser();
            if (error || !user) return null;
            return resolveAnalysisV2ResultImageLocator(locator, user.id);
        })();
    if (!authorizedUrl) {
        return errorResponse('Image proxy token rejected', 403);
    }

    const startedAt = Date.now();
    const remainingTimeoutMs = () => Math.max(
        1,
        IMAGE_PROXY_TOTAL_TIMEOUT_MS - (Date.now() - startedAt)
    );

    try {
        const direct = await downloadSecureImage(authorizedUrl, {
            allowedHostSuffixes: INSTAGRAM_MEDIA_HOST_SUFFIXES,
            maxBytes: IMAGE_PROXY_MAX_BYTES,
            timeoutMs: Math.min(IMAGE_PROXY_DIRECT_TIMEOUT_MS, remainingTimeoutMs()),
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                Accept: IMAGE_ACCEPT,
                Referer: 'https://www.instagram.com/',
            },
        });
        return imageResponse(direct.bytes, direct.contentType, expires, isResult);
    } catch {
        // A trusted image proxy is a compatibility fallback for CDN-region failures.
    }

    if (Date.now() - startedAt >= IMAGE_PROXY_TOTAL_TIMEOUT_MS) {
        return getPlaceholderResponse();
    }

    // Result CDN URLs are private server-side data. Never disclose them to a
    // third-party compatibility proxy when the direct origin is unavailable.
    if (isResult) {
        return getPlaceholderResponse();
    }

    try {
        const proxyUrl = `https://images.weserv.nl/?url=${encodeURIComponent(authorizedUrl)}&default=1`;
        const proxied = await downloadSecureImage(proxyUrl, {
            allowedHostSuffixes: TRUSTED_IMAGE_PROXY_HOST_SUFFIXES,
            maxBytes: IMAGE_PROXY_MAX_BYTES,
            timeoutMs: remainingTimeoutMs(),
            headers: { Accept: IMAGE_ACCEPT },
        });
        return imageResponse(proxied.bytes, proxied.contentType, expires, false);
    } catch {
        return getPlaceholderResponse();
    }
}
