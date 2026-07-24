import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
    MAX_RESULT_IMAGE_BYTES,
    MAX_RESULT_IMAGE_DIMENSION,
    normalizeResultImage,
} from './result-image-normalizer';

async function createAnimatedGif(): Promise<Buffer> {
    const width = 32;
    const height = 32;
    const firstFrame = Buffer.alloc(width * height * 3, 0);
    const secondFrame = Buffer.alloc(width * height * 3, 255);

    return sharp(
        Buffer.concat([firstFrame, secondFrame]),
        {
            raw: {
                width,
                height: height * 2,
                channels: 3,
                pageHeight: height,
            },
        }
    )
        .gif({ delay: [100, 100], loop: 0 })
        .toBuffer();
}

describe('normalizeResultImage', () => {
    it('normalizes a rotated source into a bounded metadata-free WebP', async () => {
        const input = await sharp({
            create: {
                width: 640,
                height: 320,
                channels: 3,
                background: '#9f1239',
            },
        })
            .jpeg()
            .withMetadata({ orientation: 6 })
            .toBuffer();

        const result = await normalizeResultImage(input);
        const metadata = await sharp(result.bytes).metadata();

        expect(result.contentType).toBe('image/webp');
        expect(result.bytes.byteLength).toBeLessThanOrEqual(MAX_RESULT_IMAGE_BYTES);
        expect(result.width).toBeLessThanOrEqual(MAX_RESULT_IMAGE_DIMENSION);
        expect(result.height).toBeLessThanOrEqual(MAX_RESULT_IMAGE_DIMENSION);
        expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(result.sha256).toBe(
            createHash('sha256').update(result.bytes).digest('hex')
        );
        expect(metadata.format).toBe('webp');
        expect(metadata.orientation).toBeUndefined();
        expect(metadata.exif).toBeUndefined();
        expect(metadata.icc).toBeUndefined();
    });

    it('keeps only the first frame of an animated source', async () => {
        const input = await createAnimatedGif();
        const inputMetadata = await sharp(input, { animated: true }).metadata();
        expect(inputMetadata.pages).toBe(2);

        const result = await normalizeResultImage(input);
        const outputMetadata = await sharp(result.bytes, { animated: true }).metadata();

        expect(outputMetadata.pages ?? 1).toBe(1);
    });

    it('returns deterministic bytes and digest for the same input', async () => {
        const input = await sharp({
            create: {
                width: 900,
                height: 600,
                channels: 4,
                background: { r: 2, g: 132, b: 199, alpha: 0.4 },
            },
        })
            .png()
            .toBuffer();

        const first = await normalizeResultImage(input);
        const second = await normalizeResultImage(input);

        expect(second).toEqual(first);
    });

    it('rejects malformed bytes with a bounded internal code', async () => {
        await expect(normalizeResultImage(Buffer.from('not-an-image')))
            .rejects.toThrow('RESULT_IMAGE_INVALID_INPUT');
    });

    it('rejects sources above the decoded pixel limit', async () => {
        const input = await sharp({
            create: {
                width: 4_097,
                height: 4_097,
                channels: 3,
                background: '#111827',
            },
        })
            .png({ compressionLevel: 9 })
            .toBuffer();

        await expect(normalizeResultImage(input))
            .rejects.toThrow('RESULT_IMAGE_INVALID_INPUT');
    });
});
