import { pathToFileURL } from 'node:url';
import { createImageProxyPath } from '../lib/services/media/image-proxy-token';

/**
 * This URL is deliberately a non-user fixture. The image proxy must accept
 * its signed token before it can return either the image or the documented
 * retryable upstream-unavailable envelope.
 */
export const IMAGE_PROXY_COMPATIBILITY_FIXTURE_URL =
    'https://cdninstagram.com/analysis-v2-release-gate-fixture.jpg?oe=compatibility';
export const IMAGE_PROXY_COMPATIBILITY_BASE_URL_ENV =
    'ANALYSIS_V2_IMAGE_PROXY_PROBE_BASE_URL';
export const IMAGE_PROXY_SIGNING_SECRET_ENV = 'IMAGE_PROXY_SIGNING_SECRET';

export type ImageProxyCompatibilityStatusCategory =
    | 'signature_accepted_200'
    | 'signature_accepted_503_retryable'
    | 'signature_rejected_403'
    | 'unexpected_status'
    | 'configuration_error'
    | 'network_error';

export interface ImageProxyCompatibilityProbeResult {
    passed: boolean;
    category: ImageProxyCompatibilityStatusCategory;
}

export interface ImageProxyCompatibilityProbeDependencies {
    fetchImpl?: (
        input: string,
        init?: RequestInit,
    ) => Promise<Response>;
}

function validSecret(secret: string | undefined): secret is string {
    return typeof secret === 'string' && secret.length >= 32;
}

function productionOrigin(rawBaseUrl: string | undefined): string | null {
    if (typeof rawBaseUrl !== 'string' || rawBaseUrl.length === 0 || rawBaseUrl.length > 2_048) {
        return null;
    }

    let parsed: URL;
    try {
        parsed = new URL(rawBaseUrl);
    } catch {
        return null;
    }
    if (
        parsed.protocol !== 'https:'
        || parsed.username
        || parsed.password
        || (parsed.port !== '' && parsed.port !== '443')
        || parsed.search
        || parsed.hash
    ) {
        return null;
    }
    return parsed.origin;
}

function retryableImageUnavailablePayload(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const payload = value as { code?: unknown; retryable?: unknown };
    return payload.code === 'IMAGE_UNAVAILABLE' && payload.retryable === true;
}

async function cancelResponseBody(response: Response): Promise<void> {
    try {
        await response.body?.cancel();
    } catch {
        // The probe result is already determined; body cleanup is best effort.
    }
}

async function classifyResponse(
    response: Response,
): Promise<ImageProxyCompatibilityStatusCategory> {
    if (response.status === 200) {
        await cancelResponseBody(response);
        return 'signature_accepted_200';
    }
    if (response.status === 403) {
        await cancelResponseBody(response);
        return 'signature_rejected_403';
    }
    if (response.status !== 503) {
        await cancelResponseBody(response);
        return 'unexpected_status';
    }

    try {
        const payload = await response.json() as unknown;
        return retryableImageUnavailablePayload(payload)
            ? 'signature_accepted_503_retryable'
            : 'unexpected_status';
    } catch {
        return 'unexpected_status';
    }
}

export async function runImageProxySigningSecretCompatibilityProbe(
    options: {
        secret?: string;
        baseUrl?: string;
    } = {},
    dependencies: ImageProxyCompatibilityProbeDependencies = {},
): Promise<ImageProxyCompatibilityProbeResult> {
    const secret = options.secret ?? process.env[IMAGE_PROXY_SIGNING_SECRET_ENV];
    const baseUrl = options.baseUrl
        ?? process.env[IMAGE_PROXY_COMPATIBILITY_BASE_URL_ENV];
    if (!validSecret(secret)) {
        return { passed: false, category: 'configuration_error' };
    }
    const origin = productionOrigin(baseUrl);
    if (!origin) {
        return { passed: false, category: 'configuration_error' };
    }

    let signedPath: string | undefined;
    try {
        signedPath = createImageProxyPath(IMAGE_PROXY_COMPATIBILITY_FIXTURE_URL, { secret });
    } catch {
        return { passed: false, category: 'configuration_error' };
    }
    if (!signedPath) {
        return { passed: false, category: 'configuration_error' };
    }

    const fetchImpl = dependencies.fetchImpl ?? ((input, init) => fetch(input, init));
    let response: Response;
    try {
        response = await fetchImpl(new URL(signedPath, `${origin}/`).href, {
            method: 'GET',
            redirect: 'error',
            cache: 'no-store',
            headers: { Accept: 'image/*, application/json' },
        });
    } catch {
        return { passed: false, category: 'network_error' };
    }

    const category = await classifyResponse(response);
    return {
        passed: category === 'signature_accepted_200'
            || category === 'signature_accepted_503_retryable',
        category,
    };
}

export function formatImageProxyCompatibilityProbeResult(
    result: ImageProxyCompatibilityProbeResult,
): string {
    return `${result.passed ? 'PASS' : 'FAIL'}: image-proxy-signing compatibility ${result.category}\n`;
}

function isDirectExecution(): boolean {
    const entry = process.argv[1];
    return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
    runImageProxySigningSecretCompatibilityProbe()
        .then(result => {
            (process.stdout.write)(formatImageProxyCompatibilityProbeResult(result));
            process.exitCode = result.passed ? 0 : 1;
        })
        .catch(() => {
            process.stdout.write(
                formatImageProxyCompatibilityProbeResult({
                    passed: false,
                    category: 'network_error',
                })
            );
            process.exitCode = 1;
        });
}
