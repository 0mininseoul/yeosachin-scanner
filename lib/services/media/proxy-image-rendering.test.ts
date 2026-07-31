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
        // strip, which is where the signed URL is now rendered.
        name: 'progress screened faces',
        source: readFileSync(
            new URL('../../../components/progress-faces.tsx', import.meta.url),
            'utf8'
        ),
        srcExpression: 'src',
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
        expect(source).toMatch(/<Image\b[\s\S]*?\bloading="lazy"[\s\S]*?\/>/);
        expect(source).not.toMatch(/<Image\b[\s\S]*?src=\{imageUrl\}/);
    });
});
