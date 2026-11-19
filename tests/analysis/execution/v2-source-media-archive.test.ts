import { describe, expect, it, vi } from 'vitest';
import {
    analysisV2SourceMediaArchiveId,
    analysisV2SourceMediaArchiveObjectName,
    createAnalysisV2SourceMediaArchiveStore,
} from '../../../lib/services/analysis/v2-source-media-archive';
import {
    createGoogleCloudPrivateMediaObjectClient,
    serializeAnalysisV2MediaBundle,
    type AnalysisV2PrivateRetainedMediaObjectClient,
    type GoogleCloudStorageAuthorizedRequester,
} from '../../../lib/services/analysis/v2-media-artifact-store';

const requestId = '10000000-0000-4000-8000-000000000001';
const jpeg = Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9]);
const jpeg2 = Buffer.from([0xff, 0xd8, 0x02, 0xff, 0xd9]);

describe('Analysis V2 30-day source-media archive', () => {
    it('derives a deterministic opaque object name without exposing the candidate or stage', () => {
        const archiveId = analysisV2SourceMediaArchiveId({
            candidateId: 'candidate:opaque',
            stage: 'feature_remainder',
        });
        const objectName = analysisV2SourceMediaArchiveObjectName({ requestId, archiveId });

        expect(objectName).toMatch(
            /^analysis-v2-retained\/[a-f0-9]{64}\/[a-f0-9]{64}\.bin$/
        );
        expect(objectName).not.toContain(requestId);
        expect(objectName).not.toContain('candidate');
        expect(objectName).not.toContain('feature');
    });

    it('rejects an unrecognized runtime stage even when a caller bypasses TypeScript', () => {
        expect(() => analysisV2SourceMediaArchiveId({
            candidateId: 'candidate:opaque',
            stage: 'partner_contact_sheet',
        })).not.toThrow();
        expect(() => analysisV2SourceMediaArchiveId({
            candidateId: 'candidate:opaque',
            stage: 'raw_source' as never,
        })).toThrow('invalid archive stage');
    });

    it('persists normalized media as one idempotent integrity-checked bundle and reloads it', async () => {
        let bytes: Buffer | null = null;
        const objects: AnalysisV2PrivateRetainedMediaObjectClient = {
            createRetained: vi.fn(async input => {
                bytes = Buffer.from(input.bytes);
                return { created: true, generation: '1234567890123456' };
            }),
            readRetained: vi.fn(async () => bytes),
        };
        const store = createAnalysisV2SourceMediaArchiveStore({ objects });
        const archiveId = analysisV2SourceMediaArchiveId({
            candidateId: 'candidate:opaque',
            stage: 'triage',
        });

        const contentSha256 = await store.persistBundle({
            requestId,
            archiveId,
            media: [
                { selectionId: 'profile:opaque', normalizedJpeg: jpeg },
                { selectionId: 'post:opaque', normalizedJpeg: jpeg2 },
            ],
        });

        expect(objects.createRetained).toHaveBeenCalledWith(expect.objectContaining({
            objectName: analysisV2SourceMediaArchiveObjectName({ requestId, archiveId, contentSha256 }),
            contentType: 'application/octet-stream',
        }));
        await expect(store.loadBundle({
            requestId,
            archiveId,
            contentSha256,
            expectedSelectionIds: ['profile:opaque', 'post:opaque'],
        })).resolves.toEqual([
            { selectionId: 'profile:opaque', normalizedJpeg: jpeg },
            { selectionId: 'post:opaque', normalizedJpeg: jpeg2 },
        ]);
    });

    it('returns null for a legacy request with no retained object', async () => {
        const store = createAnalysisV2SourceMediaArchiveStore({
            objects: {
                createRetained: vi.fn(),
                readRetained: vi.fn(async () => null),
            },
        });
        await expect(store.loadBundle({
            requestId,
            archiveId: analysisV2SourceMediaArchiveId({
                candidateId: 'candidate:legacy',
                stage: 'feature_remainder',
            }),
            expectedSelectionIds: ['profile:opaque'],
        })).resolves.toBeNull();
    });

    it('preserves both revisions when a profile retry normalizes a different selection', async () => {
        const writes = new Map<string, Buffer>();
        const request = async <T>(
            options: Parameters<GoogleCloudStorageAuthorizedRequester['request']>[0]
        ) => {
            const name = options.params?.name
                ?? decodeURIComponent(options.url.slice(options.url.lastIndexOf('/') + 1));
            if (options.method === 'POST') {
                if (writes.has(name)) throw Object.assign(new Error('precondition'), { code: 412 });
                writes.set(name, Buffer.from(options.data!));
            }
            const bytes = writes.get(name);
            if (!bytes) throw Object.assign(new Error('not found'), { code: 404 });
            const data = options.responseType === 'arraybuffer' ? bytes : {
                name,
                generation: '1234567890123456',
                size: String(bytes.length),
                contentType: 'application/octet-stream',
            };
            return { data: data as T };
        };
        const store = createAnalysisV2SourceMediaArchiveStore({
            objects: createGoogleCloudPrivateMediaObjectClient({
                bucketName: 'private-artifacts-1',
                requester: { request },
            }),
        });
        const archiveId = analysisV2SourceMediaArchiveId({
            candidateId: 'candidate:opaque',
            stage: 'feature_remainder',
        });
        const firstMedia = [{ selectionId: 'post:opaque', normalizedJpeg: jpeg }];
        const retryMedia = [
            ...firstMedia,
            { selectionId: 'post:recovered', normalizedJpeg: jpeg2 },
        ];
        const source = { requestId, archiveId };
        const legacyName = analysisV2SourceMediaArchiveObjectName(source);
        writes.set(legacyName, serializeAnalysisV2MediaBundle(firstMedia));
        const first = await store.persistBundle({ ...source, media: firstMedia });
        const retry = await store.persistBundle({ ...source, media: retryMedia });
        expect(first).not.toBe(retry);
        await expect(store.persistBundle({ ...source, media: retryMedia })).resolves.toBe(retry);
        expect(writes.size).toBe(3);
        await expect(store.loadBundle({
            ...source,
            expectedSelectionIds: firstMedia.map(item => item.selectionId),
        })).resolves.toEqual(firstMedia);
        await expect(store.loadBundle({
            requestId, archiveId, contentSha256: first,
            expectedSelectionIds: firstMedia.map(item => item.selectionId),
        })).resolves.toEqual(firstMedia);
        await expect(store.loadBundle({
            requestId, archiveId, contentSha256: retry,
            expectedSelectionIds: retryMedia.map(item => item.selectionId),
        })).resolves.toEqual(retryMedia);
        await expect(store.loadBundle({
            requestId, archiveId, contentSha256: retry,
            expectedSelectionIds: firstMedia.map(item => item.selectionId),
        })).rejects.toThrow('bundle selection mismatch');
        // A well-formed bundle from a different revision cannot pass the recorded digest.
        const firstName = analysisV2SourceMediaArchiveObjectName({ ...source, contentSha256: first });
        const retryName = analysisV2SourceMediaArchiveObjectName({ ...source, contentSha256: retry });
        writes.set(firstName, writes.get(retryName)!);
        await expect(store.loadBundle({
            requestId, archiveId, contentSha256: first,
            expectedSelectionIds: retryMedia.map(item => item.selectionId),
        })).rejects.toThrow('content mismatch');
    });
});
