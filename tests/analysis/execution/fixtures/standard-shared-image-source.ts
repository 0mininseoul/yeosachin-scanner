import { createHash } from 'node:crypto';
import sharp from 'sharp';

const cells = 16;
const pixelsPerCell = 4;
const dimension = cells * pixelsPerCell;

function imageMark(asset: string) {
    return createHash('sha256').update('shared-standard-image-v1\n' + asset).digest();
}

function shade(mark: Buffer, cell: number) {
    return mark[cell >> 3]! & (1 << (7 - (cell % 8))) ? 224 : 32;
}

// Profiles and posts have distinct URL path names. Ignore query order and CDN
// tracking parameters so the same fixture image survives normal URL canonicalization.
export function createSharedImageSource() {
    const cache = new Map<string, Promise<Buffer>>();
    return (url: string) => {
        const path = new URL(url);
        const match = /^\/([a-zA-Z0-9._-]+)\.jpg$/.exec(path.pathname);
        if (path.origin !== 'https://scontent.cdninstagram.com' || !match) {
            throw new Error('Unexpected shared fixture image source');
        }
        const asset = match[1]!;
        let pending = cache.get(asset);
        if (!pending) {
            const mark = imageMark(asset);
            const pixels = Buffer.alloc(dimension * dimension);
            for (let y = 0; y < dimension; y++) {
                for (let x = 0; x < dimension; x++) {
                    pixels[y * dimension + x] = shade(mark, Math.floor(y / pixelsPerCell) * cells + Math.floor(x / pixelsPerCell));
                }
            }
            pending = sharp(pixels, { raw: { width: dimension, height: dimension, channels: 1 } }).png().toBuffer();
            cache.set(asset, pending);
        }
        return pending;
    };
}

// The expected name comes from the known synthetic target or the published candidate,
// independently of the proxy locator, the object's stored hash, and the source download URL.
export async function matchesSharedResultImage(bytes: Buffer, expectedProfileName: string) {
    const { data, info } = await sharp(bytes).greyscale().raw().toBuffer({ resolveWithObject: true });
    if (info.width < cells || info.height < cells || info.channels !== 1) return false;
    const mark = imageMark(expectedProfileName);
    for (let cell = 0; cell < cells * cells; cell++) {
        const x = Math.floor(((cell % cells) + 0.5) * info.width / cells);
        const y = Math.floor((Math.floor(cell / cells) + 0.5) * info.height / cells);
        // The center of each block remains dark or bright after lossy WebP encoding.
        if (Math.abs(data[y * info.width + x]! - shade(mark, cell)) > 48) return false;
    }
    return true;
}
