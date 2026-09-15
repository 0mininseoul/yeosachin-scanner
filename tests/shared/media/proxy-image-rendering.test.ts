import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const proxyImageUsages = [
    {
        name: 'analyze target profile',
        source: readFileSync(
            new URL('../../../app/analyze/page.tsx', import.meta.url),
            'utf8'
        ),
        srcExpression: 'readyPreflight.target.profileImage',
    },
    {
        // The progress page hands the active profile to the screened-faces
        // strip, which is where the signed URL is now rendered visibly.
        name: 'progress visible screened faces',
        source: readFileSync(
            new URL('../../../components/progress-faces.tsx', import.meta.url),
            'utf8'
        ),
        srcExpression: 'displaySrc',
    },
] as const;

describe('signed image proxy rendering contract', () => {
    it.each(proxyImageUsages)(
        'renders the $name without Next.js image optimization',
        ({ source, srcExpression }) => {
            const imageTags = source.match(/<Image\b[\s\S]*?\/>/g) ?? [];
            const matchingTags = imageTags.filter(tag => (
                tag.includes(`src={${srcExpression}}`)
            ));

            expect(matchingTags).toHaveLength(1);
            expect(matchingTags[0]).toMatch(/\bunoptimized(?:\s|\/>)/);
        }
    );

    it('renders grouped progress media through the safe local-image gate with lazy images', () => {
        const source = proxyImageUsages[1].source;

        expect(source).toContain('feedImageUrls');
        expect(source).toContain('safeResultImageUrl(imageUrl)');
        expect(source).toContain("src?.startsWith('/api/image-proxy?')");
        expect(source).toMatch(/<Image\b[\s\S]*?\bloading="lazy"[\s\S]*?\/>/);
        expect(source).not.toMatch(/<Image\b[\s\S]*?src=\{imageUrl\}/);
        expect(source).not.toContain('.candidateKey');
        expect(source).toContain('data-progress-copy');
        expect(source).toContain('Array.from({ length: copyCount');
        expect(source).toContain('copyElements[1].offsetLeft');
        expect(source).toContain('copyElements[0].offsetLeft');
    });

    it('keeps the visible image lazy and the retry probe eager', () => {
        const source = proxyImageUsages[1].source;
        const imageTags = source.match(/<Image\b[\s\S]*?\/>/g) ?? [];
        const displayTags = imageTags.filter(tag => tag.includes('src={displaySrc}'));
        const probeTags = imageTags.filter(tag => tag.includes('src={probeSrc}'));

        expect(displayTags).toHaveLength(1);
        expect(displayTags[0]).toMatch(/\bunoptimized(?:\s|\/>)/);
        expect(displayTags[0]).toContain('loading="lazy"');
        expect(probeTags).toHaveLength(1);
        expect(probeTags[0]).toMatch(/\bunoptimized(?:\s|\/>)/);
        expect(probeTags[0]).toContain('loading="eager"');
        expect(probeTags[0]).toContain('data-progress-retry="true"');
    });
});
