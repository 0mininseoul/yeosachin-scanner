import sharp from 'sharp';
import type { SelectedAnalysisMedia } from '@/lib/domain/analysis/media-policy';
import { isVertexAICostOptimized } from './gemini-cost';
import {
    MAX_VERTEX_AI_CONCURRENT_IMAGE_DECODES,
    MAX_VERTEX_AI_CONCURRENT_IMAGE_PREPARATIONS,
    MAX_VERTEX_AI_IMAGE_PREPARATION_CONCURRENCY,
} from './pipeline-config';
import {
    downloadSecureImage,
    INSTAGRAM_MEDIA_HOST_SUFFIXES,
    SecureImageFetchError,
    TRUSTED_IMAGE_PROXY_HOST_SUFFIXES,
    validateAllowedRemoteImageUrl,
    type ResolveHostname,
    type SecureImageRequest,
} from '@/lib/services/media/secure-image-fetch';

export const DEFAULT_MAX_ANALYSIS_IMAGES = 11;
export const DEFAULT_MAX_ANALYSIS_POST_IMAGES = 10;
export const DEFAULT_MAX_ANALYSIS_IMAGE_DIMENSION = 1_024;
export const COST_OPTIMIZED_MAX_ANALYSIS_IMAGES = 3;
export const COST_OPTIMIZED_MAX_ANALYSIS_POST_IMAGES = 2;
export const COST_OPTIMIZED_MAX_ANALYSIS_IMAGE_DIMENSION = 384;
export const MAX_IMAGE_DOWNLOAD_BYTES = 8 * 1024 * 1024;
export const IMAGE_DOWNLOAD_TIMEOUT_MS = 5_000;
/** Bounds queue acquisition, download fallback, and native decode for replay capture. */
export const SELECTED_MEDIA_NORMALIZATION_TIMEOUT_MS = 15_000;

export const MAX_DECODED_IMAGE_PIXELS = 16_000_000;

export const ANALYSIS_IMAGE_PREPARATION_FAILURE_REASONS = [
    'invalid_source',
    'blocked_source',
    'source_missing',
    'source_rejected',
    'rate_limited',
    'upstream_unavailable',
    'network_failure',
    'timeout',
    'response_too_large',
    'unsupported_content',
    'invalid_response',
    'decode_failed',
    'empty_output',
] as const;

export type AnalysisImagePreparationFailureReason =
    typeof ANALYSIS_IMAGE_PREPARATION_FAILURE_REASONS[number];
export type AnalysisImagePreparationFailureDisposition = 'transient' | 'permanent';

/** PII-free image preparation failure passed to durable V2 coverage checkpoints. */
export class AnalysisImagePreparationError extends Error {
    constructor(
        readonly reason: AnalysisImagePreparationFailureReason,
        readonly disposition: AnalysisImagePreparationFailureDisposition
    ) {
        super(`ANALYSIS_IMAGE_PREPARATION_${reason.toUpperCase()}`);
        this.name = 'AnalysisImagePreparationError';
    }
}

const TRANSIENT_DOWNLOAD_PATTERNS = [
    /\b(?:econnreset|etimedout|eai_again|enotfound)\b/i,
    /\b(?:network|socket|fetch failed|timed?\s*out|timeout|abort(?:ed|error)?)\b/i,
];

function secureFailureReason(
    error: SecureImageFetchError
): AnalysisImagePreparationFailureReason {
    switch (error.reason) {
        case 'invalid_configuration':
        case 'invalid_url': return 'invalid_source';
        case 'blocked_source': return 'blocked_source';
        case 'invalid_redirect': return 'source_rejected';
        case 'source_missing': return 'source_missing';
        case 'source_rejected': return 'source_rejected';
        case 'rate_limited': return 'rate_limited';
        case 'upstream_unavailable': return 'upstream_unavailable';
        case 'network_failure': return 'network_failure';
        case 'timeout': return 'timeout';
        case 'response_too_large': return 'response_too_large';
        case 'unsupported_content': return 'unsupported_content';
        case 'invalid_response': return 'invalid_response';
    }
}

