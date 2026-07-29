import type { MetadataRoute } from 'next';
import { CANONICAL_APP_ORIGIN } from '@/lib/constants/app-url';
import {
    PRIVATE_CRAWL_PATHS,
    SEARCH_CRAWLERS,
} from '@/lib/services/seo/discovery';

export default function robots(): MetadataRoute.Robots {
    return {
        rules: {
            userAgent: [...SEARCH_CRAWLERS],
            allow: '/',
            disallow: [...PRIVATE_CRAWL_PATHS],
        },
        sitemap: `${CANONICAL_APP_ORIGIN}/sitemap.xml`,
    };
}
