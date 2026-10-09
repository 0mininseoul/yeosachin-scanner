import type { MetadataRoute } from 'next';
import { CANONICAL_APP_ORIGIN } from '@/lib/constants/app-url';
import { isDevUiDeploymentContext } from '@/lib/constants/dev-ui';
import {
    PRIVATE_CRAWL_PATHS,
    SEARCH_CRAWLERS,
} from '@/lib/services/seo/discovery';

export default function robots(): MetadataRoute.Robots {
    if (isDevUiDeploymentContext()) return { rules: { userAgent: '*', disallow: '/' } };
    return {
        rules: {
            userAgent: [...SEARCH_CRAWLERS],
            allow: '/',
            disallow: [...PRIVATE_CRAWL_PATHS],
        },
        sitemap: `${CANONICAL_APP_ORIGIN}/sitemap.xml`,
    };
}
