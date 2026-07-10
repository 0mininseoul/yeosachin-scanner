import sharp from 'sharp';
import { isVertexAICostOptimized } from './gemini-cost';
import {
    MAX_VERTEX_AI_CONCURRENT_IMAGE_DECODES,
    MAX_VERTEX_AI_CONCURRENT_IMAGE_PREPARATIONS,
    MAX_VERTEX_AI_IMAGE_PREPARATION_CONCURRENCY,
} from './pipeline-config';
import {
    downloadSecureImage,
    INSTAGRAM_MEDIA_HOST_SUFFIXES,
    TRUSTED_IMAGE_PROXY_HOST_SUFFIXES,
    validateAllowedRemoteImageUrl,
    type ResolveHostname,
} from '@/lib/services/media/secure-image-fetch';

export const DEFAULT_MAX_ANALYSIS_IMAGES = 11;
export const DEFAULT_MAX_ANALYSIS_POST_IMAGES = 10;
export const DEFAULT_MAX_ANALYSIS_IMAGE_DIMENSION = 1_024;
export const COST_OPTIMIZED_MAX_ANALYSIS_IMAGES = 3;
export const COST_OPTIMIZED_MAX_ANALYSIS_POST_IMAGES = 2;
export const COST_OPTIMIZED_MAX_ANALYSIS_IMAGE_DIMENSION = 384;
export const MAX_IMAGE_DOWNLOAD_BYTES = 8 * 1024 * 1024;
export const IMAGE_DOWNLOAD_TIMEOUT_MS = 5_000;

export const MAX_DECODED_IMAGE_PIXELS = 16_000_000;

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
    fetchImpl?: typeof fetch;
    resolveHostname?: ResolveHostname;
    maxBytes?: number;
    timeoutMs?: number;
}

interface PrepareAnalysisImagesOptions {
    loadImage?: (url: string) => Promise<string>;
    onError?: (candidate: AnalysisImageCandidate, error: unknown) => void;
    policy?: AnalysisImagePolicy;
}

class AsyncSemaphore {
    private active = 0;
    private readonly queue: Array<() => void> = [];

    constructor(private readonly limit: number) {}

    async run<T>(task: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await task();
        } finally {
            this.release();
        }
    }

    private acquire(): Promise<void> {
        if (this.active < this.limit) {
            this.active++;
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => this.queue.push(resolve));
    }

    private release(): void {
        const next = this.queue.shift();
        if (next) {
            next();
            return;
        }
        this.active--;
    }
}

const imagePreparationSemaphore = new AsyncSemaphore(
    MAX_VERTEX_AI_CONCURRENT_IMAGE_PREPARATIONS
);
const imageDecodeSemaphore = new AsyncSemaphore(MAX_VERTEX_AI_CONCURRENT_IMAGE_DECODES);

export function runWithImagePreparationSlot<T>(task: () => Promise<T>): Promise<T> {
    return imagePreparationSemaphore.run(task);
}

export function runWithImageDecodeSlot<T>(task: () => Promise<T>): Promise<T> {
    return imageDecodeSemaphore.run(task);
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
        fetchImpl = fetch,
        resolveHostname,
        maxBytes = MAX_IMAGE_DOWNLOAD_BYTES,
        timeoutMs = IMAGE_DOWNLOAD_TIMEOUT_MS,
    } = options;
    const downloaded = await downloadSecureImage(url, {
        allowedHostSuffixes: INSTAGRAM_MEDIA_HOST_SUFFIXES,
        fetchImpl,
        ...(resolveHostname ? { resolveHostname } : {}),
        maxBytes,
        timeoutMs,
        headers: { Accept: 'image/jpeg,image/png,image/webp,image/avif,image/*;q=0.8' },
    });
    return downloaded.bytes;
}

/** Strip metadata, orient, resize, and encode every input identically as JPEG. */
export async function normalizeImageToJpeg(
    imageBytes: Buffer,
    policy: AnalysisImagePolicy = getAnalysisImagePolicy()
): Promise<Buffer> {
    return runWithImageDecodeSlot(() =>
        sharp(imageBytes, {
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
            .toBuffer()
    );
}

async function downloadAndNormalizeImage(url: string, policy: AnalysisImagePolicy): Promise<string> {
    const imageBytes = await downloadImageBytes(url);
    const jpeg = await normalizeImageToJpeg(imageBytes, policy);
    return jpeg.toString('base64');
}

/**
 * Convert an already-collected public image URL into a bounded JPEG payload.
 * The existing public image proxy remains a fallback for CDN-region failures.
 */
export async function imageUrlToNormalizedBase64(
    url: string,
    policy: AnalysisImagePolicy = getAnalysisImagePolicy()
): Promise<string> {
    await validateAllowedRemoteImageUrl(url, INSTAGRAM_MEDIA_HOST_SUFFIXES);
    try {
        return await downloadAndNormalizeImage(url, policy);
    } catch (directError) {
        const proxyUrl = `https://images.weserv.nl/?url=${encodeURIComponent(url)}&default=1`;

        try {
            const downloaded = await downloadSecureImage(proxyUrl, {
                allowedHostSuffixes: TRUSTED_IMAGE_PROXY_HOST_SUFFIXES,
                maxBytes: MAX_IMAGE_DOWNLOAD_BYTES,
                timeoutMs: IMAGE_DOWNLOAD_TIMEOUT_MS,
                headers: { Accept: 'image/jpeg,image/png,image/webp,image/avif,image/*;q=0.8' },
            });
            const jpeg = await normalizeImageToJpeg(downloaded.bytes, policy);
            return jpeg.toString('base64');
        } catch (proxyError) {
            throw new Error('Failed to prepare remote image', {
                cause: proxyError instanceof Error ? proxyError : directError,
            });
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
    const loadImage = options.loadImage ?? (url => imageUrlToNormalizedBase64(url, policy));
    const onError = options.onError ?? (() => {
        console.warn('Failed to prepare an analysis image');
    });

    const prepared: Array<PreparedAnalysisImage | null> = new Array(candidates.length);
    let nextIndex = 0;

    async function worker(): Promise<void> {
        while (nextIndex < candidates.length) {
            const index = nextIndex++;
            const candidate = candidates[index];

            try {
                prepared[index] = {
                    ...candidate,
                    base64: await runWithImagePreparationSlot(() => loadImage(candidate.url)),
                };
            } catch (error) {
                onError(candidate, error);
                prepared[index] = null;
            }
        }
    }

    await Promise.all(Array.from(
        { length: Math.min(MAX_VERTEX_AI_IMAGE_PREPARATION_CONCURRENCY, candidates.length) },
        () => worker()
    ));

    return prepared.filter((image): image is PreparedAnalysisImage => image !== null);
}
