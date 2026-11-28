export * from '@/lib/services/media/secure-image-fetch';
import type { SecureImageDownloadOptions } from '@/lib/services/media/secure-image-fetch';
import { createSharedImageSource } from '../../tests/analysis/execution/fixtures/standard-shared-image-source';
import { target, privateCandidate, profileItem, publicUsername } from '../../tests/analysis/execution/fixtures/standard-providers';
import { qaDelivery } from './scope';

const source = createSharedImageSource();
const catalog = new Set<string>();
for (const name of [target, privateCandidate, ...Array.from({ length: process.env.DEV_STANDARD_QA_PLAN === 'plus' ? 900 : 600 }, (_, i) => publicUsername(i))]) {
    const item = profileItem(name);
    for (const uri of [item.profilePicUrl, ...item.latestPosts.map(p => p.displayUrl)]) catalog.add(new URL(uri).pathname);
}
export async function downloadSecureImage(uri: string, options: SecureImageDownloadOptions) {
    qaDelivery();
    const url = new URL(uri);
    if (url.origin !== 'https://scontent.cdninstagram.com' || url.username || url.password || !catalog.has(url.pathname))
        throw new Error('DEV_STANDARD_QA_IMAGE_OUTSIDE_FIXTURE');
    options.signal?.throwIfAborted();
    const bytes = await source(uri);
    options.signal?.throwIfAborted();
    if (bytes.length > options.maxBytes) throw new Error('DEV_STANDARD_QA_IMAGE_TOO_LARGE');
    return { bytes, contentType: 'image/png', finalUrl: uri };
}
