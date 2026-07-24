import { createHash } from 'node:crypto';
import { canonicalizeImageProxyUrl } from './image-proxy-token';
import {
    normalizeResultImage,
    ResultImageNormalizationError,
    type NormalizedResultImage,
} from './result-image-normalizer';
import {
    resultImageObjectKey,
    ResultImageR2Error,
} from './r2-result-image-store';
import type {
    ResultImageRegistry,
    ResultImageRegistryClaim,
    ResultImageRegistryOutcome,
} from './result-image-registry';
import {
    downloadSecureImage,
    INSTAGRAM_MEDIA_HOST_SUFFIXES,
    SecureImageFetchError,
    type SecureImageDownload,
    type SecureImageDownloadOptions,
} from './secure-image-fetch';

const DEFAULT_PAGE_SIZE = 250;
const MAX_PAGE_SIZE = 500;
const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 8;
const DEFAULT_CAPTURE_ATTEMPTS = 3;
const SOURCE_DOWNLOAD_MAX_BYTES = 5 * 1024 * 1024;
const SOURCE_DOWNLOAD_TIMEOUT_MS = 4_000;
const RETENTION_MS = 30 * 86_400_000;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const CANDIDATE_LOCATOR_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export type ResultImageCaptureSource = {
    kind: 'target' | 'female' | 'private';
    candidateLocator: string;
    sortOrdinal: number;
    sourceUrl: string | null;
};

export type ResultImageCaptureSourcePage = {
    items: readonly ResultImageCaptureSource[];
    nextAfterOrdinal: number | null;
};

export type ResultImageCaptureSourcePageLoader = (input: {
    afterOrdinal: number;
    pageSize: number;
}) => Promise<ResultImageCaptureSourcePage>;

export interface ResultImageCaptureStore {
    put(input: {
        objectKey: string;
        bytes: Buffer | Uint8Array;
        sha256: string;
    }): Promise<void>;
    head(input: {
        objectKey: string;
        expectedByteSize: number;
        expectedSha256: string;
    }): Promise<{ byteSize: number; sha256: string }>;
}

type ResultImageCaptureRegistry = Pick<
    ResultImageRegistry,
    'beginManifest' | 'loadManifestPage' | 'registerOutcome' | 'sealManifest'
>;

export type ResultImageCaptureInput = ResultImageRegistryClaim & {
    orderedManifestHash: string;
    expectedRows: number;
    loadSourcePage: ResultImageCaptureSourcePageLoader;
    registry: ResultImageCaptureRegistry;
    store: ResultImageCaptureStore;
    hmacSecret: string;
    pageSize?: number;
    concurrency?: number;
    captureAttempts?: number;
    now?: () => number;
    download?: (
        url: string,
        options: SecureImageDownloadOptions
    ) => Promise<SecureImageDownload>;
    normalize?: (
        bytes: Buffer | Uint8Array
    ) => Promise<NormalizedResultImage>;
};

export type ResultImageCaptureSourcesInput = Omit<
    ResultImageCaptureInput,
    'loadSourcePage'
> & {
    sources: readonly ResultImageCaptureSource[];
};

export class ResultImageCaptureError extends Error {
    constructor(
        readonly code:
            | 'RESULT_IMAGE_CAPTURE_INVALID_INPUT'
            | 'RESULT_IMAGE_CAPTURE_SOURCE_DRIFT'
            | 'RESULT_IMAGE_CAPTURE_PAGE_DRIFT'
    ) {
        super(code);
        this.name = 'ResultImageCaptureError';
    }
}

function sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function resultImageSourceFingerprint(
    sourceUrl: string | null
): string | null {
    return sourceUrl === null
        ? null
        : sha256(canonicalSourceUrl(sourceUrl));
}

export function resultImageOrderedManifestHash(
    sources: readonly ResultImageCaptureSource[]
): string {
    const hash = createHash('sha256')
        .update('analysis-v2-result-image-manifest-v1\n', 'utf8');
    let previousOrdinal = -1;
    for (const source of sources) {
        validateSource(source);
        if (source.sortOrdinal <= previousOrdinal) {
            throw new ResultImageCaptureError(
                'RESULT_IMAGE_CAPTURE_PAGE_DRIFT'
            );
        }
        previousOrdinal = source.sortOrdinal;
        hash.update(source.kind, 'utf8');
        hash.update('\n');
        hash.update(source.candidateLocator, 'utf8');
        hash.update('\n');
        hash.update(String(source.sortOrdinal), 'utf8');
        hash.update('\n');
        hash.update(
            resultImageSourceFingerprint(source.sourceUrl) ?? 'source_missing',
            'utf8'
        );
        hash.update('\n');
    }
    return hash.digest('hex');
}

