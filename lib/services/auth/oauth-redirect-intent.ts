export const AUTH_REDIRECT_INTENT_COOKIE = 'auth_redirect_intent';
export const AUTH_REDIRECT_INTENT_TTL_SECONDS = 30 * 60;

const MAX_REDIRECT_INTENT_LENGTH = 2_048;
const OAUTH_CONTINUATION_PARAMETERS = ['plan', 'checkout'] as const;

/**
 * Keep the anonymous preflight capability in the OAuth callback URL itself.
 * Some providers preserve the callback path but normalize or drop a nested
 * `next` value. The claim is still verified by the callback and the database;
 * this helper only duplicates the already bounded internal destination.
 */
export function addAnonymousPreflightOAuthContinuation(
    callbackUrl: URL,
    destination: URL,
): void {
    if (destination.pathname !== '/analyze') return;
    const preflight = destination.searchParams.get('preflight');
    const claim = destination.searchParams.get('claim');
    if (!preflight || !claim) return;

    callbackUrl.searchParams.set('next', '/analyze');
    callbackUrl.searchParams.set('preflight', preflight);
    callbackUrl.searchParams.set('claim', claim);
    for (const parameter of OAUTH_CONTINUATION_PARAMETERS) {
        const value = destination.searchParams.get(parameter);
        if (value) callbackUrl.searchParams.set(parameter, value);
    }
}

/**
 * Rebuild the bounded analyze destination from the callback's direct
 * continuation parameters. Only values needed to resume checkout are copied;
 * arbitrary callback query parameters never become a redirect target.
 */
export function readAnonymousPreflightOAuthContinuation(
    searchParams: URLSearchParams,
): string | null {
    const preflight = searchParams.get('preflight');
    const claim = searchParams.get('claim');
    if (!preflight || !claim) return null;

    const destination = new URL('/analyze', 'https://oauth-intent.invalid');
    destination.searchParams.set('preflight', preflight);
    destination.searchParams.set('claim', claim);
    for (const parameter of OAUTH_CONTINUATION_PARAMETERS) {
        const value = searchParams.get(parameter);
        if (value) destination.searchParams.set(parameter, value);
    }
    return `${destination.pathname}${destination.search}`;
}

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

    // Some providers preserve only the analyze path and drop the continuation
    // query entirely. The browser-bound cookie is the fallback for that exact
    // flow; its signed, short-lived, one-use claim is verified by the callback
    // before it can bind anything. A different explicit preflight remains
    // authoritative and is not merged.
    if (explicit && cookieNext) {
        try {
            const explicitUrl = new URL(explicit, 'https://oauth-intent.invalid');
            const cookieUrl = new URL(cookieNext, 'https://oauth-intent.invalid');
            const cookiePreflight = cookieUrl.searchParams.get('preflight');
            const cookieClaim = cookieUrl.searchParams.get('claim');
            const explicitPreflight = explicitUrl.searchParams.get('preflight');
            if (
                explicitUrl.pathname === '/analyze'
                && cookieUrl.pathname === '/analyze'
                && cookiePreflight
                && cookieClaim
                && !explicitUrl.searchParams.has('claim')
                && (!explicitPreflight || explicitPreflight === cookiePreflight)
            ) return cookieNext;
        } catch {
            // appRedirectUrlForRequest performs the final redirect validation.
        }
    }

    return explicit ?? cookieNext;
}