export function classifyAnalysisImagePreparationError(
    error: unknown,
    phase: 'download' | 'decode'
): AnalysisImagePreparationError {
    if (error instanceof AnalysisImagePreparationError) return error;
    if (error instanceof SecureImageFetchError) {
        return new AnalysisImagePreparationError(
            secureFailureReason(error),
            error.disposition
        );
    }
    if (
        phase === 'download'
        && error instanceof Error
        && TRANSIENT_DOWNLOAD_PATTERNS.some(pattern => pattern.test(error.message))
    ) {
        return new AnalysisImagePreparationError('network_failure', 'transient');
    }
    return new AnalysisImagePreparationError(
        phase === 'download' ? 'source_rejected' : 'decode_failed',
        'permanent'
    );
}

export interface AnalysisImagePolicy {
    maxImages: number;
    maxPostImages: number;
    maxDimension: number;
    jpegQuality: number;
}

export function getAnalysisImagePolicy(
    costOptimized: boolean = isVertexAICostOptimized()
): AnalysisImagePolicy {
    return costOptimized
        ? {
            maxImages: COST_OPTIMIZED_MAX_ANALYSIS_IMAGES,
            maxPostImages: COST_OPTIMIZED_MAX_ANALYSIS_POST_IMAGES,
            maxDimension: COST_OPTIMIZED_MAX_ANALYSIS_IMAGE_DIMENSION,
            jpegQuality: 75,
        }
        : {
            maxImages: DEFAULT_MAX_ANALYSIS_IMAGES,
            maxPostImages: DEFAULT_MAX_ANALYSIS_POST_IMAGES,
            maxDimension: DEFAULT_MAX_ANALYSIS_IMAGE_DIMENSION,
            jpegQuality: 82,
        };
}

export type AnalysisImageRole = 'profile' | 'post';

export interface AnalysisImageCandidate {
    role: AnalysisImageRole;
    url: string;
}

export interface PreparedAnalysisImage extends AnalysisImageCandidate {
    base64: string;
}

interface DownloadImageOptions {
    requestImpl?: SecureImageRequest;
    resolveHostname?: ResolveHostname;
    maxBytes?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    deadlineAtMs?: number;
}

export interface PrepareAnalysisImagesOptions {
    loadImage?: (url: string, signal?: AbortSignal) => Promise<string>;
    onError?: (candidate: AnalysisImageCandidate, error: unknown) => void;
    policy?: AnalysisImagePolicy;
    abortSignal?: AbortSignal;
    deadlineAtMs?: number;
}

interface SemaphoreWaiter {
    resolve: () => void;
    reject: (error: unknown) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
}

class AsyncSemaphore {
    private active = 0;
    private readonly queue: SemaphoreWaiter[] = [];

    constructor(private readonly limit: number) {}

    async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        await this.acquire(signal);
        try {
            return await task();
        } finally {
            this.release();
        }
    }

    private acquire(signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) {
            return Promise.reject(signal.reason ?? new Error('ABORTED'));
        }
        if (this.active < this.limit) {
            this.active++;
            return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
            const waiter: SemaphoreWaiter = { resolve, reject, signal };
            const onAbort = () => {
                const index = this.queue.indexOf(waiter);
                if (index >= 0) this.queue.splice(index, 1);
                signal?.removeEventListener('abort', onAbort);
                reject(signal?.reason ?? new Error('ABORTED'));
            };
            waiter.onAbort = onAbort;
            signal?.addEventListener('abort', onAbort, { once: true });
            this.queue.push(waiter);
            if (signal?.aborted) onAbort();
        });
    }

    private release(): void {
        while (this.queue.length > 0) {
            const next = this.queue.shift();
            if (!next) break;
            next.signal?.removeEventListener('abort', next.onAbort as EventListener);
            if (next.signal?.aborted) {
                next.reject(next.signal.reason ?? new Error('ABORTED'));
                continue;
            }
            next.resolve();
            return;
        }
        this.active--;
    }
}

const imagePreparationSemaphore = new AsyncSemaphore(
    MAX_VERTEX_AI_CONCURRENT_IMAGE_PREPARATIONS
);
const imageDecodeSemaphore = new AsyncSemaphore(MAX_VERTEX_AI_CONCURRENT_IMAGE_DECODES);

export function runWithImagePreparationSlot<T>(
    task: () => Promise<T>,
    signal?: AbortSignal,
): Promise<T> {
    return imagePreparationSemaphore.run(task, signal);
}

export function runWithImageDecodeSlot<T>(
    task: () => Promise<T>,
    signal?: AbortSignal,
): Promise<T> {
    return imageDecodeSemaphore.run(task, signal);
}

