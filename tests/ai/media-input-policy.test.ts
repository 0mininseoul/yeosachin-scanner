import { describe, expect, it } from "vitest";
import { planGenderTriageMicrobatches } from "../../lib/services/ai/gender-triage-microbatch-plan";
import sharp from "sharp";
import { MAX_PARTNER_SAFETY_CONTACT_MEDIA } from "@/lib/domain/analysis/media-policy";
import { createPartnerSafetyContactSheet } from "../../lib/services/ai/partner-contact-sheet";
import { selectAnalysisV2GenderResolverMedia } from "../../lib/services/analysis/v2-gender-resolver-media-policy";

describe("gender-triage-microbatch-plan", () => {
    describe('production v2.9 gender microbatch planner', () => {
        it('stably sorts six opaque accounts into three paired operations', () => {
            const members = ['f', 'a', 'e', 'b', 'd', 'c'].map(value => ({
                accountId: `account:${value.repeat(64)}`,
                value,
            }));

            const batches = planGenderTriageMicrobatches(members);

            expect(batches.map(batch => batch.length)).toEqual([2, 2, 2]);
            expect(batches.flat().map(member => member.value))
                .toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
        });
    });
});

describe("partner-contact-sheet", () => {
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
});

describe("v2-gender-resolver-media-policy", () => {
    type Media = {
        selectionId: string;
        kind: 'profile' | 'feed';
        postId?: string;
    };

    const ids = (media: readonly Media[]) => media.map(item => item.selectionId);

    describe('analysis V2 gender resolver media policy', () => {
        it('keeps profile and recent representatives while admitting carousel middle and late views', () => {
            const media: Media[] = [
                { selectionId: 'profile', kind: 'profile' },
                { selectionId: 'p1:first', kind: 'feed', postId: 'p1' },
                { selectionId: 'p2:first', kind: 'feed', postId: 'p2' },
                { selectionId: 'p3:first', kind: 'feed', postId: 'p3' },
                { selectionId: 'p1:middle', kind: 'feed', postId: 'p1' },
                { selectionId: 'p1:late', kind: 'feed', postId: 'p1' },
            ];

            expect(ids(selectAnalysisV2GenderResolverMedia(media))).toEqual([
                'profile', 'p1:first', 'p2:first', 'p1:middle', 'p1:late',
            ]);
        });

        it('is deterministic and never repeats a selection or post representative', () => {
            const media: Media[] = [
                { selectionId: 'p1:first', kind: 'feed', postId: 'p1' },
                { selectionId: 'p1:first', kind: 'feed', postId: 'p1' },
                { selectionId: 'p2:first', kind: 'feed', postId: 'p2' },
                { selectionId: 'p3:first', kind: 'feed', postId: 'p3' },
                { selectionId: 'p1:middle', kind: 'feed', postId: 'p1' },
                { selectionId: 'p1:late', kind: 'feed', postId: 'p1' },
            ];
            const first = selectAnalysisV2GenderResolverMedia(media);
            const second = selectAnalysisV2GenderResolverMedia(media);

            expect(ids(first)).toEqual(ids(second));
            expect(new Set(ids(first)).size).toBe(first.length);
            expect(ids(first).filter(id => id.endsWith(':first'))).toEqual([
                'p1:first', 'p2:first',
            ]);
        });

        it('selects identical IDs from production-normalized and replay media shapes', () => {
            const lineage: Media[] = [
                { selectionId: 'profile', kind: 'profile' },
                { selectionId: 'p1:first', kind: 'feed', postId: 'p1' },
                { selectionId: 'p2:first', kind: 'feed', postId: 'p2' },
                { selectionId: 'p3:first', kind: 'feed', postId: 'p3' },
                { selectionId: 'p1:middle', kind: 'feed', postId: 'p1' },
                { selectionId: 'p1:late', kind: 'feed', postId: 'p1' },
            ];
            const production = lineage.map(item => ({
                ...item,
                normalizedJpegBase64: '/9j/2Q==',
            }));
            const replay = lineage.map(item => ({
                ...item,
                jpegBase64: '/9j/2Q==',
            }));

            expect(ids(selectAnalysisV2GenderResolverMedia(production))).toEqual(
                ids(selectAnalysisV2GenderResolverMedia(replay)),
            );
        });

        const sparseCases: Array<{ media: Media[] }> = [
            { media: [] },
            { media: [{ selectionId: 'profile', kind: 'profile' as const }] },
            { media: [{ selectionId: 'only', kind: 'feed' as const, postId: 'p1' }] },
        ];
        it.each(sparseCases)('gracefully preserves sparse media %#', ({ media }) => {
            expect(selectAnalysisV2GenderResolverMedia(media)).toEqual(media);
        });
    });
});
