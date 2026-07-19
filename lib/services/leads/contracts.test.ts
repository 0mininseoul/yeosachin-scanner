import { describe, expect, it } from 'vitest';
import { landingLeadRequestSchema, normalizeLeadInstagramId } from './contracts';

describe('normalizeLeadInstagramId', () => {
    it('strips a leading @, trims, and lowercases', () => {
        expect(normalizeLeadInstagramId('  @Suzy_Kim.02 ')).toBe('suzy_kim.02');
    });
    it('rejects empty, invalid chars, and dot-edge/consecutive-dot forms', () => {
        expect(normalizeLeadInstagramId('')).toBeNull();
        expect(normalizeLeadInstagramId('@')).toBeNull();
        expect(normalizeLeadInstagramId('bad name')).toBeNull();
        expect(normalizeLeadInstagramId('.leading')).toBeNull();
        expect(normalizeLeadInstagramId('trailing.')).toBeNull();
        expect(normalizeLeadInstagramId('double..dot')).toBeNull();
        expect(normalizeLeadInstagramId('a'.repeat(31))).toBeNull();
    });
    it('rejects non-string input', () => {
        expect(normalizeLeadInstagramId(123)).toBeNull();
        expect(normalizeLeadInstagramId(null)).toBeNull();
    });
});

describe('landingLeadRequestSchema', () => {
    it('accepts a minimal body', () => {
        const parsed = landingLeadRequestSchema.safeParse({ instagramId: 'suzy' });
        expect(parsed.success).toBe(true);
    });
    it('accepts attribution + referrer within limits', () => {
        const parsed = landingLeadRequestSchema.safeParse({
            instagramId: 'suzy',
            rawInput: '@Suzy',
            attribution: { source: 'instagram', medium: 'cpc' },
            referrer: 'https://example.com/x',
        });
        expect(parsed.success).toBe(true);
    });
    it('rejects missing instagramId and oversize fields', () => {
        expect(landingLeadRequestSchema.safeParse({}).success).toBe(false);
        expect(landingLeadRequestSchema.safeParse({
            instagramId: 'suzy', rawInput: 'x'.repeat(101),
        }).success).toBe(false);
        expect(landingLeadRequestSchema.safeParse({
            instagramId: 'suzy', referrer: 'x'.repeat(501),
        }).success).toBe(false);
    });
});
