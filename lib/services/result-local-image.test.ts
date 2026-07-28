import { describe, expect, it } from 'vitest';
import { safeResultImageUrl } from './result-local-image';

describe('safeResultImageUrl', () => {
    it('allows only the existing proxy and local demo avatar paths', () => {
        expect(safeResultImageUrl('/api/image-proxy?token=signed')).toBe('/api/image-proxy?token=signed');
        expect(safeResultImageUrl('/demo-avatars/synthetic-blurred-avatar-1-v1.png'))
            .toBe('/demo-avatars/synthetic-blurred-avatar-1-v1.png');
        expect(safeResultImageUrl('/demo-avatars/demo-v3-target-000.webp'))
            .toBe('/demo-avatars/demo-v3-target-000.webp');
        expect(safeResultImageUrl('/demo-avatars/demo-v3-female-042.webp'))
            .toBe('/demo-avatars/demo-v3-female-042.webp');
        expect(safeResultImageUrl('/demo-avatars/demo-v3-private-229.webp'))
            .toBe('/demo-avatars/demo-v3-private-229.webp');
    });

    it('rejects unknown local paths and all remote paths', () => {
        expect(safeResultImageUrl('/demo-avatars/demo-v3-female-42.webp')).toBeUndefined();
        expect(safeResultImageUrl('/demo-avatars/demo-v3-other-001.webp')).toBeUndefined();
        expect(safeResultImageUrl('https://example.test/avatar.webp')).toBeUndefined();
        expect(safeResultImageUrl('//example.test/avatar.webp')).toBeUndefined();
    });
});
