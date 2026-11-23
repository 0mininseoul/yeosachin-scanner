import type { MetadataRoute } from 'next';
import { CANONICAL_APP_ORIGIN } from '@/lib/constants/app-url';
import { isDevUiDeploymentContext } from '@/lib/constants/dev-ui';
import { PRIVATE_CRAWL_PATHS } from '@/lib/services/seo/discovery';
import { AI_ROBOTS_TOKENS, LEGAL_PAGE_PATHS } from '@/lib/services/seo/legal-page-crawlers';

export default function robots(): MetadataRoute.Robots {
    if (isDevUiDeploymentContext()) return { rules: { userAgent: '*', disallow: '/' } };
    return {
        rules: [
            { userAgent: ['Googlebot', '*'], allow: '/', disallow: [...PRIVATE_CRAWL_PATHS] },
            {
                userAgent: AI_ROBOTS_TOKENS,
                allow: '/',
                // Named groups do not inherit the wildcard group's restrictions.
                disallow: [...PRIVATE_CRAWL_PATHS, ...LEGAL_PAGE_PATHS.flatMap(path =>
                    [`${path}$`, `${path}?`, `${path}/$`, `${path}/?`])],
            },
        ],
        sitemap: `${CANONICAL_APP_ORIGIN}/sitemap.xml`,
    };
}
