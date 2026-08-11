/**
 * Session Replay is opt-in and route-scoped.  This module is intentionally
 * framework-independent so the allowlist can be asserted in browser and
 * server contract tests without starting the Amplitude SDK.
 */
export const REPLAY_ALLOWED_STATIC_PATHS = Object.freeze([
    '/', '/privacy', '/terms', '/login', '/analyze', '/betatest',
    '/earlybird', '/mypage',
] as const);

export const REPLAY_ALLOWED_DYNAMIC_PATHS = Object.freeze([
    /^\/progress\/[A-Za-z0-9-]+$/,
    /^\/result\/[A-Za-z0-9-]+$/,
    /^\/share\/[A-Za-z0-9_-]+$/,
] as const);

export const REPLAY_RESULT_ALLOW_SELECTOR = '[data-amp-block]';
export const REPLAY_DEFAULT_MASK_SELECTOR = '[data-amp-mask]';

export function isReplayAllowedPath(pathname: string): boolean {
    return REPLAY_ALLOWED_STATIC_PATHS.includes(pathname as never)
        || REPLAY_ALLOWED_DYNAMIC_PATHS.some(pattern => pattern.test(pathname));
}

/** New result descendants must opt into the component allowlist explicitly. */
export function replayFieldDisposition(input: {
    isResultContent: boolean;
    hasAllowMarker: boolean;
    containsSensitiveInput: boolean;
}): 'allow' | 'mask' | 'block' {
    if (input.containsSensitiveInput) return 'mask';
    if (!input.isResultContent) return 'mask';
    return input.hasAllowMarker ? 'allow' : 'block';
}
