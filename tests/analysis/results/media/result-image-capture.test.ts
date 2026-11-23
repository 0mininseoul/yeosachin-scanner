import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { currentDevStandardArchive, DevStandardArchiveError } from '@/lib/services/dev-ui/standard-archive-runtime';
import { archiveMediaUrlAnchor } from '@/lib/services/dev-ui/standard-archive-media-identity';
import { SecureImageFetchError } from '../../../../lib/services/media/secure-image-fetch';
import {
    captureResultImages,
    type ResultImageCaptureSource,
} from '../../../../lib/services/media/result-image-capture';
import type {
    ResultImageRegistryOutcome,
} from '../../../../lib/services/media/result-image-registry';

vi.mock('@/lib/services/dev-ui/standard-archive-runtime', async importOriginal => ({
    ...await importOriginal<typeof import('@/lib/services/dev-ui/standard-archive-runtime')>(),
    currentDevStandardArchive: vi.fn().mockReturnValue(null),
}));

function installArchive(mode: 'capture' | 'replay', stored: Map<string, unknown>) {
    const fail = (): never => { throw new DevStandardArchiveError(); };
    const scope = {
        mode,
        fail,
        ready: () => true,
        beginPreflightCapture: vi.fn(),
        capture: vi.fn(async (kind, identity, value) => { stored.set(JSON.stringify([kind, identity]), value); }),
        load: vi.fn(async (kind, identity) => stored.get(JSON.stringify([kind, identity])) ?? fail()),
        find: vi.fn(async (kind, identity) => {
            const key = JSON.stringify([kind, identity]);
            return stored.has(key) ? { value: stored.get(key) } : null;
        }),
        seal: vi.fn(async () => undefined),
    } satisfies NonNullable<ReturnType<typeof currentDevStandardArchive>>;
    vi.mocked(currentDevStandardArchive).mockReturnValue(scope);
    return scope;
}