function assertImageWorkAvailable(
    signal: AbortSignal | undefined,
    deadlineAtMs: number | undefined,
): void {
    if (
        signal?.aborted
        || deadlineAtMs !== undefined
            && (!Number.isFinite(deadlineAtMs) || Date.now() >= deadlineAtMs)
    ) {
        throw signal?.reason ?? new AnalysisImagePreparationError('timeout', 'transient');
    }
}

interface ImageDeadlineSignal {
    signal: AbortSignal | undefined;
    cleanup: () => void;
}

function createImageDeadlineSignal(
    parentSignal: AbortSignal | undefined,
    deadlineAtMs: number | undefined,
): ImageDeadlineSignal {
    if (deadlineAtMs === undefined) return { signal: parentSignal, cleanup: () => undefined };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onParentAbort = () => controller.abort(parentSignal?.reason ?? new Error('ABORTED'));
    if (parentSignal) {
        if (parentSignal.aborted) onParentAbort();
        else parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
    const remainingMs = deadlineAtMs - Date.now();
    if (!Number.isFinite(deadlineAtMs) || remainingMs <= 0) {
        controller.abort(new AnalysisImagePreparationError('timeout', 'transient'));
    } else {
        timer = setTimeout(
            () => controller.abort(new AnalysisImagePreparationError('timeout', 'transient')),
            remainingMs,
        );
    }
    return {
        signal: controller.signal,
        cleanup: () => {
            if (timer !== undefined) clearTimeout(timer);
            parentSignal?.removeEventListener('abort', onParentAbort);
        },
    };
}

export interface AnalysisV2SelectedMediaNormalizerDependencies {
    download?: (url: string) => Promise<Buffer>;
    downloadFallback?: (url: string) => Promise<Buffer>;
    normalize?: (bytes: Buffer) => Promise<Buffer>;
    withSlot?: <T>(task: () => Promise<T>) => Promise<T>;
    timeoutMs?: number;
}

/** Exact V2 selected-media normalizer shared by production and offline replay capture. */
export function createAnalysisV2SelectedMediaNormalizer(
    input: AnalysisV2SelectedMediaNormalizerDependencies = {},
): (media: SelectedAnalysisMedia) => Promise<Buffer> {
    const download = input.download ?? (url => downloadImageBytes(url));
    const fallback = input.downloadFallback
        ?? (input.download ? null : (url: string) => downloadImageBytesViaTrustedProxy(url));
    const normalize = input.normalize ?? (bytes => normalizeImageToJpeg(bytes));
    const withSlot = input.withSlot ?? runWithImagePreparationSlot;
    const timeoutMs = input.timeoutMs ?? SELECTED_MEDIA_NORMALIZATION_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
        throw new Error('ANALYSIS_IMAGE_PREPARATION_TIMEOUT_INVALID');
    }
    return async media => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                withSlot(async () => {
        if (!media.selectionId.trim() || !media.imageUrl.trim()) {
            throw new AnalysisImagePreparationError('invalid_source', 'permanent');
        }
        let downloaded: Buffer;
        try {
            downloaded = await download(media.imageUrl);
        } catch (directError) {
            if (!fallback) throw classifyAnalysisImagePreparationError(directError, 'download');
            try {
                downloaded = await fallback(media.imageUrl);
            } catch (fallbackError) {
                const classified = classifyAnalysisImagePreparationError(fallbackError, 'download');
                if (classified.disposition === 'transient') throw classified;
                throw classifyAnalysisImagePreparationError(directError, 'download');
            }
        }
        let normalized: Buffer;
        try { normalized = await normalize(downloaded); }
        catch (error) { throw classifyAnalysisImagePreparationError(error, 'decode'); }
        if (!normalized.length) throw new AnalysisImagePreparationError('empty_output', 'permanent');
                    return normalized;
                }),
                new Promise<Buffer>((_, reject) => {
                    timer = setTimeout(() => reject(new AnalysisImagePreparationError(
                        'timeout', 'transient',
                    )), timeoutMs);
                }),
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    };
}

function normalizedUrl(url: string | undefined): string | null {
    const trimmed = url?.trim();
    return trimmed ? trimmed : null;
}

