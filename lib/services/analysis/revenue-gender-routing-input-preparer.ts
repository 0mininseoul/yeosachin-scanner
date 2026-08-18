import {
    normalizeImageToJpeg,
    type AnalysisImagePolicy,
} from '@/lib/services/ai/image-preprocessing';
import {
    downloadSecureImage,
    INSTAGRAM_MEDIA_HOST_SUFFIXES,
    type SecureImageDownload,
    type SecureImageDownloadOptions,
} from '@/lib/services/media/secure-image-fetch';
import type {
    RevenueGenderRoutingInputPreparer,
    RevenueGenderRoutingPreparationSource,
    RevenueGenderRoutingPreparedCandidate,
} from './revenue-routing-runtime';
import { preferredInstagramProfileImageUrl } from './profile-image-evidence';

/** The stage-one input is deliberately smaller than general analysis media. */
export const REVENUE_GENDER_ROUTING_IMAGE_MAX_BYTES = 256 * 1024;
export const REVENUE_GENDER_ROUTING_IMAGE_TIMEOUT_MS = 3_000;
export const REVENUE_GENDER_ROUTING_IMAGE_MAX_REDIRECTS = 2;
export const REVENUE_GENDER_ROUTING_IMAGE_MAX_CONCURRENCY = 4;
/** Bounds all distinct normalized request-local evidence, before assessor batching. */
export const REVENUE_GENDER_ROUTING_MAX_AGGREGATE_NORMALIZED_IMAGE_BYTES = 8 * 1024 * 1024;

export const REVENUE_GENDER_ROUTING_IMAGE_POLICY: AnalysisImagePolicy = Object.freeze({
    maxImages: 4,
    maxPostImages: 3,
    maxDimension: 768,
    jpegQuality: 85,
});

type Download = (
    url: string,
    options: SecureImageDownloadOptions,
) => Promise<SecureImageDownload>;

export interface RevenueGenderRoutingInputPreparerDependencies {
    /** Injectable only for transport-free tests; production always uses secure-image-fetch. */
    download?: Download;
    /** Injectable only for deterministic failure/size boundary tests. */
    normalize?: (bytes: Buffer) => Promise<Buffer>;
    maxConcurrency?: number;
    maxAggregateNormalizedBytes?: number;
}

function isSupportedSourceImage(bytes: Buffer): boolean {
    if (bytes.length < 3) return false;
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
    if (
        bytes.length >= 8
        && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) return true;
    return bytes.length >= 12
        && bytes.subarray(0, 4).equals(Buffer.from('RIFF'))
        && bytes.subarray(8, 12).equals(Buffer.from('WEBP'));
}

function profileImageUrl(source: RevenueGenderRoutingPreparationSource): string | null {
    return preferredInstagramProfileImageUrl(source) ?? null;
}

function boundedConcurrency(value: number | undefined): number {
    const resolved = value ?? REVENUE_GENDER_ROUTING_IMAGE_MAX_CONCURRENCY;
    if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 16) {
        throw new Error('REVENUE_GENDER_ROUTING_IMAGE_CONCURRENCY_INVALID');
    }
    return resolved;
}

function boundedAggregateNormalizedBytes(value: number | undefined): number {
    const resolved = value ?? REVENUE_GENDER_ROUTING_MAX_AGGREGATE_NORMALIZED_IMAGE_BYTES;
    if (!Number.isSafeInteger(resolved) || resolved < REVENUE_GENDER_ROUTING_IMAGE_MAX_BYTES || resolved > 64 * 1024 * 1024) {
        throw new Error('REVENUE_GENDER_ROUTING_IMAGE_BUDGET_INVALID');
    }
    return resolved;
}

async function prepareOneImage(
    url: string,
    download: Download,
    normalize: (bytes: Buffer) => Promise<Buffer>,
): Promise<Uint8Array | null> {
    try {
        const response = await download(url, {
            allowedHostSuffixes: INSTAGRAM_MEDIA_HOST_SUFFIXES,
            maxBytes: REVENUE_GENDER_ROUTING_IMAGE_MAX_BYTES,
            timeoutMs: REVENUE_GENDER_ROUTING_IMAGE_TIMEOUT_MS,
            maxRedirects: REVENUE_GENDER_ROUTING_IMAGE_MAX_REDIRECTS,
            headers: { Accept: 'image/jpeg,image/png,image/webp' },
        });
        if (
            response.bytes.length === 0
            || response.bytes.length > REVENUE_GENDER_ROUTING_IMAGE_MAX_BYTES
            || !isSupportedSourceImage(response.bytes)
        ) return null;

        const normalized = await normalize(response.bytes);
        if (
            normalized.length === 0
            || normalized.length > REVENUE_GENDER_ROUTING_IMAGE_MAX_BYTES
        ) return null;
        return normalized;
    } catch {
        // A source failure is intentionally indistinguishable from no image evidence.
        return null;
    }
}

/**
 * Builds stage-one evidence from the relationship payload only. URL work is
 * deduplicated within this invocation and is never persisted or logged.
 */
export function createRevenueGenderRoutingInputPreparer(
    dependencies: RevenueGenderRoutingInputPreparerDependencies = {},
): RevenueGenderRoutingInputPreparer {
    const download = dependencies.download ?? downloadSecureImage;
    const normalize = dependencies.normalize ?? (bytes => normalizeImageToJpeg(
        bytes,
        REVENUE_GENDER_ROUTING_IMAGE_POLICY,
    ));
    const concurrency = boundedConcurrency(dependencies.maxConcurrency);
    const maxAggregateNormalizedBytes = boundedAggregateNormalizedBytes(
        dependencies.maxAggregateNormalizedBytes,
    );

    return async candidates => {
        const urls = new Map<string, null>();
        for (const candidate of candidates) {
            const url = profileImageUrl(candidate);
            if (url !== null && !urls.has(url)) urls.set(url, null);
        }

        const preparedByUrl = new Map<string, Uint8Array | null>();
        const pendingUrls = [...urls.keys()];
        let nextUrlIndex = 0;
        let aggregateNormalizedBytes = 0;
        async function worker(): Promise<void> {
            while (nextUrlIndex < pendingUrls.length) {
                const url = pendingUrls[nextUrlIndex++];
                const normalizedImage = await prepareOneImage(url, download, normalize);
                if (normalizedImage !== null) {
                    if (aggregateNormalizedBytes + normalizedImage.byteLength > maxAggregateNormalizedBytes) {
                        throw new Error('REVENUE_GENDER_ROUTING_IMAGE_BUDGET_EXCEEDED');
                    }
                    aggregateNormalizedBytes += normalizedImage.byteLength;
                }
                preparedByUrl.set(url, normalizedImage);
            }
        }
        await Promise.all(Array.from(
            { length: Math.min(concurrency, pendingUrls.length) },
            () => worker(),
        ));

        return Object.freeze(candidates.map((candidate): RevenueGenderRoutingPreparedCandidate => {
            const url = profileImageUrl(candidate);
            const normalizedImage = url === null ? null : preparedByUrl.get(url) ?? null;
            return Object.freeze({
                candidateKey: candidate.candidateKey,
                fullname: candidate.fullname,
                // The runtime snapshots this private request-local evidence before any model call.
                // Sharing it here prevents duplicate URLs from multiplying mutable buffers.
                imageBytes: normalizedImage,
            });
        }));
    };
}
