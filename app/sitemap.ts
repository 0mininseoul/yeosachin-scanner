import type { MetadataRoute } from 'next';
import { PUBLIC_SITEMAP_URLS } from '@/lib/services/seo/discovery';

import { CHERRY_LEGACY_URL, isCherryDomainLive } from '@/lib/services/cherry/public-domain';

const LAST_MODIFIED_BY_URL = {
    'https://yeosachin.com/': new Date('2026-07-29T00:00:00.000Z'),
    'https://yeosachin.com/cherry': new Date('2026-11-23T00:00:00.000Z'),
    'https://yeosachin.com/guide/wijang-yeosachin': new Date('2026-07-29T00:00:00.000Z'),
} satisfies Record<(typeof PUBLIC_SITEMAP_URLS)[number], Date>;

export default function sitemap(): MetadataRoute.Sitemap {
    const cherryMoved = isCherryDomainLive();
    return PUBLIC_SITEMAP_URLS
        .filter((url) => !cherryMoved || url !== CHERRY_LEGACY_URL)
        .map((url) => ({ url, lastModified: LAST_MODIFIED_BY_URL[url] }));
}
