import type { MetadataRoute } from 'next';
import { PUBLIC_SITEMAP_URLS } from '@/lib/services/seo/discovery';

const LAST_MODIFIED_BY_URL = {
    'https://yeosachin.com/': new Date('2026-07-29T00:00:00.000Z'),
    'https://yeosachin.com/guide/wijang-yeosachin': new Date('2026-07-29T00:00:00.000Z'),
    'https://yeosachin.com/terms': new Date('2026-07-16T00:00:00.000Z'),
    'https://yeosachin.com/privacy': new Date('2026-07-29T00:00:00.000Z'),
} satisfies Record<(typeof PUBLIC_SITEMAP_URLS)[number], Date>;

export default function sitemap(): MetadataRoute.Sitemap {
    return PUBLIC_SITEMAP_URLS.map((url) => ({
        url,
        lastModified: LAST_MODIFIED_BY_URL[url],
    }));
}