function mandatory(
    source: ResultImageCaptureSource,
    sourceFingerprint: string | null
): boolean {
    return sourceFingerprint !== null && (
        source.kind === 'target'
        || (source.kind === 'female' && source.sortOrdinal <= 3)
    );
}

function validateSource(source: ResultImageCaptureSource): void {
    const targetIdentity = source.kind === 'target'
        && source.candidateLocator === 'target'
        && source.sortOrdinal === 0;
    const candidateIdentity = source.kind !== 'target'
        && source.candidateLocator !== 'target'
        && source.sortOrdinal >= 1
        && source.sortOrdinal <= 50_000;
    if (
        !['target', 'female', 'private'].includes(source.kind)
        || !CANDIDATE_LOCATOR_PATTERN.test(source.candidateLocator)
        || /https?/i.test(source.candidateLocator)
        || (!targetIdentity && !candidateIdentity)
        || (
            source.sourceUrl !== null
            && (
                typeof source.sourceUrl !== 'string'
                || source.sourceUrl.length === 0
                || source.sourceUrl.length > 8_192
            )
        )
    ) {
        throw new ResultImageCaptureError(
            'RESULT_IMAGE_CAPTURE_INVALID_INPUT'
        );
    }
}

function canonicalSourceUrl(sourceUrl: string): string {
    try {
        return canonicalizeImageProxyUrl(sourceUrl);
    } catch {
        throw new ResultImageCaptureError(
            'RESULT_IMAGE_CAPTURE_INVALID_INPUT'
        );
    }
}

function expiresAt(capturedAtMs: number): string {
    return new Date(capturedAtMs + RETENTION_MS).toISOString();
}

function failureCode(error: unknown): string {
    if (error instanceof SecureImageFetchError) {
        return error.reason.toUpperCase();
    }
    if (error instanceof ResultImageNormalizationError) {
        return error.code === 'RESULT_IMAGE_OUTPUT_TOO_LARGE'
            ? 'NORMALIZED_IMAGE_TOO_LARGE'
            : 'INVALID_IMAGE';
    }
    if (error instanceof ResultImageR2Error) {
        return error.code === 'R2_RESULT_IMAGE_INTEGRITY_MISMATCH'
            ? 'STORAGE_INTEGRITY_MISMATCH'
            : 'STORAGE_UNAVAILABLE';
    }
    return 'CAPTURE_FAILED';
}

function shouldRetry(error: unknown): boolean {
    if (error instanceof ResultImageCaptureError) {
        return false;
    }
    if (error instanceof SecureImageFetchError) {
        return error.disposition === 'transient';
    }
    return error instanceof ResultImageR2Error
        || !(error instanceof ResultImageNormalizationError);
}

function existingKey(outcome: ResultImageRegistryOutcome): string {
    return `${outcome.kind}\n${outcome.candidateLocator}`;
}

async function runBounded(
    items: readonly ResultImageCaptureSource[],
    concurrency: number,
    worker: (item: ResultImageCaptureSource) => Promise<void>
): Promise<void> {
    let nextIndex = 0;
    const workers = Array.from(
        { length: Math.min(concurrency, items.length) },
        async () => {
            while (true) {
                const index = nextIndex;
                nextIndex += 1;
                if (index >= items.length) return;
                await worker(items[index]);
            }
        }
    );
    await Promise.all(workers);
}

