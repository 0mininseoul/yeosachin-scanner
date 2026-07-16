import { describe, expect, it } from 'vitest';
import type { InstagramPost, InstagramProfile } from '@/lib/types/instagram';
import type { SelectedAnalysisMedia } from './media-policy';
import { buildCarouselCaptionPolicy } from './carousel-caption-policy';

function post(overrides: Partial<InstagramPost> & Pick<InstagramPost, 'id' | 'type'>): InstagramPost {
    const { id, type, ...rest } = overrides;
    return {
        id,
        shortCode: id,
        type,
        likesCount: 0,
        commentsCount: 0,
        timestamp: '2026-07-16T00:00:00.000Z',
        taggedUsers: [],
        mentionedUsers: [],
        ...rest,
    };
}

function profile(latestPosts: InstagramPost[]): InstagramProfile {
    return {
        username: 'candidate.user',
        followersCount: 10,
        followingCount: 20,
        postsCount: latestPosts.length,
        isPrivate: false,
        isVerified: false,
        latestPosts,
    };
}

function selection(
    selectionId: string,
    role: SelectedAnalysisMedia['role'],
    postId?: string,
    mediaIndex?: number
): SelectedAnalysisMedia {
    return {
        selectionId,
        role,
        imageUrl: `https://cdn.example/${encodeURIComponent(selectionId)}.jpg`,
        ...(postId === undefined ? {} : { postId }),
        ...(mediaIndex === undefined ? {} : { mediaIndex }),
    };
}

function dossierExcerptMap(text: string): ReadonlyMap<number, string> {
    const excerpts = new Map<number, string>();
    for (const line of text.split('\n')) {
        const match = line.match(/^\[슬라이드 (\d+)\] (.+)$/u);
        if (!match) throw new Error(`invalid dossier line: ${line}`);
        excerpts.set(Number(match[1]) - 1, match[2]);
    }
    return excerpts;
}

function completeCarousel(
    captions: Array<string | undefined>,
    overrides: Partial<InstagramPost> = {}
): InstagramPost {
    return post({
        id: 'carousel',
        type: 'carousel',
        caption: '  Parent\n carousel caption  ',
        declaredMediaCount: captions.length,
        childrenComplete: true,
        mediaItems: captions.map((caption, index) => ({
            id: `child-${index}`,
            type: 'image',
            imageUrl: `https://cdn.example/child-${index}.jpg`,
            ...(caption === undefined ? {} : { caption }),
        })),
        ...overrides,
    });
}

