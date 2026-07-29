import type { Metadata } from 'next';
import { CANONICAL_APP_ORIGIN } from '@/lib/constants/app-url';

export const PUBLIC_SITEMAP_URLS = [
    `${CANONICAL_APP_ORIGIN}/`,
    `${CANONICAL_APP_ORIGIN}/guide/wijang-yeosachin`,
    `${CANONICAL_APP_ORIGIN}/terms`,
    `${CANONICAL_APP_ORIGIN}/privacy`,
] as const;

export const PRIVATE_CRAWL_PATHS = [
    '/api/',
    '/admin/',
    '/auth/',
    '/progress/',
    '/result/',
    '/share/',
] as const;

export const SEARCH_CRAWLERS = [
    'Googlebot',
    'OAI-SearchBot',
    'GPTBot',
    'ChatGPT-User',
    '*',
] as const;

export const NOINDEX_ROBOTS: NonNullable<Metadata['robots']> = {
    index: false,
    follow: false,
};

export const NOINDEX_METADATA: Metadata = {
    robots: NOINDEX_ROBOTS,
    alternates: {
        canonical: null,
    },
};

export function buildHomepageJsonLd() {
    const websiteId = `${CANONICAL_APP_ORIGIN}/#website`;
    const organizationId = `${CANONICAL_APP_ORIGIN}/#organization`;

    return {
        '@context': 'https://schema.org',
        '@graph': [
            {
                '@type': 'WebSite',
                '@id': websiteId,
                url: `${CANONICAL_APP_ORIGIN}/`,
                name: '위장여사친 판독기',
                alternateName: 'AI 위장 여사친 판독기',
                inLanguage: 'ko-KR',
                publisher: { '@id': organizationId },
            },
            {
                '@type': 'Organization',
                '@id': organizationId,
                url: `${CANONICAL_APP_ORIGIN}/`,
                name: 'Ascentum',
            },
        ],
    };
}

export const HOMEPAGE_JSON_LD = buildHomepageJsonLd();
