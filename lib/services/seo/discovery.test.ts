import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

const CANONICAL_ORIGIN = 'https://yeosachin.com';
const PRIVATE_CRAWL_PATHS = [
    '/api/',
    '/admin/',
    '/auth/',
    '/progress/',
    '/result/',
    '/share/',
];
const SEARCH_CRAWLERS = [
    'Googlebot',
    'OAI-SearchBot',
    'GPTBot',
    'ChatGPT-User',
    '*',
];

describe('search discovery routes', () => {
    it('publishes one consistent allow/disallow policy for search and AI crawlers', async () => {
        const { default: robots } = await import('@/app/robots');

        expect(robots()).toEqual({
            rules: {
                userAgent: SEARCH_CRAWLERS,
                allow: '/',
                disallow: PRIVATE_CRAWL_PATHS,
            },
            sitemap: `${CANONICAL_ORIGIN}/sitemap.xml`,
        });
    });

    it('publishes only the canonical public static pages without ranking hints', async () => {
        const { default: sitemap } = await import('@/app/sitemap');
        const entries = sitemap();

        expect(entries.map(({ url }) => url)).toEqual([
            `${CANONICAL_ORIGIN}/`,
            `${CANONICAL_ORIGIN}/guide/wijang-yeosachin`,
            `${CANONICAL_ORIGIN}/terms`,
            `${CANONICAL_ORIGIN}/privacy`,
        ]);
        expect(entries.every(({ lastModified }) => lastModified instanceof Date)).toBe(true);
        expect(entries.every((entry) => !('priority' in entry))).toBe(true);
        expect(entries.every((entry) => !('changeFrequency' in entry))).toBe(true);
    });
});

describe('JSON-LD', () => {
    it('escapes less-than signs while preserving valid JSON', async () => {
        const { serializeJsonLd } = await import('@/components/seo/json-ld');
        const value = {
            description: '</script><script>alert("unsafe")</script>',
        };

        const serialized = serializeJsonLd(value);

        expect(serialized).not.toContain('<');
        expect(serialized).toContain('\\u003c/script>');
        expect(JSON.parse(serialized)).toEqual(value);
    });

    it('renders one parseable JSON-LD script with escaped data', async () => {
        const { JsonLd } = await import('@/components/seo/json-ld');
        const value = {
            '@context': 'https://schema.org',
            description: '</script><script>alert("unsafe")</script>',
        };

        const markup = renderToStaticMarkup(createElement(JsonLd, { data: value }));
        const scripts = [...markup.matchAll(
            /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
        )];

        expect(scripts).toHaveLength(1);
        expect(scripts[0]?.[1]).not.toContain('<');
        expect(scripts[0]?.[1]).toContain('\\u003c/script>');
        expect(JSON.parse(scripts[0]?.[1] ?? '')).toEqual(value);
    });

    it('describes only the truthful homepage WebSite and Organization graph', async () => {
        const { buildHomepageJsonLd } = await import('./discovery');
        const graph = buildHomepageJsonLd();
        const serialized = JSON.stringify(graph);

        expect(graph).toMatchObject({
            '@context': 'https://schema.org',
            '@graph': expect.arrayContaining([
                expect.objectContaining({
                    '@type': 'WebSite',
                    name: '위장여사친 판독기',
                    alternateName: 'AI 위장 여사친 판독기',
                    url: `${CANONICAL_ORIGIN}/`,
                    inLanguage: 'ko-KR',
                }),
                expect.objectContaining({
                    '@type': 'Organization',
                    name: 'Ascentum',
                    url: `${CANONICAL_ORIGIN}/`,
                }),
            ]),
        });
        expect(graph['@graph']).toHaveLength(2);
        expect(serialized).not.toMatch(/Review|AggregateRating|sameAs/);
    });
});

describe('route metadata', () => {
    it('gives terms and privacy unique search and social metadata', async () => {
        const [
            { metadata: terms },
            { metadata: privacy },
        ] = await Promise.all([
            import('@/app/terms/page'),
            import('@/app/privacy/page'),
        ]);

        expect(terms.title).toBeTruthy();
        expect(privacy.title).toBeTruthy();
        expect(terms.title).not.toEqual(privacy.title);
        expect(terms.description).toBeTruthy();
        expect(privacy.description).toBeTruthy();
        expect(terms.description).not.toEqual(privacy.description);
        expect(terms.alternates?.canonical).toBe('/terms');
        expect(privacy.alternates?.canonical).toBe('/privacy');

        for (const [metadata, url] of [
            [terms, `${CANONICAL_ORIGIN}/terms`],
            [privacy, `${CANONICAL_ORIGIN}/privacy`],
        ] as const) {
            expect(metadata.openGraph).toMatchObject({
                type: 'website',
                locale: 'ko_KR',
                url,
                title: metadata.title,
                description: metadata.description,
            });
            expect(metadata.twitter).toMatchObject({
                title: metadata.title,
                description: metadata.description,
            });
        }
    });

    it('clears inherited canonicals on every search-ineligible HTML route', async () => {
        const [
            { NOINDEX_ROBOTS, NOINDEX_METADATA },
            { metadata: admin },
            { metadata: analyze },
            { metadata: login },
            { metadata: progress },
            { metadata: result },
            { metadata: earlybird },
            { metadata: mypage },
        ] = await Promise.all([
            import('./discovery'),
            import('@/app/admin/layout'),
            import('@/app/analyze/layout'),
            import('@/app/login/layout'),
            import('@/app/progress/layout'),
            import('@/app/result/layout'),
            import('@/app/earlybird/page'),
            import('@/app/mypage/page'),
        ]);

        expect(NOINDEX_ROBOTS).toEqual({ index: false, follow: false });
        expect(NOINDEX_METADATA).toEqual({
            robots: NOINDEX_ROBOTS,
            alternates: { canonical: null },
        });
        for (const metadata of [
            admin,
            analyze,
            login,
            progress,
            result,
            earlybird,
            mypage,
        ]) {
            expect(metadata.robots).toBe(NOINDEX_ROBOTS);
            expect(metadata.alternates?.canonical).toBeNull();
        }
    });
});
