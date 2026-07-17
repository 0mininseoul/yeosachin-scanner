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
        name: 'progress active profile',
        source: readFileSync(
            new URL('../../../app/progress/[requestId]/page.tsx', import.meta.url),
            'utf8'
        ),
        srcExpression: 'data.activeProfile.imageUrl',
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
});
