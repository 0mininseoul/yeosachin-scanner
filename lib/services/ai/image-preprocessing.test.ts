import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import {
    AnalysisImagePreparationError,
    downloadImageBytes,
    COST_OPTIMIZED_MAX_ANALYSIS_IMAGE_DIMENSION,
    DEFAULT_MAX_ANALYSIS_IMAGE_DIMENSION,
    getAnalysisImagePolicy,
    MAX_DECODED_IMAGE_PIXELS,
    normalizeImageToJpeg,
    prepareAnalysisImages,
    runWithImageDecodeSlot,
    selectAnalysisImageCandidates,
} from './image-preprocessing';
import {
    MAX_VERTEX_AI_CONCURRENT_IMAGE_DECODES,
    MAX_VERTEX_AI_CONCURRENT_IMAGE_PREPARATIONS,
    MAX_VERTEX_AI_IMAGE_PREPARATION_CONCURRENCY,
} from './pipeline-config';

const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }];

describe('selectAnalysisImageCandidates', () => {
    it('selects a profile image and at most two unique recent posts', () => {
        const selected = selectAnalysisImageCandidates(' profile.jpg ', [
            'profile.jpg',
            '',
            'post-1.jpg',
            'post-2.jpg',
            'post-3.jpg',
        ], getAnalysisImagePolicy(true));

        expect(selected).toEqual([
            { role: 'profile', url: 'profile.jpg' },
            { role: 'post', url: 'post-1.jpg' },
            { role: 'post', url: 'post-2.jpg' },
        ]);
    });

    it('uses at most two recent posts when there is no profile image', () => {
        const selected = selectAnalysisImageCandidates(undefined, [
            'post-1.jpg',
            'post-2.jpg',
            'post-3.jpg',
        ], getAnalysisImagePolicy(true));

        expect(selected).toHaveLength(2);
        expect(selected.every(image => image.role === 'post')).toBe(true);
    });

    it('keeps one profile image and up to ten post images in the default quality policy', () => {
        const selected = selectAnalysisImageCandidates(
            'profile.jpg',
            Array.from({ length: 12 }, (_, index) => `post-${index + 1}.jpg`),
            getAnalysisImagePolicy(false)
        );

        expect(selected).toHaveLength(11);
        expect(selected[0].role).toBe('profile');
        expect(selected.at(-1)?.url).toBe('post-10.jpg');
    });
});

describe('prepareAnalysisImages', () => {
    it('loads only selected images concurrently and keeps deterministic order', async () => {
        const loadImage = vi.fn(async (url: string) => {
            await new Promise(resolve => setTimeout(resolve, url.includes('profile') ? 10 : 1));
            return `base64:${url}`;
        });

        const prepared = await prepareAnalysisImages(
            'profile.jpg',
            ['post-1.jpg', 'post-2.jpg', 'post-3.jpg'],
            { loadImage, policy: getAnalysisImagePolicy(true) }
        );

        expect(loadImage).toHaveBeenCalledTimes(3);
        expect(prepared.map(image => image.url)).toEqual([
            'profile.jpg',
            'post-1.jpg',
            'post-2.jpg',
        ]);
    });

    it('keeps successful images when one selected download fails', async () => {
        const prepared = await prepareAnalysisImages(
            'profile.jpg',
            ['bad.jpg', 'post-2.jpg'],
            {
                loadImage: async url => {
                    if (url === 'bad.jpg') {
                        throw new Error('download failed');
                    }
                    return `base64:${url}`;
                },
                onError: vi.fn(),
                policy: getAnalysisImagePolicy(true),
            }
        );

        expect(prepared.map(image => image.url)).toEqual(['profile.jpg', 'post-2.jpg']);
    });

    it('does not expose image URLs or nested errors through the default warning', async () => {
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const signedUrl = 'https://cdninstagram.com/private-path.jpg?signature=secret';
        try {
            await prepareAnalysisImages(signedUrl, [], {
                loadImage: async () => {
                    throw new Error('nested secret details');
                },
                policy: getAnalysisImagePolicy(false),
            });

            expect(warning).toHaveBeenCalledWith('Failed to prepare an analysis image');
            const logged = JSON.stringify(warning.mock.calls);
            expect(logged).not.toContain('signature');
            expect(logged).not.toContain('private-path');
            expect(logged).not.toContain('nested secret');
        } finally {
            warning.mockRestore();
        }
    });

    it('bounds per-account image preparation concurrency', async () => {
        let active = 0;
        let maxActive = 0;

        const prepared = await prepareAnalysisImages(
            'profile.jpg',
            Array.from({ length: 10 }, (_, index) => `post-${index + 1}.jpg`),
            {
                policy: getAnalysisImagePolicy(false),
                loadImage: async url => {
                    active += 1;
                    maxActive = Math.max(maxActive, active);
                    await new Promise(resolve => setTimeout(resolve, 2));
                    active -= 1;
                    return `base64:${url}`;
                },
            }
        );

        expect(prepared).toHaveLength(11);
        expect(maxActive).toBe(MAX_VERTEX_AI_IMAGE_PREPARATION_CONCURRENCY);
    });

    it('bounds image preparation across concurrent accounts in one process', async () => {
        let active = 0;
        let maxActive = 0;
        const loadImage = async (url: string) => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise(resolve => setTimeout(resolve, 5));
            active -= 1;
            return `base64:${url}`;
        };

        await Promise.all(Array.from({ length: 4 }, (_, account) =>
            prepareAnalysisImages(
                `profile-${account}.jpg`,
                Array.from({ length: 10 }, (_value, image) => `post-${account}-${image}.jpg`),
                { loadImage, policy: getAnalysisImagePolicy(false) }
            )
        ));

        expect(maxActive).toBe(MAX_VERTEX_AI_CONCURRENT_IMAGE_PREPARATIONS);
    });

    it('bounds image decodes across unrelated callers', async () => {
        let active = 0;
        let maxActive = 0;
        await Promise.all(Array.from({ length: 8 }, () => runWithImageDecodeSlot(async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise(resolve => setTimeout(resolve, 3));
            active -= 1;
        })));

        expect(maxActive).toBe(MAX_VERTEX_AI_CONCURRENT_IMAGE_DECODES);
        expect(MAX_DECODED_IMAGE_PIXELS).toBe(16_000_000);
    });
});