/** Select a profile image followed by unique recent posts within the active policy. */
export function selectAnalysisImageCandidates(
    profilePicUrl: string | undefined,
    postImageUrls: string[],
    policy: AnalysisImagePolicy = getAnalysisImagePolicy()
): AnalysisImageCandidate[] {
    const candidates: AnalysisImageCandidate[] = [];
    const seen = new Set<string>();
    const profileUrl = normalizedUrl(profilePicUrl);

    if (profileUrl) {
        candidates.push({ role: 'profile', url: profileUrl });
        seen.add(profileUrl);
    }

    for (const postImageUrl of postImageUrls) {
        const url = normalizedUrl(postImageUrl);
        if (!url || seen.has(url)) {
            continue;
        }

        candidates.push({ role: 'post', url });
        seen.add(url);

        if (candidates.filter(candidate => candidate.role === 'post').length >= policy.maxPostImages) {
            break;
        }
    }

    return candidates.slice(0, policy.maxImages);
}

/** Download a public image without allowing time or response size to grow unbounded. */
export async function downloadImageBytes(
    url: string,
    options: DownloadImageOptions = {}
): Promise<Buffer> {
    const {
        requestImpl,
        resolveHostname,
        maxBytes = MAX_IMAGE_DOWNLOAD_BYTES,
        timeoutMs = IMAGE_DOWNLOAD_TIMEOUT_MS,
        signal,
    } = options;
    try {
        assertImageWorkAvailable(signal, options.deadlineAtMs);
        const downloaded = await downloadSecureImage(url, {
            allowedHostSuffixes: INSTAGRAM_MEDIA_HOST_SUFFIXES,
            ...(requestImpl ? { requestImpl } : {}),
            ...(resolveHostname ? { resolveHostname } : {}),
            maxBytes,
            timeoutMs,
            ...(signal ? { signal } : {}),
            headers: { Accept: 'image/jpeg,image/png,image/webp,image/avif,image/*;q=0.8' },
        });
        assertImageWorkAvailable(signal, options.deadlineAtMs);
        return downloaded.bytes;
    } catch (error) {
        throw classifyAnalysisImagePreparationError(error, 'download');
    }
}

/** Download an allowlisted Instagram image through the existing trusted proxy fallback. */
export async function downloadImageBytesViaTrustedProxy(
    url: string,
    options: DownloadImageOptions = {}
): Promise<Buffer> {
    const {
        requestImpl,
        resolveHostname,
        maxBytes = MAX_IMAGE_DOWNLOAD_BYTES,
        timeoutMs = IMAGE_DOWNLOAD_TIMEOUT_MS,
        signal,
    } = options;
    assertImageWorkAvailable(signal, options.deadlineAtMs);
    await validateAllowedRemoteImageUrl(
        url,
        INSTAGRAM_MEDIA_HOST_SUFFIXES,
        resolveHostname,
        signal,
    );
    assertImageWorkAvailable(signal, options.deadlineAtMs);
    const proxyUrl = `https://images.weserv.nl/?url=${encodeURIComponent(url)}&default=1`;
    const downloaded = await downloadSecureImage(proxyUrl, {
        allowedHostSuffixes: TRUSTED_IMAGE_PROXY_HOST_SUFFIXES,
        ...(requestImpl ? { requestImpl } : {}),
        ...(resolveHostname ? { resolveHostname } : {}),
        maxBytes,
        timeoutMs,
        ...(signal ? { signal } : {}),
        headers: { Accept: 'image/jpeg,image/png,image/webp,image/avif,image/*;q=0.8' },
    });
    assertImageWorkAvailable(signal, options.deadlineAtMs);
    return downloaded.bytes;
}

/** Strip metadata, orient, resize, and encode every input identically as JPEG. */
export async function normalizeImageToJpeg(
    imageBytes: Buffer,
    policy: AnalysisImagePolicy = getAnalysisImagePolicy(),
    signal?: AbortSignal,
    deadlineAtMs?: number,
): Promise<Buffer> {
    try {
        assertImageWorkAvailable(signal, deadlineAtMs);
        const normalized = await runWithImageDecodeSlot(
            () => sharp(imageBytes, {
                failOn: 'error',
                limitInputPixels: MAX_DECODED_IMAGE_PIXELS,
                pages: 1,
                sequentialRead: true,
            })
                .rotate()
                .flatten({ background: '#ffffff' })
                .resize({
                    width: policy.maxDimension,
                    height: policy.maxDimension,
                    fit: 'inside',
                    withoutEnlargement: true,
                })
                .jpeg({
                    quality: policy.jpegQuality,
                    chromaSubsampling: '4:2:0',
                    progressive: false,
                })
                .toBuffer(),
            signal,
        );
        assertImageWorkAvailable(signal, deadlineAtMs);
        return normalized;
    } catch (error) {
        throw classifyAnalysisImagePreparationError(error, 'decode');
    }
}

