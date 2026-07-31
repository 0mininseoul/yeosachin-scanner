import { describe, expect, it } from 'vitest';
import { projectGenderResolutionMedia } from './gender-resolution-pure';

const media = Array.from({ length: 10 }, (_, index) => ({
    selectionId: `m${index + 1}`,
    kind: 'feed' as const,
    normalizedJpegBase64: '/9j/2Q==',
}));

describe('gender resolution projection policy isolation', () => {
    it('preserves the legacy prompt and five-image projection unless v2.11 is explicit', () => {
        const legacy = projectGenderResolutionMedia(media);
        const v211 = projectGenderResolutionMedia(media, 8, true);

        expect(legacy.media).toHaveLength(4);
        expect(legacy.prompt).not.toContain('반복해서 보이는');
        expect(v211.media).toHaveLength(8);
        expect(v211.prompt).toContain('반복해서 보이는');
    });
});
