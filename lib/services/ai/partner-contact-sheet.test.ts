import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { MAX_PARTNER_SAFETY_CONTACT_MEDIA } from '@/lib/domain/analysis/media-policy';
import { createPartnerSafetyContactSheet } from './partner-contact-sheet';

async function image(color: string): Promise<string> {
    return (await sharp({
        create: {
            width: 320,
            height: 180,
            channels: 3,
            background: color,
        },
    }).jpeg().toBuffer()).toString('base64');
}

describe('partner safety contact sheet', () => {
    it('preserves source order in a bounded deterministic manifest', async () => {
        const sources = await Promise.all([
            ['carousel:1', '#ef4444'],
            ['carousel:2', '#22c55e'],
            ['carousel:3', '#3b82f6'],
            ['carousel:4', '#eab308'],
            ['carousel:5', '#a855f7'],
        ].map(async ([selectionId, color]) => ({
            selectionId,
            normalizedJpegBase64: await image(color),
        })));

        const result = await createPartnerSafetyContactSheet(sources);
        const metadata = await sharp(Buffer.from(result.normalizedJpegBase64, 'base64')).metadata();

        expect(result.selectionId).toMatch(/^contact-sheet:[a-f0-9]{64}$/);
        expect(result.sourceSelectionIds).toEqual(sources.map(source => source.selectionId));
        expect({ width: metadata.width, height: metadata.height }).toEqual({
            width: 780,
            height: 388,
        });
        expect(result.width).toBe(metadata.width);
        expect(result.height).toBe(metadata.height);
        expect(metadata.format).toBe('jpeg');
    });

    it('rejects duplicate IDs, malformed images, and an unbounded frame set', async () => {
        const validImage = await image('#111827');
        await expect(createPartnerSafetyContactSheet([
            { selectionId: 'duplicate', normalizedJpegBase64: validImage },
            { selectionId: 'duplicate', normalizedJpegBase64: validImage },
        ])).rejects.toThrow();
        await expect(createPartnerSafetyContactSheet([
            { selectionId: 'invalid', normalizedJpegBase64: 'bm90LWEtanBlZw==' },
        ])).rejects.toThrow();
        await expect(createPartnerSafetyContactSheet(Array.from(
            { length: MAX_PARTNER_SAFETY_CONTACT_MEDIA + 1 },
            (_, index) => ({
                selectionId: `frame:${index}`,
                normalizedJpegBase64: validImage,
            })
        ))).rejects.toThrow();
    });
});
