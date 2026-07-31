import { describe, expect, it } from 'vitest';
import { selectAnalysisV2GenderResolverMedia } from './v2-gender-resolver-media-policy';

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

    it('uses up to eight feed views only for the v2.11 quality evaluation', () => {
        const media: Media[] = [
            { selectionId: 'profile', kind: 'profile' },
            { selectionId: 'p1:first', kind: 'feed', postId: 'p1' },
            { selectionId: 'p2:first', kind: 'feed', postId: 'p2' },
            { selectionId: 'p3:first', kind: 'feed', postId: 'p3' },
            { selectionId: 'p4:first', kind: 'feed', postId: 'p4' },
            { selectionId: 'p5:first', kind: 'feed', postId: 'p5' },
            { selectionId: 'p6:first', kind: 'feed', postId: 'p6' },
            { selectionId: 'p1:middle', kind: 'feed', postId: 'p1' },
            { selectionId: 'p2:middle', kind: 'feed', postId: 'p2' },
        ];

        expect(ids(selectAnalysisV2GenderResolverMedia(media, 'ai-stage-policy-v2.11')))
            .toEqual([
                'profile', 'p1:first', 'p2:first', 'p1:middle', 'p2:middle',
                'p3:first', 'p4:first', 'p5:first', 'p6:first',
            ]);
        expect(ids(selectAnalysisV2GenderResolverMedia(media))).toHaveLength(5);
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