describe('buildCarouselCaptionPolicy', () => {
    it('aligns child captions and emits a missing-child parent fallback only once per post', () => {
        const carousel = completeCarousel([
            '  First\tcaption  ',
            'Partner one',
            'Partner two',
            undefined,
            '＠target.user  spotted',
            'Last caption',
        ]);
        const ordinaryPost = post({
            id: 'ordinary',
            type: 'image',
            caption: ' Ordinary   parent ',
            imageUrl: 'https://cdn.example/ordinary.jpg',
        });
        const featureSelections = [
            selection('profile:avatar', 'profile'),
            selection('post:carousel:0', 'post_representative', 'carousel', 0),
            selection('post:carousel:3', 'carousel_context', 'carousel', 3),
            selection('post:carousel:missing-again', 'carousel_context', 'carousel', 99),
            selection('post:carousel:5', 'carousel_context', 'carousel', 5),
            selection('post:ordinary', 'post_representative', 'ordinary'),
            selection('post:ordinary:again', 'post_representative', 'ordinary'),
        ];
        const partnerSelections = [1, 2, 4].map(index => (
            selection(
                `post:carousel:${index}`,
                'partner_safety_contact',
                'carousel',
                index
            )
        ));

        const result = buildCarouselCaptionPolicy({
            targetUsername: 'target.user',
            profile: profile([carousel, ordinaryPost]),
            featureSelections,
            partnerSelections,
        });

        expect(result.featureCaptions.map(row => [row.selectionId, row.text])).toEqual([
            ['post:carousel:0', 'First caption'],
            ['post:carousel:3', 'Parent carousel caption'],
            ['post:carousel:5', 'Last caption'],
            ['post:ordinary', 'Ordinary parent'],
        ]);
        expect(result.partnerCaptions.map(row => [row.selectionId, row.text])).toEqual([
            ['post:carousel:1', 'Partner one'],
            ['post:carousel:2', 'Partner two'],
            ['post:carousel:4', '@target.user spotted'],
        ]);
        const excerpts = dossierExcerptMap(result.dossier?.text ?? '');
        expect(result.partnerCaptions.map(row => row.text)).toEqual([
            excerpts.get(1),
            excerpts.get(2),
            excerpts.get(4),
        ]);
        expect(new Set([
            ...result.featureCaptions,
            ...result.partnerCaptions,
        ].map(row => row.evidenceRefId)).size).toBe(7);
        expect(result.dossier?.text).toContain('[슬라이드 5] @target.user spotted');
        expect(result.dossier?.text.length).toBeLessThanOrEqual(2_000);
    });

    it('normalizes NFKC and whitespace and deduplicates dossier text in slide order', () => {
        const carousel = completeCarousel([
            '  ＡＢＣ\n\t caption ',
            'ABC caption',
            '',
            'Second   caption',
        ]);
        const input = {
            targetUsername: 'target.user',
            profile: profile([carousel]),
            featureSelections: [
                selection('post:carousel:0', 'post_representative', 'carousel', 0),
                selection('post:carousel:3', 'carousel_context', 'carousel', 3),
            ],
            partnerSelections: [
                selection('post:carousel:1', 'partner_safety_contact', 'carousel', 1),
                selection('post:carousel:2', 'partner_safety_contact', 'carousel', 2),
            ],
        } as const;

        const first = buildCarouselCaptionPolicy(input);
        const second = buildCarouselCaptionPolicy(input);

        expect(first.featureCaptions.map(row => row.text)).toEqual([
            'ABC caption',
            'Second caption',
        ]);
        expect(first.partnerCaptions.map(row => row.text)).toEqual(['ABC caption']);
        expect(first.dossier?.text).toBe([
            '[슬라이드 1] ABC caption',
            '[슬라이드 4] Second caption',
        ].join('\n'));
        expect(first.partnerCaptions[0]?.text).toBe(
            dossierExcerptMap(first.dossier?.text ?? '').get(0)
        );
        expect(first).toEqual(second);
    });

    it('binds a parent fallback evidence ref to the selected carousel slide', () => {
        const carousel = completeCarousel([undefined, undefined, 'third']);
        const evidenceRef = (mediaIndex: number) => buildCarouselCaptionPolicy({
            targetUsername: 'target.user',
            profile: profile([carousel]),
            featureSelections: [selection(
                `post:carousel:${mediaIndex}`,
                'carousel_context',
                'carousel',
                mediaIndex
            )],
            partnerSelections: [],
        }).featureCaptions[0]?.evidenceRefId;

        expect(evidenceRef(0)).not.toBe(evidenceRef(1));
    });

    it('does not create partner evidence or a dossier without a valid complete carousel', () => {
        const incomplete = completeCarousel(
            ['one', 'two', 'three'],
            { childrenComplete: false }
        );
        const selections = [
            selection('post:carousel:0', 'carousel_context', 'carousel', 0),
        ];

        const result = buildCarouselCaptionPolicy({
            targetUsername: 'target.user',
            profile: profile([incomplete]),
            featureSelections: selections,
            partnerSelections: [
                selection('post:carousel:1', 'partner_safety_contact', 'carousel', 1),
            ],
        });

        expect(result.featureCaptions.map(row => row.text)).toEqual(['one']);
        expect(result.partnerCaptions).toEqual([]);
        expect(result.dossier).toBeNull();
    });

    it('rejects a declared complete carousel above the canonical 20-slide bound', () => {
        const carousel = completeCarousel(Array.from(
            { length: 21 },
            (_, index) => `caption-${index + 1}`
        ));

        const result = buildCarouselCaptionPolicy({
            targetUsername: 'target.user',
            profile: profile([carousel]),
            featureSelections: [
                selection('post:carousel:1', 'carousel_context', 'carousel', 1),
            ],
            partnerSelections: [
                selection('post:carousel:0', 'partner_safety_contact', 'carousel', 0),
            ],
        });

        expect(result.partnerCaptions).toEqual([]);
        expect(result.dossier).toBeNull();
    });

    it('accepts only partner-safety rows and caps aligned captions at 17 in input order', () => {
        const carousel = completeCarousel(Array.from(
            { length: 20 },
            (_, index) => `caption-${index + 1}`
        ));
        const validIndexes = Array.from({ length: 20 }, (_, index) => 19 - index);
        const partnerSelections = [
            selection('wrong-role', 'carousel_context', 'carousel', 0),
            ...validIndexes.map(index => selection(
                `partner:${index}`,
                'partner_safety_contact',
                'carousel',
                index
            )),
            selection('wrong-role-tail', 'post_representative', 'carousel', 1),
        ];

        const result = buildCarouselCaptionPolicy({
            targetUsername: 'target.user',
            profile: profile([carousel]),
            featureSelections: [
                selection('post:carousel:10', 'carousel_context', 'carousel', 10),
            ],
            partnerSelections,
        });

        expect(result.partnerCaptions.map(row => row.selectionId)).toEqual(
            validIndexes.slice(0, 17).map(index => `partner:${index}`)
        );
    });

    it('builds a complete three-slide dossier without partner rows', () => {
        const carousel = completeCarousel(['first', 'second', 'third']);

        const result = buildCarouselCaptionPolicy({
            targetUsername: 'target.user',
            profile: profile([carousel]),
            featureSelections: [
                selection('post:carousel:1', 'carousel_context', 'carousel', 1),
            ],
            partnerSelections: [],
        });

        expect(result.partnerCaptions).toEqual([]);
        expect(result.dossier?.text).toBe([
            '[슬라이드 1] first',
            '[슬라이드 2] second',
            '[슬라이드 3] third',
        ].join('\n'));
    });

    it('uses the first partner post when no carousel-context feature selection exists', () => {
        const carousel = completeCarousel(['first', 'second', 'third']);

        const result = buildCarouselCaptionPolicy({
            targetUsername: 'target.user',
            profile: profile([carousel]),
            featureSelections: [
                selection('post:carousel:0', 'post_representative', 'carousel', 0),
            ],
            partnerSelections: [
                selection('post:carousel:1', 'partner_safety_contact', 'carousel', 1),
            ],
        });

        expect(result.partnerCaptions.map(row => row.text)).toEqual(['second']);
        expect(result.dossier?.text).toContain('[슬라이드 3] third');
    });

    it('prioritizes only an exact extracted target mention for residual characters', () => {
        const suffix = 'x'.repeat(2_200);
        const carousel = completeCarousel([
            `email person@target.user ${suffix}`,
            `near @target.user2 ${suffix}`,
            `double @@target.user ${suffix}`,
            `exact @TARGET.USER ${suffix}`,
        ]);
        const result = buildCarouselCaptionPolicy({
            targetUsername: '  ＠TARGET.USER  ',
            profile: profile([carousel]),
            featureSelections: [
                selection('post:carousel:1', 'carousel_context', 'carousel', 1),
            ],
            partnerSelections: [],
        });

        const excerpts = (result.dossier?.text ?? '').split('\n').map(line => (
            line.replace(/^\[슬라이드 \d+\] /u, '')
        ));
        expect(excerpts[3].length).toBeGreaterThan(excerpts[0].length);
        expect(excerpts[3].length).toBeGreaterThan(excerpts[1].length);
        expect(excerpts[3].length).toBeGreaterThan(excerpts[2].length);
    });

    it('reuses the bounded dossier excerpts for 20 long partner captions', () => {
        const captions = Array.from({ length: 20 }, (_, index) => {
            const prefix = `${index === 19 ? '@target.user ' : ''}slide-${index + 1} `;
            return `${prefix}${String(index % 10).repeat(2_200 - prefix.length)}`;
        });
        expect(captions.every(caption => caption.length === 2_200)).toBe(true);
        const carousel = completeCarousel(captions);
        const featureSelections = [0, 10, 19].map((index, position) => selection(
            `post:carousel:${index}`,
            position === 0 ? 'post_representative' : 'carousel_context',
            'carousel',
            index
        ));
        const partnerSelections = Array.from({ length: 20 }, (_, index) => index)
            .filter(index => ![0, 10, 19].includes(index))
            .map(index => selection(
                `post:carousel:${index}`,
                'partner_safety_contact',
                'carousel',
                index
            ));

        const result = buildCarouselCaptionPolicy({
            targetUsername: '@target.user',
            profile: profile([carousel]),
            featureSelections,
            partnerSelections,
        });

        const dossier = result.dossier?.text ?? '';
        const lines = dossier.split('\n');
        expect(dossier.length).toBeLessThanOrEqual(2_000);
        expect(lines).toHaveLength(20);
        for (const [index, line] of lines.entries()) {
            expect(line).toMatch(new RegExp(`^\\[슬라이드 ${index + 1}\\] .+`));
        }
        const firstExcerpt = lines[0].replace(/^\[슬라이드 1\] /u, '');
        const targetExcerpt = lines[19].replace(/^\[슬라이드 20\] /u, '');
        expect(targetExcerpt.length).toBeGreaterThan(firstExcerpt.length);
        const excerpts = dossierExcerptMap(dossier);
        const partnerIndexes = Array.from({ length: 20 }, (_, index) => index)
            .filter(index => ![0, 10, 19].includes(index));
        expect(result.partnerCaptions).toHaveLength(partnerIndexes.length);
        for (const [position, row] of result.partnerCaptions.entries()) {
            expect(row.text).toBe(excerpts.get(partnerIndexes[position]));
        }
        expect(result.partnerCaptions.reduce(
            (sum, row) => sum + row.text.length,
            0
        )).toBeLessThanOrEqual(2_000);
        expect(result.featureCaptions.map(row => row.text)).toEqual([
            captions[0],
            captions[10],
            captions[19],
        ]);
    });
});
