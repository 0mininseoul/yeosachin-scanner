import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SecureImageFetchError } from './secure-image-fetch';
import {
    captureResultImages,
    type ResultImageCaptureSource,
} from './result-image-capture';
import type {
    ResultImageRegistryOutcome,
} from './result-image-registry';

const CLAIM = {
    requestId: '123e4567-e89b-42d3-a456-426614174000',
    jobKey: 'coordinator:finalize',
    claimToken: '223e4567-e89b-42d3-a456-426614174000',
    jobInputHash: 'a'.repeat(64),
};
const MANIFEST_HASH = 'b'.repeat(64);
const HMAC_SECRET = 'result-image-hmac-secret-at-least-32-characters';
const NOW = Date.parse('2026-07-24T05:00:00.000Z');

function digest(value: string | Buffer): string {
    return createHash('sha256').update(value).digest('hex');
}

function source(
    sortOrdinal: number,
    overrides: Partial<ResultImageCaptureSource> = {}
): ResultImageCaptureSource {
    return {
        kind: sortOrdinal === 0 ? 'target' : 'female',
        candidateLocator:
            sortOrdinal === 0 ? 'target' : `candidate:${sortOrdinal}`,
        sortOrdinal,
        sourceUrl: `https://cdninstagram.com/${sortOrdinal}.jpg`,
        ...overrides,
    };
}

function registry(overrides: Record<string, unknown> = {}) {
    return {
        beginManifest: vi.fn(async () => ({
            requestId: CLAIM.requestId,
            orderedManifestHash: MANIFEST_HASH,
            expectedRows: 1,
            sealed: false,
        })),
        loadManifestPage: vi.fn(async () => []),
        registerOutcome: vi.fn(async (_input: {
            outcome: ResultImageRegistryOutcome;
        }): Promise<{
            registered: boolean;
            status: ResultImageRegistryOutcome['status'];
        }> => {
            void _input;
            return {
                registered: true,
                status: 'ready',
            };
        }),
        sealManifest: vi.fn(async () => ({
            orderedManifestHash: MANIFEST_HASH,
            expectedRows: 1,
            durableRows: 1,
            sourcedImages: 1,
            readyImages: 1,
            captureFailedImages: 0,
        })),
        claimRepair: vi.fn(),
        completeRepair: vi.fn(),
        claimPurge: vi.fn(),
        completePurge: vi.fn(),
        ...overrides,
    };
}

