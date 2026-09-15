import { describe, expect, it } from 'vitest';
import {
    CURRENT_ANALYSIS_PIPELINE_VERSION,
    LEGACY_ANALYSIS_PIPELINE_VERSION,
    resolvePersistedPipelineVersion,
    usesV2ReadContract,
} from '../../../../lib/domain/analysis/pipeline-version';

describe('analysis pipeline dual-read policy', () => {
    it('keeps pre-version rows on the legacy V1 mapper', () => {
        for (const version of [undefined, null, '']) {
            expect(resolvePersistedPipelineVersion(version))
                .toBe(LEGACY_ANALYSIS_PIPELINE_VERSION);
            expect(usesV2ReadContract(version)).toBe(false);
        }
    });

    it('routes only explicitly versioned V2 rows to the V2 mapper', () => {
        expect(resolvePersistedPipelineVersion('v1')).toBe('v1');
        expect(resolvePersistedPipelineVersion('v2')).toBe(CURRENT_ANALYSIS_PIPELINE_VERSION);
        expect(usesV2ReadContract('v2')).toBe(true);
    });

    it('fails closed for unknown future or malformed persisted values', () => {
        for (const version of ['V2', 'v3', ' v2 ', 'unknown']) {
            expect(() => resolvePersistedPipelineVersion(version))
                .toThrow('unsupported persisted version');
        }
    });
});
