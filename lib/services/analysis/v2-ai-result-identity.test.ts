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

    it('preserves the production identity serialization and error contract', () => {
        const inputHash = pure.createAnalysisV2AiResultInputHash('prompt');
        const mediaSnapshotHash =
            pure.createAnalysisV2AiMediaSnapshotHashFromParts([{
                selectionId: 'm1',
                kind: 'feed',
                normalizedJpegBase64: '/9j/2Q==',
            }]);

        expect(inputHash).toBe(
            '78cc68c2b900fb10440f203e2b188f5194fd6b39fa3797adacf1071ad4357279',
        );
        expect(mediaSnapshotHash).toBe(
            'fbee600b899d58b9554af68076d9b455d073deb03468072a24b8ead087b1da45',
        );
        expect(pure.createAnalysisV2AiResultIdentity({
            stage: 'genderResolution',
            modelName: 'gemini-3-flash-preview',
            thinkingLevel: 'HIGH',
            mediaResolution: 'HIGH',
            promptVersion: 'gender-resolution-v1',
            schemaVersion: 1,
            maxOutputTokens: 512,
            inputHash,
            mediaSnapshotHash,
            cacheScope: 'request',
        })).toMatchObject({
            cacheKey:
                '404f452cb0409e3dcb15d3483d5e3217094addb21e31604d20ce4c2a01f759ff',
            operationKey:
                'gender-resolution:404f452cb0409e3dcb15d3483d5e3217094addb21e31604d20ce4c2a01f759ff',
        });
        expect(() => pure.createAnalysisV2AiResultIdentity({
            stage: 'genderResolution',
            modelName: 'gemini-3-flash-preview',
            thinkingLevel: 'HIGH',
            mediaResolution: 'HIGH',
            promptVersion: 'gender-resolution-v1',
            schemaVersion: 1,
            maxOutputTokens: 512,
            inputHash,
            mediaSnapshotHash,
            cacheScope: 'global_ttl',
        })).toThrow(
            'ANALYSIS_V2_AI_RESULT_VALIDATION_ERROR: invalid result identity.',
        );
    });
});
