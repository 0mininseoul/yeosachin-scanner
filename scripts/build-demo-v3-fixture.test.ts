import { describe, expect, it } from 'vitest';
import { assertUniqueFixture } from './build-demo-v3-fixture';

describe('v4 fixture builder uniqueness contract', () => {
    it('rejects a public/private duplicate source image ordinal or synthetic identifier', () => {
        expect(() => assertUniqueFixture({
            public: [{ imageSortOrdinal: 1, instagramId: 'demo.public' }],
            private: [{ imageSortOrdinal: 1, instagramId: 'demo.public' }],
        })).toThrow(/across public and private cards/i);
    });
});
