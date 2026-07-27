import { describe, expect, it } from 'vitest';
import * as pure from './v2-ai-result-identity';
import * as durable from './v2-ai-result-store';

describe('pure staged AI identity seam', () => {
    it('is byte-for-byte compatible with the durable production identity', () => {
        const material = {
            stage: 'genderResolution' as const,
            modelName: 'gemini-3-flash-preview',
            thinkingLevel: 'HIGH' as const,
            mediaResolution: 'HIGH' as const,
            promptVersion: 'gender-resolution-v1',
            schemaVersion: 1,
            maxOutputTokens: 512,
            inputHash: pure.createAnalysisV2AiResultInputHash('prompt'),
            mediaSnapshotHash: pure.createAnalysisV2AiMediaSnapshotHashFromParts([{
                selectionId: 'm1', kind: 'feed',
                normalizedJpegBase64: '/9j/2Q==',
            }]),
            cacheScope: 'request' as const,
        };
        expect(pure.createAnalysisV2AiResultIdentity(material))
            .toEqual(durable.createAnalysisV2AiResultIdentity(material));
    });
});