describe('image preprocessing', () => {
    it('normalizes large inputs to a bounded JPEG without changing aspect ratio', async () => {
        const source = await sharp({
            create: {
                width: 1_200,
                height: 600,
                channels: 4,
                background: { r: 20, g: 80, b: 160, alpha: 0.5 },
            },
        }).png().toBuffer();

        const normalized = await normalizeImageToJpeg(source);
        const metadata = await sharp(normalized).metadata();

        expect(metadata.format).toBe('jpeg');
        expect(metadata.width).toBe(DEFAULT_MAX_ANALYSIS_IMAGE_DIMENSION);
        expect(metadata.height).toBe(DEFAULT_MAX_ANALYSIS_IMAGE_DIMENSION / 2);
        expect(metadata.hasAlpha).toBe(false);
    });

    it('uses the 384px bound only in cost-optimized mode', async () => {
        const source = await sharp({
            create: {
                width: 1_200,
                height: 600,
                channels: 3,
                background: '#336699',
            },
        }).png().toBuffer();

        const normalized = await normalizeImageToJpeg(source, getAnalysisImagePolicy(true));
        const metadata = await sharp(normalized).metadata();

        expect(metadata.width).toBe(COST_OPTIMIZED_MAX_ANALYSIS_IMAGE_DIMENSION);
        expect(metadata.height).toBe(COST_OPTIMIZED_MAX_ANALYSIS_IMAGE_DIMENSION / 2);
    });

    it('does not enlarge small images', async () => {
        const source = await sharp({
            create: {
                width: 100,
                height: 50,
                channels: 3,
                background: '#336699',
            },
        }).webp().toBuffer();

        const normalized = await normalizeImageToJpeg(source);
        const metadata = await sharp(normalized).metadata();

        expect(metadata.width).toBe(100);
        expect(metadata.height).toBe(50);
        expect(metadata.format).toBe('jpeg');
    });

    it('rejects declared downloads larger than the byte limit', async () => {
        const requestImpl = vi.fn(async () => new Response('too large', {
            status: 200,
            headers: {
                'content-length': '9',
                'content-type': 'image/jpeg',
            },
        }));

        await expect(downloadImageBytes('https://cdninstagram.com/image.jpg', {
            requestImpl,
            resolveHostname: publicResolver,
            maxBytes: 8,
        })).rejects.toMatchObject({
            reason: 'response_too_large',
            disposition: 'permanent',
        });
    });

    it('stops streamed downloads that cross the byte limit', async () => {
        const requestImpl = vi.fn(async () => new Response(new Uint8Array(9), {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
        }));

        await expect(downloadImageBytes('https://cdninstagram.com/image.jpg', {
            requestImpl,
            resolveHostname: publicResolver,
            maxBytes: 8,
        })).rejects.toMatchObject({
            reason: 'response_too_large',
            disposition: 'permanent',
        });
    });

    it('classifies corrupt image bytes as a permanent decode failure without source details', async () => {
        const failure = await normalizeImageToJpeg(Buffer.from('not-an-image'))
            .catch(error => error);
        expect(failure).toBeInstanceOf(AnalysisImagePreparationError);
        expect(failure).toMatchObject({
            message: 'ANALYSIS_IMAGE_PREPARATION_DECODE_FAILED',
            reason: 'decode_failed',
            disposition: 'permanent',
        });
    });
});
