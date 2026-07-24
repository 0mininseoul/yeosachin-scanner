import { createHash } from 'node:crypto';
import sharp from 'sharp';

export const MAX_RESULT_IMAGE_DIMENSION = 256;
export const MAX_RESULT_IMAGE_BYTES = 128 * 1024;
export const MAX_RESULT_IMAGE_INPUT_PIXELS = 16_777_216;

const WEBP_QUALITY_ATTEMPTS = [82, 74, 66, 58, 50, 42] as const;

export type NormalizedResultImage = {
    bytes: Buffer;
    contentType: 'image/webp';
    width: number;
    height: number;
    sha256: string;
};

export class ResultImageNormalizationError extends Error {
    constructor(
        readonly code:
            | 'RESULT_IMAGE_INVALID_INPUT'
            | 'RESULT_IMAGE_OUTPUT_TOO_LARGE'
    ) {
        super(code);
        this.name = 'ResultImageNormalizationError';
    }
}

function createPipeline(input: Buffer, quality: number) {
    return sharp(input, {
        animated: false,
        failOn: 'error',
        limitInputPixels: MAX_RESULT_IMAGE_INPUT_PIXELS,
    })
        .rotate()
        .resize(
            MAX_RESULT_IMAGE_DIMENSION,
            MAX_RESULT_IMAGE_DIMENSION,
            {
                fit: 'cover',
                position: 'centre',
                withoutEnlargement: true,
            }
        )
        .webp({
            quality,
            alphaQuality: quality,
            effort: 4,
            smartSubsample: true,
        });
}

export async function normalizeResultImage(
    input: Buffer | Uint8Array
): Promise<NormalizedResultImage> {
    const source = Buffer.from(input);
    if (source.byteLength === 0) {
        throw new ResultImageNormalizationError('RESULT_IMAGE_INVALID_INPUT');
    }

    try {
        for (const quality of WEBP_QUALITY_ATTEMPTS) {
            const {
                data,
                info,
            } = await createPipeline(source, quality)
                .toBuffer({ resolveWithObject: true });

            if (
                info.width > MAX_RESULT_IMAGE_DIMENSION
                || info.height > MAX_RESULT_IMAGE_DIMENSION
            ) {
                throw new ResultImageNormalizationError(
                    'RESULT_IMAGE_INVALID_INPUT'
                );
            }
            if (data.byteLength > MAX_RESULT_IMAGE_BYTES) {
                continue;
            }

            return {
                bytes: data,
                contentType: 'image/webp',
                width: info.width,
                height: info.height,
                sha256: createHash('sha256').update(data).digest('hex'),
            };
        }
    } catch (error) {
        if (error instanceof ResultImageNormalizationError) {
            throw error;
        }
        throw new ResultImageNormalizationError('RESULT_IMAGE_INVALID_INPUT');
    }

    throw new ResultImageNormalizationError(
        'RESULT_IMAGE_OUTPUT_TOO_LARGE'
    );
}
