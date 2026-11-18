import 'server-only';

import type { User } from '@supabase/supabase-js';
import { appRedirectUrlForRequest, DEFAULT_APP_REDIRECT_PATH } from '@/lib/constants/app-url';
import { assertDevUiTester } from './access';

const SINGLE_EMAIL = /^[^\s,;@]+@[^\s,;@]+\.[^\s,;@]+$/u;

export type DevUiSiteAccess = 'allowed' | 'unauthenticated' | 'denied' | 'unavailable';

type DevUiAuthUser = Pick<User, 'id' | 'email' | 'app_metadata' | 'identities'>;

function normalizedEmail(value: unknown): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** The user object must come from the Dev Supabase server's getUser response. */
export function getDevUiSiteAccess(user: DevUiAuthUser | null, request: Pick<Request, 'url'>): DevUiSiteAccess {
    if (!user) return 'unauthenticated';
    const email = normalizedEmail(process.env.DEV_UI_ALLOWED_KAKAO_EMAIL);
    if (!SINGLE_EMAIL.test(email)) return 'unavailable';

    const identity = user.identities?.length === 1 ? user.identities[0] : null;
    if (user.app_metadata?.provider !== 'kakao' || identity?.provider !== 'kakao'
        || identity.identity_data?.email_verified !== true
        || normalizedEmail(identity.identity_data?.email) !== email
        || normalizedEmail(user.email) !== email) return 'denied';

    try {
        assertDevUiTester(user.id, request);
        return 'allowed';
    } catch {
        return 'denied';
    }
}

export function devUiPostLoginUrl(requestUrl: string, redirectTo: string | null): URL {
    const destination = appRedirectUrlForRequest(requestUrl, redirectTo);
    const path = destination.pathname.replace(/\/$/u, '');
    if (path === '/login' || path === '/auth/callback') {
        return appRedirectUrlForRequest(requestUrl, DEFAULT_APP_REDIRECT_PATH);
    }
    return destination;
}

export function devUiLoginUrl(requestUrl: string, redirectTo: string | null, error?: string): URL {
    const loginUrl = appRedirectUrlForRequest(requestUrl, '/login');
    const destination = devUiPostLoginUrl(requestUrl, redirectTo);
    loginUrl.searchParams.set('redirectTo', `${destination.pathname}${destination.search}${destination.hash}`);
    if (error) loginUrl.searchParams.set('error', error);
    return loginUrl;
}
