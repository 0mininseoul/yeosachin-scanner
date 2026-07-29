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

export const GUIDE_PATH = '/guide/wijang-yeosachin';
export const GUIDE_URL = `${CANONICAL_APP_ORIGIN}${GUIDE_PATH}`;
export const GUIDE_TITLE = '위장여사친 구분법 | 위장여사친 판독기';
export const GUIDE_H1 = '위장여사친 구분법: 인스타 공개 신호로 확인하는 기준';
export const GUIDE_DESCRIPTION = '맞팔 관계와 좋아요·댓글·태그·멘션 등 인스타그램 공개 신호로 위장여사친 후보를 구분하는 기준과 AI 판독 방식을 설명합니다.';
export const GUIDE_PUBLISHED_DATE = '2026-07-29';
export const GUIDE_MODIFIED_DATE = '2026-07-29';
export const GUIDE_PUBLISHER = 'Ascentum';
export const GUIDE_BREADCRUMB_HOME_LABEL = '홈';
export const GUIDE_BREADCRUMB_LABEL = '위장여사친 구분법';

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
                legalName: 'Ascentum',
                brand: {
                    '@type': 'Brand',
                    name: '위장여사친 판독기',
                },
            },
        ],
    };
}

export const HOMEPAGE_JSON_LD = buildHomepageJsonLd();

export function buildGuideJsonLd() {
    return {
        '@context': 'https://schema.org',
        '@graph': [
            {
                '@type': 'Article',
                '@id': `${GUIDE_URL}#article`,
                url: GUIDE_URL,
                headline: GUIDE_TITLE,
                description: GUIDE_DESCRIPTION,
                datePublished: GUIDE_PUBLISHED_DATE,
                dateModified: GUIDE_MODIFIED_DATE,
                inLanguage: 'ko-KR',
                author: {
                    '@type': 'Organization',
                    name: GUIDE_PUBLISHER,
                },
                publisher: {
                    '@type': 'Organization',
                    name: GUIDE_PUBLISHER,
                },
            },
            {
                '@type': 'BreadcrumbList',
                '@id': `${GUIDE_URL}#breadcrumb`,
                itemListElement: [
                    {
                        '@type': 'ListItem',
                        position: 1,
                        name: GUIDE_BREADCRUMB_HOME_LABEL,
                        item: `${CANONICAL_APP_ORIGIN}/`,
                    },
                    {
                        '@type': 'ListItem',
                        position: 2,
                        name: GUIDE_BREADCRUMB_LABEL,
                        item: GUIDE_URL,
                    },
                ],
            },
        ],
    };
}

export const GUIDE_JSON_LD = buildGuideJsonLd();
