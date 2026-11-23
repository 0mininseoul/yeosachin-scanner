import { createHash } from 'node:crypto';

const ANCHOR_PATH = /^\/__dev_qa_archive\/v1\/[a-f0-9]{64}(?:\.[a-z0-9]{1,5})?$/;
const MEDIA_EXTENSION = /\.(3g2|3gp|avif|avi|flv|gif|heic|jpeg|jpg|m2ts|m4v|mkv|mov|mp4|mpeg|mpg|mts|ogv|png|ts|webm|webp|wmv)$/i;

/** Preserves source equality and media type without retaining signed URL paths or queries. */
export function archiveMediaUrlAnchor(value: string): string {
    const url = URL.parse(value.trim());
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.port) {
        throw new Error('DEV_STANDARD_ARCHIVE_UNAVAILABLE');
    }
    if (!url.search && !url.hash && ANCHOR_PATH.test(url.pathname)) return url.href;
    let pathname: string;
    try {
        pathname = decodeURIComponent(url.pathname);
    } catch {
        pathname = url.pathname;
    }
    const extension = pathname.match(MEDIA_EXTENSION)?.[0].toLowerCase() ?? '';
    url.hash = '';
    const key = createHash('sha256').update(url.href, 'utf8').digest('hex');
    return `https://${url.hostname}/__dev_qa_archive/v1/${key}${extension}`;
}
