export const AUTH_REDIRECT_INTENT_COOKIE = 'auth_redirect_intent';
export const AUTH_REDIRECT_INTENT_TTL_SECONDS = 30 * 60;

const MAX_REDIRECT_INTENT_LENGTH = 2_048;

export function serializeOAuthRedirectIntent(
    nextPath: string,
    secure = true,
): string | null {
    if (
        typeof nextPath !== 'string'
        || nextPath.length === 0
        || nextPath.length > MAX_REDIRECT_INTENT_LENGTH
        || !nextPath.startsWith('/')
        || nextPath.startsWith('//')
        || /[\\\u0000-\u001f\u007f;]/.test(nextPath)
    ) return null;

    return `${AUTH_REDIRECT_INTENT_COOKIE}=${encodeURIComponent(nextPath)}; Max-Age=${AUTH_REDIRECT_INTENT_TTL_SECONDS}; Path=/; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function writeOAuthRedirectIntentCookie(
    nextPath: string,
    writeCookie: (value: string) => void,
    secure = true,
): boolean {
    const serialized = serializeOAuthRedirectIntent(nextPath, secure);
    if (!serialized) return false;
    try {
        writeCookie(serialized);
        return true;
    } catch {
        return false;
    }
}

export function readOAuthRedirectIntent(cookieHeader: string | null): string | null {
    if (!cookieHeader) return null;
    for (const part of cookieHeader.split(';')) {
        const separator = part.indexOf('=');
        if (separator < 0) continue;
        const name = part.slice(0, separator).trim();
        if (name !== AUTH_REDIRECT_INTENT_COOKIE) continue;
        try {
            const value = decodeURIComponent(part.slice(separator + 1).trim());
            return serializeOAuthRedirectIntent(value, false) ? value : null;
        } catch {
            return null;
        }
    }
    return null;
}

export function selectOAuthRedirectIntent(
    explicitNext: string | null,
    cookieNext: string | null,
): string | null {
    const explicit = explicitNext?.trim() || null;
    // A provider can legally collapse an encoded callback destination to the
    // site root. Prefer the browser-bound intent in that case; the callback
    // still validates the selected path and claim token server-side.
    if (cookieNext && (!explicit || explicit === '/')) return cookieNext;
    return explicit ?? cookieNext;
}