export async function captureResultImages(
    input: ResultImageCaptureInput
) {
    const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
    const concurrency = input.concurrency ?? DEFAULT_CONCURRENCY;
    const captureAttempts = input.captureAttempts
        ?? DEFAULT_CAPTURE_ATTEMPTS;
    if (
        !HASH_PATTERN.test(input.orderedManifestHash)
        || !Number.isSafeInteger(input.expectedRows)
        || input.expectedRows < 0
        || input.expectedRows > 50_001
        || !Number.isSafeInteger(pageSize)
        || pageSize < 1
        || pageSize > MAX_PAGE_SIZE
        || !Number.isSafeInteger(concurrency)
        || concurrency < 1
        || concurrency > MAX_CONCURRENCY
        || !Number.isSafeInteger(captureAttempts)
        || captureAttempts < 1
        || captureAttempts > 3
        || input.hmacSecret.length < 32
    ) {
        throw new ResultImageCaptureError(
            'RESULT_IMAGE_CAPTURE_INVALID_INPUT'
        );
    }

    const now = input.now ?? Date.now;
    const download = input.download ?? downloadSecureImage;
    const normalize = input.normalize ?? normalizeResultImage;
    const claim = {
        requestId: input.requestId,
        jobKey: input.jobKey,
        claimToken: input.claimToken,
        jobInputHash: input.jobInputHash,
    };

    const manifest = await input.registry.beginManifest({
        ...claim,
        orderedManifestHash: input.orderedManifestHash,
        expectedRows: input.expectedRows,
    });
    if (manifest.sealed) {
        return input.registry.sealManifest({
            ...claim,
            orderedManifestHash: input.orderedManifestHash,
        });
    }

    let afterOrdinal = -1;
    let observedRows = 0;
    while (true) {
        const page = await input.loadSourcePage({
            afterOrdinal,
            pageSize,
        });
        if (
            !page
            || !Array.isArray(page.items)
            || page.items.length > pageSize
            || (
                page.items.length === 0
                && page.nextAfterOrdinal !== null
            )
        ) {
            throw new ResultImageCaptureError(
                'RESULT_IMAGE_CAPTURE_PAGE_DRIFT'
            );
        }
        let previousOrdinal = afterOrdinal;
        for (const item of page.items) {
            validateSource(item);
            if (item.sortOrdinal <= previousOrdinal) {
                throw new ResultImageCaptureError(
                    'RESULT_IMAGE_CAPTURE_PAGE_DRIFT'
                );
            }
            previousOrdinal = item.sortOrdinal;
        }
        if (
            page.nextAfterOrdinal !== null
            && (
                !Number.isSafeInteger(page.nextAfterOrdinal)
                || page.nextAfterOrdinal !== previousOrdinal
            )
        ) {
            throw new ResultImageCaptureError(
                'RESULT_IMAGE_CAPTURE_PAGE_DRIFT'
            );
        }
        observedRows += page.items.length;
        if (observedRows > input.expectedRows) {
            throw new ResultImageCaptureError(
                'RESULT_IMAGE_CAPTURE_PAGE_DRIFT'
            );
        }

        const existingRows = await input.registry.loadManifestPage({
            ...claim,
            afterOrdinal,
            pageSize,
        });
        const existingByKey = new Map(
            existingRows.map(row => [existingKey(row), row])
        );

        await runBounded(page.items, concurrency, async source => {
            const canonicalUrl = source.sourceUrl === null
                ? null
                : canonicalSourceUrl(source.sourceUrl);
            const sourceFingerprint = resultImageSourceFingerprint(
                canonicalUrl
            );
            const prior = existingByKey.get(
                `${source.kind}\n${source.candidateLocator}`
            );
            if (
                prior
                && (
                    prior.sortOrdinal !== source.sortOrdinal
                    || prior.sourceFingerprint !== sourceFingerprint
                )
            ) {
                throw new ResultImageCaptureError(
                    'RESULT_IMAGE_CAPTURE_SOURCE_DRIFT'
                );
            }

            if (prior?.status === 'source_missing' && canonicalUrl === null) {
                return;
            }
            if (
                prior?.status === 'ready'
                && prior.objectKey
                && prior.sha256
                && prior.byteSize
            ) {
                try {
                    await input.store.head({
                        objectKey: prior.objectKey,
                        expectedByteSize: prior.byteSize,
                        expectedSha256: prior.sha256,
                    });
                    return;
                } catch {
                    // Re-put the deterministic object before accepting replay.
                }
            }

            const observedAtMs = now();
            if (canonicalUrl === null) {
                const outcome: ResultImageRegistryOutcome = {
                    kind: source.kind,
                    candidateLocator: source.candidateLocator,
                    sortOrdinal: source.sortOrdinal,
                    sourceFingerprint: null,
                    status: 'source_missing',
                    objectKey: null,
                    sha256: null,
                    byteSize: null,
                    capturedAt: null,
                    expiresAt: expiresAt(observedAtMs),
                    failureCode: null,
                    isMandatory: false,
                };
                await input.registry.registerOutcome({ ...claim, outcome });
                return;
            }
            if (sourceFingerprint === null) {
                throw new ResultImageCaptureError(
                    'RESULT_IMAGE_CAPTURE_SOURCE_DRIFT'
                );
            }

            let lastError: unknown;
            for (let attempt = 1; attempt <= captureAttempts; attempt++) {
                try {
                    const downloaded = await download(canonicalUrl, {
                        allowedHostSuffixes: INSTAGRAM_MEDIA_HOST_SUFFIXES,
                        maxBytes: SOURCE_DOWNLOAD_MAX_BYTES,
                        timeoutMs: SOURCE_DOWNLOAD_TIMEOUT_MS,
                        maxRedirects: 3,
                    });
                    const normalized = await normalize(downloaded.bytes);
                    const objectKey = resultImageObjectKey({
                        requestId: claim.requestId,
                        kind: source.kind,
                        candidateId: source.kind === 'target'
                            ? null
                            : source.candidateLocator,
                        sourceFingerprint,
                    }, input.hmacSecret);
                    if (
                        prior?.status === 'ready'
                        && (
                            prior.objectKey !== objectKey
                            || prior.sha256 !== normalized.sha256
                            || prior.byteSize !== normalized.bytes.byteLength
                        )
                    ) {
                        throw new ResultImageCaptureError(
                            'RESULT_IMAGE_CAPTURE_SOURCE_DRIFT'
                        );
                    }
                    await input.store.put({
                        objectKey,
                        bytes: normalized.bytes,
                        sha256: normalized.sha256,
                    });
                    await input.store.head({
                        objectKey,
                        expectedByteSize: normalized.bytes.byteLength,
                        expectedSha256: normalized.sha256,
                    });
                    if (prior?.status === 'ready') {
                        return;
                    }
                    const capturedAtMs = now();
                    const outcome: ResultImageRegistryOutcome = {
                        kind: source.kind,
                        candidateLocator: source.candidateLocator,
                        sortOrdinal: source.sortOrdinal,
                        sourceFingerprint,
                        status: 'ready',
                        objectKey,
                        sha256: normalized.sha256,
                        byteSize: normalized.bytes.byteLength,
                        capturedAt: new Date(capturedAtMs).toISOString(),
                        expiresAt: expiresAt(capturedAtMs),
                        failureCode: null,
                        isMandatory: mandatory(source, sourceFingerprint),
                    };
                    await input.registry.registerOutcome({
                        ...claim,
                        outcome,
                    });
                    return;
                } catch (error) {
                    lastError = error;
                    if (attempt === captureAttempts || !shouldRetry(error)) {
                        break;
                    }
                }
            }

            if (lastError instanceof ResultImageCaptureError) {
                throw lastError;
            }
            const outcome: ResultImageRegistryOutcome = {
                kind: source.kind,
                candidateLocator: source.candidateLocator,
                sortOrdinal: source.sortOrdinal,
                sourceFingerprint,
                status: 'capture_failed',
                objectKey: null,
                sha256: null,
                byteSize: null,
                capturedAt: null,
                expiresAt: expiresAt(observedAtMs),
                failureCode: failureCode(lastError),
                isMandatory: mandatory(source, sourceFingerprint),
            };
            await input.registry.registerOutcome({ ...claim, outcome });
        });

        if (page.nextAfterOrdinal === null) break;
        afterOrdinal = page.nextAfterOrdinal;
    }

    return input.registry.sealManifest({
        ...claim,
        orderedManifestHash: input.orderedManifestHash,
    });
}

export async function captureResultImageSources(
    input: ResultImageCaptureSourcesInput
) {
    const sources = input.sources;
    return captureResultImages({
        ...input,
        loadSourcePage: async ({ afterOrdinal, pageSize }) => {
            const startIndex = afterOrdinal < 0
                ? 0
                : sources.findIndex(
                    source => source.sortOrdinal > afterOrdinal
                );
            if (startIndex < 0 || startIndex >= sources.length) {
                return { items: [], nextAfterOrdinal: null };
            }
            const items = sources.slice(startIndex, startIndex + pageSize);
            const hasMore = startIndex + items.length < sources.length;
            return {
                items,
                nextAfterOrdinal: hasMore
                    ? items.at(-1)?.sortOrdinal ?? null
                    : null,
            };
        },
    });
}