describe('captureResultImages', () => {
    it('replays a sealed manifest without mutating tolerated gaps', async () => {
        const imageRegistry = registry({
            beginManifest: vi.fn(async () => ({
                requestId: CLAIM.requestId,
                orderedManifestHash: MANIFEST_HASH,
                expectedRows: 2,
                sealed: true,
            })),
            sealManifest: vi.fn(async () => ({
                orderedManifestHash: MANIFEST_HASH,
                expectedRows: 2,
                durableRows: 2,
                sourcedImages: 2,
                readyImages: 1,
                captureFailedImages: 1,
            })),
        });
        const loadSourcePage = vi.fn();
        const store = { put: vi.fn(), head: vi.fn() };

        const result = await captureResultImages({
            ...CLAIM,
            orderedManifestHash: MANIFEST_HASH,
            expectedRows: 2,
            loadSourcePage,
            registry: imageRegistry,
            store,
            hmacSecret: HMAC_SECRET,
            download: vi.fn(),
            normalize: vi.fn(),
            now: () => NOW,
        });

        expect(result.captureFailedImages).toBe(1);
        expect(loadSourcePage).not.toHaveBeenCalled();
        expect(imageRegistry.loadManifestPage).not.toHaveBeenCalled();
        expect(imageRegistry.registerOutcome).not.toHaveBeenCalled();
        expect(store.put).not.toHaveBeenCalled();
        expect(store.head).not.toHaveBeenCalled();
        expect(imageRegistry.sealManifest).toHaveBeenCalledOnce();
    });

    it('captures a mixed manifest with at most eight concurrent image buffers', async () => {
        const rows = [
            source(0),
            ...Array.from({ length: 10 }, (_, index) => source(index + 1)),
            source(11, {
                kind: 'private',
                candidateLocator: 'candidate:private',
                sourceUrl: null,
            }),
        ];
        const events: string[] = [];
        let activeDownloads = 0;
        let maxActiveDownloads = 0;
        const attempts = new Map<string, number>();
        const download = vi.fn(async (url: string) => {
            activeDownloads += 1;
            maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads);
            await Promise.resolve();
            activeDownloads -= 1;
            const nextAttempt = (attempts.get(url) ?? 0) + 1;
            attempts.set(url, nextAttempt);
            if (url.endsWith('/10.jpg')) {
                throw new SecureImageFetchError(
                    'upstream_unavailable',
                    'transient',
                    'provider detail must not escape'
                );
            }
            return {
                bytes: Buffer.from(url),
                contentType: 'image/jpeg',
                finalUrl: url,
            };
        });
        const normalize = vi.fn(async (
            bytes: Buffer | Uint8Array
        ) => {
            const normalized = Buffer.from(
                `webp:${Buffer.from(bytes).toString('utf8')}`
            );
            return {
                bytes: normalized,
                contentType: 'image/webp' as const,
                width: 256,
                height: 256,
                sha256: digest(normalized),
            };
        });
        const store = {
            put: vi.fn(async ({ objectKey }: { objectKey: string }) => {
                events.push(`put:${objectKey}`);
            }),
            head: vi.fn(async ({ objectKey, expectedByteSize, expectedSha256 }: {
                objectKey: string;
                expectedByteSize: number;
                expectedSha256: string;
            }) => {
                events.push(`head:${objectKey}`);
                return {
                    byteSize: expectedByteSize,
                    sha256: expectedSha256,
                };
            }),
        };
        const imageRegistry = registry({
            sealManifest: vi.fn(async () => ({
                orderedManifestHash: MANIFEST_HASH,
                expectedRows: rows.length,
                durableRows: rows.length,
                sourcedImages: rows.length - 1,
                readyImages: rows.length - 2,
                captureFailedImages: 1,
            })),
        });
        vi.mocked(imageRegistry.registerOutcome).mockImplementation(
            async ({ outcome }) => {
                events.push(`register:${outcome.status}:${outcome.sortOrdinal}`);
                return { registered: true, status: outcome.status };
            }
        );

        const result = await captureResultImages({
            ...CLAIM,
            orderedManifestHash: MANIFEST_HASH,
            expectedRows: rows.length,
            loadSourcePage: async ({ afterOrdinal }) => (
                afterOrdinal < 0
                    ? { items: rows, nextAfterOrdinal: null }
                    : { items: [], nextAfterOrdinal: null }
            ),
            registry: imageRegistry,
            store,
            hmacSecret: HMAC_SECRET,
            download,
            normalize,
            now: () => NOW,
        });

        expect(result.captureFailedImages).toBe(1);
        expect(maxActiveDownloads).toBeLessThanOrEqual(8);
        expect(attempts.get('https://cdninstagram.com/10.jpg')).toBe(3);
        const outcomes = vi.mocked(imageRegistry.registerOutcome).mock.calls
            .map(call => call[0]!.outcome);
        expect(outcomes.find(row => row.sortOrdinal === 10)).toMatchObject({
            status: 'capture_failed',
            failureCode: 'UPSTREAM_UNAVAILABLE',
        });
        expect(outcomes.find(row => row.sortOrdinal === 11)).toMatchObject({
            status: 'source_missing',
            sourceFingerprint: null,
        });
        for (const ready of outcomes.filter(row => row.status === 'ready')) {
            expect(
                events.indexOf(`head:${ready.objectKey}`)
            ).toBeLessThan(
                events.indexOf(`register:ready:${ready.sortOrdinal}`)
            );
        }
    });

    it('head-verifies and skips a replayed ready object', async () => {
        const row = source(0);
        const sourceFingerprint = digest(row.sourceUrl!);
        const existing = {
            kind: 'target' as const,
            candidateLocator: 'target',
            sortOrdinal: 0,
            sourceFingerprint,
            status: 'ready' as const,
            objectKey: `v1/${'1'.repeat(32)}/target/${'2'.repeat(32)}.webp`,
            sha256: 'c'.repeat(64),
            byteSize: 1234,
            capturedAt: '2026-07-24T05:00:00.000Z',
            expiresAt: '2026-08-23T05:00:00.000Z',
            failureCode: null,
            isMandatory: true,
        };
        const imageRegistry = registry({
            loadManifestPage: vi.fn(async () => [existing]),
        });
        const store = {
            put: vi.fn(),
            head: vi.fn(async () => ({
                byteSize: existing.byteSize,
                sha256: existing.sha256,
            })),
        };
        const download = vi.fn();

        await captureResultImages({
            ...CLAIM,
            orderedManifestHash: MANIFEST_HASH,
            expectedRows: 1,
            loadSourcePage: async () => ({
                items: [row],
                nextAfterOrdinal: null,
            }),
            registry: imageRegistry,
            store,
            hmacSecret: HMAC_SECRET,
            download,
            normalize: vi.fn(),
            now: () => NOW,
        });

        expect(store.head).toHaveBeenCalledOnce();
        expect(store.put).not.toHaveBeenCalled();
        expect(download).not.toHaveBeenCalled();
        expect(imageRegistry.registerOutcome).not.toHaveBeenCalled();
    });

    it('processes a 50,000-row source through one bounded page at a time', async () => {
        const expectedRows = 50_000;
        const pageSize = 500;
        let registrationsInFlight = 0;
        let maxRegistrationsInFlight = 0;
        let maxPageSize = 0;
        const imageRegistry = registry({
            registerOutcome: vi.fn(async () => {
                registrationsInFlight += 1;
                maxRegistrationsInFlight = Math.max(
                    maxRegistrationsInFlight,
                    registrationsInFlight
                );
                await Promise.resolve();
                registrationsInFlight -= 1;
                return { registered: true, status: 'source_missing' as const };
            }),
            sealManifest: vi.fn(async () => ({
                orderedManifestHash: MANIFEST_HASH,
                expectedRows,
                durableRows: expectedRows,
                sourcedImages: 0,
                readyImages: 0,
                captureFailedImages: 0,
            })),
        });

        const result = await captureResultImages({
            ...CLAIM,
            orderedManifestHash: MANIFEST_HASH,
            expectedRows,
            pageSize,
            loadSourcePage: async ({ afterOrdinal, pageSize: requested }) => {
                expect(registrationsInFlight).toBe(0);
                const firstOrdinal = afterOrdinal < 0
                    ? 1
                    : afterOrdinal + 1;
                if (firstOrdinal > expectedRows) {
                    return { items: [], nextAfterOrdinal: null };
                }
                const count = Math.min(
                    requested,
                    expectedRows - firstOrdinal + 1
                );
                const items = Array.from({ length: count }, (_, index) => ({
                    kind: 'female' as const,
                    candidateLocator:
                        `candidate:${firstOrdinal + index}`,
                    sortOrdinal: firstOrdinal + index,
                    sourceUrl: null,
                }));
                maxPageSize = Math.max(maxPageSize, items.length);
                const last = items.at(-1)!.sortOrdinal;
                return {
                    items,
                    nextAfterOrdinal:
                        last < expectedRows ? last : null,
                };
            },
            registry: imageRegistry,
            store: { put: vi.fn(), head: vi.fn() },
            hmacSecret: HMAC_SECRET,
            download: vi.fn(),
            normalize: vi.fn(),
            now: () => NOW,
        });

        expect(result.durableRows).toBe(expectedRows);
        expect(maxPageSize).toBe(pageSize);
        expect(maxRegistrationsInFlight).toBeLessThanOrEqual(8);
        expect(imageRegistry.registerOutcome).toHaveBeenCalledTimes(expectedRows);
    }, 20_000);
});
