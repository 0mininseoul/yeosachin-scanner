const legacyDemoAvatarPattern = /^\/demo-avatars\/synthetic-blurred-avatar-[1-4]-v1\.png$/u;
const v3DemoAvatarPattern = /^\/demo-avatars\/demo-v3-(?:target|female|private)-\d{3}\.webp$/u;

/**
 * Keeps result-page images on known local paths or the existing server proxy.
 * This deliberately rejects direct and protocol-relative remote image URLs.
 */
export function safeResultImageUrl(url: string | undefined): string | undefined {
    if (!url) return undefined;
    return url.startsWith('/api/image-proxy?')
        || legacyDemoAvatarPattern.test(url)
        || v3DemoAvatarPattern.test(url)
        ? url
        : undefined;
}