afterEach(() => vi.mocked(currentDevStandardArchive).mockReturnValue(null));

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

    it('reuses checked WebP and explicit source absence without an external download', async () => {
        const rows = [
            source(0, { sourceUrl: 'https://cdninstagram.com/0.jpg?oh=mock-signature' }),
            source(1, { kind: 'private', candidateLocator: 'candidate:private', sourceUrl: null }),
        ];
        const archived = new Map<string, unknown>();
        const capture = installArchive('capture', archived);
        const bytes = await sharp({
            create: { width: 1, height: 1, channels: 3, background: '#123456' },
        }).webp().toBuffer();
        const download = vi.fn(async (url: string) => ({
            bytes: Buffer.from('synthetic source'), contentType: 'image/jpeg', finalUrl: url,
        }));
        const normalize = vi.fn(async () => ({
            bytes, contentType: 'image/webp' as const, width: 1, height: 1, sha256: digest(bytes),
        }));
        const input = {
            ...CLAIM,
            orderedManifestHash: MANIFEST_HASH,
            expectedRows: rows.length,
            loadSourcePage: async () => ({ items: rows, nextAfterOrdinal: null }),
            hmacSecret: HMAC_SECRET,
            download,
            normalize,
            now: () => NOW,
        };
        const makeStore = () => ({
            put: vi.fn(),
            head: vi.fn(async ({ expectedByteSize, expectedSha256 }: {
                expectedByteSize: number; expectedSha256: string;
            }) => ({ byteSize: expectedByteSize, sha256: expectedSha256 })),
        });

        await captureResultImages({ ...input, registry: registry(), store: makeStore() });
        expect(download).toHaveBeenCalledOnce();
        expect(capture.capture).toHaveBeenCalledWith(
            'result-image-v1', ['private', 'candidate:private', null], 'source_missing',
        );

        download.mockClear();
        normalize.mockClear();
        // A redelivery can have no durable image-row yet even after the archive write.
        await captureResultImages({ ...input, registry: registry(), store: makeStore() });
        expect(download).not.toHaveBeenCalled();
        expect(normalize).not.toHaveBeenCalled();
        expect(capture.capture).toHaveBeenCalledTimes(2);

        installArchive('replay', archived);
        const replayInput = {
            ...input,
            loadSourcePage: async () => ({
                items: rows.map(item => ({
                    ...item,
                    sourceUrl: item.sourceUrl === null ? null : archiveMediaUrlAnchor(item.sourceUrl),
                })),
                nextAfterOrdinal: null,
            }),
        };
        const nextRegistry = registry();
        const nextStore = makeStore();
        await captureResultImages({
            ...replayInput,
            requestId: 'aee1957d-ba2b-4c61-a72c-dfaac8d17185',
            registry: nextRegistry,
            store: nextStore,
        });
        expect(download).not.toHaveBeenCalled();
        expect(normalize).not.toHaveBeenCalled();
        expect(nextStore.put).toHaveBeenCalledWith(expect.objectContaining({ bytes, sha256: digest(bytes) }));
        expect(nextRegistry.registerOutcome).toHaveBeenCalledWith(expect.objectContaining({
            outcome: expect.objectContaining({ kind: 'private', status: 'source_missing' }),
        }));

        archived.delete(JSON.stringify(['result-image-v1', ['private', 'candidate:private', null]]));
        const incompleteRegistry = registry();
        await expect(captureResultImages({
            ...replayInput,
            registry: incompleteRegistry,
            store: makeStore(),
        })).rejects.toBeInstanceOf(DevStandardArchiveError);
        expect(download).not.toHaveBeenCalled();
        expect(incompleteRegistry.sealManifest).not.toHaveBeenCalled();
    });

    it('captures and replays optional image failure without treating it as a missing source', async () => {
        const optional = source(4);
        const archived = new Map<string, unknown>();
        const capture = installArchive('capture', archived);
        const download = vi.fn(async (): Promise<never> => { throw new Error('synthetic download failure'); });
        const live = registry();
        const store = { put: vi.fn(), head: vi.fn() };
        const settings = {
            ...CLAIM, orderedManifestHash: MANIFEST_HASH, expectedRows: 1,
            hmacSecret: HMAC_SECRET, download, store, now: () => NOW,
        };
        await captureResultImages({
            ...settings, registry: live,
            loadSourcePage: async () => ({ items: [optional], nextAfterOrdinal: null }),
        });
        expect(capture.capture).toHaveBeenCalledOnce();
        expect(capture.capture).toHaveBeenCalledWith('result-image-v1', expect.any(Array), {
            status: 'capture_failed', failureCode: 'CAPTURE_FAILED',
        });
        expect(live.registerOutcome).toHaveBeenCalledWith(expect.objectContaining({
            outcome: expect.objectContaining({ status: 'capture_failed', isMandatory: false }),
        }));
        installArchive('replay', archived);
        download.mockClear();
        const replay = registry();
        const replayImage = { ...optional, sourceUrl: archiveMediaUrlAnchor(optional.sourceUrl!) };
        await captureResultImages({
            ...settings, registry: replay,
            loadSourcePage: async () => ({ items: [replayImage], nextAfterOrdinal: null }),
        });
        expect(download).not.toHaveBeenCalled();
        expect(store.put).not.toHaveBeenCalled();
        expect(replay.registerOutcome).toHaveBeenCalledWith(expect.objectContaining({
            outcome: expect.objectContaining({ status: 'capture_failed', failureCode: 'CAPTURE_FAILED' }),
        }));
        await expect(captureResultImages({
            ...settings, registry: registry(),
            loadSourcePage: async () => ({ items: [{ ...replayImage, sortOrdinal: 2 }], nextAfterOrdinal: null }),
        })).rejects.toBeInstanceOf(DevStandardArchiveError);
        expect(download).not.toHaveBeenCalled();
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

    it.each(['capture_failed', 'ready'] as const)(
        'preserves the existing %s receipt when its source cannot be recaptured',
        async status => {
            const row = source(0);
            const existing = {
                kind: row.kind,
                candidateLocator: row.candidateLocator,
                sortOrdinal: row.sortOrdinal,
                sourceFingerprint: digest(row.sourceUrl!),
                status,
                objectKey: status === 'ready' ? `v1/${'1'.repeat(32)}/target/${'2'.repeat(32)}.webp` : null,
                sha256: status === 'ready' ? 'c'.repeat(64) : null,
                byteSize: status === 'ready' ? 100 : null,
                capturedAt: status === 'ready' ? new Date(NOW).toISOString() : null,
                expiresAt: new Date(NOW + 30 * 86_400_000).toISOString(),
                failureCode: status === 'ready' ? null : 'UPSTREAM_UNAVAILABLE',
                isMandatory: true,
            };
            const notReady = new Error('ANALYSIS_V2_RESULT_IMAGE_MANIFEST_NOT_READY');
            const imageRegistry = registry({
                loadManifestPage: vi.fn(async () => [existing]),
                sealManifest: vi.fn().mockRejectedValue(notReady),
            });
            const put = vi.fn();
            await expect(captureResultImages({
                ...CLAIM,
                orderedManifestHash: MANIFEST_HASH,
                expectedRows: 1,
                loadSourcePage: async () => ({ items: [row], nextAfterOrdinal: null }),
                registry: imageRegistry,
                store: { put, head: vi.fn().mockRejectedValue(new Error('missing object')) },
                hmacSecret: HMAC_SECRET,
                download: vi.fn().mockRejectedValue(new SecureImageFetchError('source_rejected', 'permanent', 'denied')),
                now: () => NOW + 5_000,
            })).rejects.toThrow('ANALYSIS_V2_RESULT_IMAGE_MANIFEST_NOT_READY');

            expect(imageRegistry.registerOutcome).not.toHaveBeenCalled();
            expect(imageRegistry.sealManifest).toHaveBeenCalledTimes(status === 'ready' ? 0 : 1);
            expect(put).not.toHaveBeenCalled();
        },
    );

    it('finishes in-flight registrations before releasing a failed page and skips later images', async () => {
        let finishRegistration!: () => void;
        const pending = new Promise<void>(resolve => { finishRegistration = resolve; });
        const attempted: number[] = [];
        const imageRegistry = registry({
            registerOutcome: vi.fn(async ({ outcome }: { outcome: ResultImageRegistryOutcome }) => {
                attempted.push(outcome.sortOrdinal);
                if (outcome.sortOrdinal === 0) throw new Error('registry unavailable');
                await pending;
                return { registered: true, status: outcome.status };
            }),
        });
        let returned = false;
        const capture = captureResultImages({
            ...CLAIM,
            orderedManifestHash: MANIFEST_HASH,
            expectedRows: 3,
            loadSourcePage: async () => ({
                items: [0, 1, 2].map(i => source(i, { sourceUrl: null })),
                nextAfterOrdinal: null,
            }),
            concurrency: 2,
            registry: imageRegistry,
            store: { put: vi.fn(), head: vi.fn() },
            hmacSecret: HMAC_SECRET,
        }).catch(error => { returned = true; return error; });
        await new Promise(resolve => setImmediate(resolve));
        const returnedWhileRegistrationPending = returned;
        finishRegistration();
        expect(await capture).toMatchObject({ message: 'registry unavailable' });
        expect(returnedWhileRegistrationPending).toBe(false);
        expect(attempted).toEqual([0, 1]);
        expect(imageRegistry.sealManifest).not.toHaveBeenCalled();
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