async function downloadAndNormalizeImage(
    url: string,
    policy: AnalysisImagePolicy,
    signal?: AbortSignal,
    deadlineAtMs?: number,
): Promise<string> {
    assertImageWorkAvailable(signal, deadlineAtMs);
    const imageBytes = await downloadImageBytes(url, { signal, deadlineAtMs });
    assertImageWorkAvailable(signal, deadlineAtMs);
    const jpeg = await normalizeImageToJpeg(imageBytes, policy, signal, deadlineAtMs);
    return jpeg.toString('base64');
}

/**
 * Convert an already-collected public image URL into a bounded JPEG payload.
 * The existing public image proxy remains a fallback for CDN-region failures.
 */
export async function imageUrlToNormalizedBase64(
    url: string,
    policy: AnalysisImagePolicy = getAnalysisImagePolicy(),
    signal?: AbortSignal,
    deadlineAtMs?: number,
): Promise<string> {
    assertImageWorkAvailable(signal, deadlineAtMs);
    await validateAllowedRemoteImageUrl(url, INSTAGRAM_MEDIA_HOST_SUFFIXES, undefined, signal);
    assertImageWorkAvailable(signal, deadlineAtMs);
    try {
        return await downloadAndNormalizeImage(url, policy, signal, deadlineAtMs);
    } catch (directError) {
        assertImageWorkAvailable(signal, deadlineAtMs);
        try {
            const proxyBytes = await downloadImageBytesViaTrustedProxy(url, { signal, deadlineAtMs });
            const jpeg = await normalizeImageToJpeg(proxyBytes, policy, signal, deadlineAtMs);
            return jpeg.toString('base64');
        } catch (proxyError) {
            const classified = classifyAnalysisImagePreparationError(proxyError, 'download');
            if (classified.disposition === 'transient') throw classified;
            throw classifyAnalysisImagePreparationError(directError, 'download');
        }
    }
}

/** Prepare selected images concurrently while preserving profile/post order. */
export async function prepareAnalysisImages(
    profilePicUrl: string | undefined,
    postImageUrls: string[],
    options: PrepareAnalysisImagesOptions = {}
): Promise<PreparedAnalysisImage[]> {
    const policy = options.policy ?? getAnalysisImagePolicy();
    const candidates = selectAnalysisImageCandidates(profilePicUrl, postImageUrls, policy);
    const effectiveDeadline = createImageDeadlineSignal(options.abortSignal, options.deadlineAtMs);
    const loadImage = options.loadImage
        ?? ((url: string, signal?: AbortSignal) => imageUrlToNormalizedBase64(
            url,
            policy,
            signal,
            options.deadlineAtMs,
        ));
    const onError = options.onError ?? (() => {
        console.warn('Failed to prepare an analysis image');
    });

    const prepared: Array<PreparedAnalysisImage | null> = new Array(candidates.length);
    let nextIndex = 0;

    async function worker(): Promise<void> {
        while (nextIndex < candidates.length) {
            if (effectiveDeadline.signal?.aborted) return;
            const index = nextIndex++;
            const candidate = candidates[index];

            try {
                prepared[index] = {
                    ...candidate,
                    base64: await runWithImagePreparationSlot(async () => {
                        assertImageWorkAvailable(effectiveDeadline.signal, options.deadlineAtMs);
                        return loadImage(candidate.url, effectiveDeadline.signal);
                    }, effectiveDeadline.signal),
                };
            } catch (error) {
                onError(candidate, error);
                prepared[index] = null;
            }
        }
    }

    try {
        await Promise.all(Array.from(
            { length: Math.min(MAX_VERTEX_AI_IMAGE_PREPARATION_CONCURRENCY, candidates.length) },
            () => worker()
        ));

        return prepared.filter((image): image is PreparedAnalysisImage => image !== null);
    } finally {
        effectiveDeadline.cleanup();
    }
}
