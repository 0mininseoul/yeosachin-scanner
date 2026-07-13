import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import { MAX_PARTNER_SAFETY_CONTACT_MEDIA } from '@/lib/domain/analysis/media-policy';
import { MAX_DECODED_IMAGE_PIXELS, runWithImageDecodeSlot } from './image-preprocessing';

const CONTACT_SHEET_COLUMNS = 4;
const CONTACT_SHEET_CELL_SIZE = 192;
const CONTACT_SHEET_GAP = 4;
const CONTACT_SHEET_JPEG_QUALITY = 68;
const MAX_NORMALIZED_IMAGE_BASE64_LENGTH = 12 * 1024 * 1024;
const MAX_CONTACT_SHEET_BASE64_LENGTH = 4 * 1024 * 1024;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const contactSheetSourceSchema = z.object({
    selectionId: z.string().trim().min(1).max(240),
    normalizedJpegBase64: z.string()
        .min(4)
        .max(MAX_NORMALIZED_IMAGE_BASE64_LENGTH)
        .regex(BASE64_PATTERN),
}).strict();

const contactSheetSourcesSchema = z.array(contactSheetSourceSchema)
    .min(1)
    .max(MAX_PARTNER_SAFETY_CONTACT_MEDIA)
    .superRefine((items, context) => {
        const ids = new Set<string>();
        items.forEach((item, index) => {
            if (ids.has(item.selectionId)) {
                context.addIssue({
                    code: 'custom',
                    path: [index, 'selectionId'],
                    message: 'Contact-sheet source selection IDs must be unique.',
                });
            }
            ids.add(item.selectionId);
        });
    });

export interface PartnerContactSheetSource {
    selectionId: string;
    normalizedJpegBase64: string;
}

export interface PartnerContactSheet {
    selectionId: string;
    normalizedJpegBase64: string;
    sourceSelectionIds: readonly string[];
    width: number;
    height: number;
}

function contactSheetSelectionId(selectionIds: readonly string[]): string {
    const digest = createHash('sha256')
        .update('partner-safety-contact-sheet-v1\n', 'utf8')
        .update(selectionIds.join('\n'), 'utf8')
        .digest('hex');
    return `contact-sheet:${digest}`;
}

async function prepareCell(source: PartnerContactSheetSource): Promise<Buffer> {
    const bytes = Buffer.from(source.normalizedJpegBase64, 'base64');
    if (bytes.length === 0) {
        throw new Error('PARTNER_CONTACT_SHEET_ERROR: source image is empty.');
    }

    return runWithImageDecodeSlot(() => sharp(bytes, {
        failOn: 'error',
        limitInputPixels: MAX_DECODED_IMAGE_PIXELS,
        pages: 1,
        sequentialRead: true,
    })
        .rotate()
        .flatten({ background: '#ffffff' })
        .resize({
            width: CONTACT_SHEET_CELL_SIZE,
            height: CONTACT_SHEET_CELL_SIZE,
            fit: 'contain',
            background: '#ffffff',
            withoutEnlargement: false,
        })
        .jpeg({
            quality: CONTACT_SHEET_JPEG_QUALITY,
            chromaSubsampling: '4:2:0',
            progressive: false,
        })
        .toBuffer());
}

/**
 * Collapses carousel frames outside the feature selection into one bounded image. The source
 * order is preserved so the accompanying manifest remains deterministic across task retries.
 */
export async function createPartnerSafetyContactSheet(
    rawSources: readonly PartnerContactSheetSource[]
): Promise<PartnerContactSheet> {
    const sources = contactSheetSourcesSchema.parse(rawSources);
    const columns = Math.min(CONTACT_SHEET_COLUMNS, sources.length);
    const rows = Math.ceil(sources.length / columns);
    const width = columns * CONTACT_SHEET_CELL_SIZE
        + Math.max(0, columns - 1) * CONTACT_SHEET_GAP;
    const height = rows * CONTACT_SHEET_CELL_SIZE
        + Math.max(0, rows - 1) * CONTACT_SHEET_GAP;
    const cells = await Promise.all(sources.map(prepareCell));

    const jpeg = await runWithImageDecodeSlot(() => sharp({
        create: {
            width,
            height,
            channels: 3,
            background: '#e5e7eb',
        },
    })
        .composite(cells.map((input, index) => ({
            input,
            left: (index % columns) * (CONTACT_SHEET_CELL_SIZE + CONTACT_SHEET_GAP),
            top: Math.floor(index / columns) * (CONTACT_SHEET_CELL_SIZE + CONTACT_SHEET_GAP),
        })))
        .jpeg({
            quality: CONTACT_SHEET_JPEG_QUALITY,
            chromaSubsampling: '4:2:0',
            progressive: false,
        })
        .toBuffer());
    const normalizedJpegBase64 = jpeg.toString('base64');
    if (normalizedJpegBase64.length > MAX_CONTACT_SHEET_BASE64_LENGTH) {
        throw new Error('PARTNER_CONTACT_SHEET_ERROR: generated image exceeds the byte budget.');
    }

    const sourceSelectionIds = Object.freeze(sources.map(source => source.selectionId));
    return Object.freeze({
        selectionId: contactSheetSelectionId(sourceSelectionIds),
        normalizedJpegBase64,
        sourceSelectionIds,
        width,
        height,
    });
}
