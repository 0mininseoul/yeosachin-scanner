import { describe, expect, it, vi } from 'vitest';
import {
    analysisV2SourceMediaArchiveId,
    analysisV2SourceMediaArchiveObjectName,
    createAnalysisV2SourceMediaArchiveStore,
} from './v2-source-media-archive';
import type {
    AnalysisV2PrivateRetainedMediaObjectClient,
} from './v2-media-artifact-store';

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

        await store.persistBundle({
            requestId,
            archiveId,
            media: [
                { selectionId: 'profile:opaque', normalizedJpeg: jpeg },
                { selectionId: 'post:opaque', normalizedJpeg: jpeg2 },
            ],
        });

        expect(objects.createRetained).toHaveBeenCalledWith(expect.objectContaining({
            objectName: analysisV2SourceMediaArchiveObjectName({ requestId, archiveId }),
            contentType: 'application/octet-stream',
        }));
        await expect(store.loadBundle({
            requestId,
            archiveId,
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
});
