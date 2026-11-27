import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import {
    appRedirectUrlForRequest,
    CANONICAL_APP_ORIGIN,
} from '@/lib/constants/app-url';
import { DEV_UI_ROBOTS_HEADER } from '@/lib/constants/dev-ui';
import { devUiRequestBoundary } from '@/lib/services/dev-ui/deployment';
import { isDevCloudSixOwnerRead } from '@/lib/services/dev-ui/standard-cloud-owner-read';
import { assertDevUiAdministrator } from '@/lib/services/dev-ui/access';
import { classifyOperatorAuthError, getAnalysisAuditOperatorDecision } from '@/lib/services/analysis/score-audit';
import { devUiLoginUrl, devUiPostLoginUrl, getDevUiSiteAccess } from '@/lib/services/dev-ui/site-access';
import { KAKAO_ATTRIBUTION_COOKIE, classifyKakaoSignupAttribution, encodeKakaoSignupAttribution, normalizeKakaoReferrerOrigin } from '@/lib/services/identity/kakao-signup-attribution';
import { ADMIN_CONSOLE_PATH, readAdminConsoleDestination } from '@/lib/contracts/admin-console';
import { AUTH_REDIRECT_INTENT_COOKIE, readOAuthRedirectIntent } from '@/lib/services/auth/oauth-redirect-intent';
import { isKnownAiFetcher, isLegalPagePath } from '@/lib/services/seo/legal-page-crawlers';

const LEGACY_PUBLIC_HOSTNAMES = new Set([
    'www.yeosachin.com',
    'yeosachin.vercel.app',
    'ai-yeosachinscanner.vercel.app',
]);

export async function proxy(request: NextRequest) {
    if (process.env.DEV_LIVE_WORKLOAD !== undefined || process.env.K_SERVICE?.startsWith('dev-live-')) {
        const { devLiveWorkerRequestBoundary } = await import('@/lib/services/dev-ui/live-runtime');
        const workerBoundary = devLiveWorkerRequestBoundary(request);
        const response = workerBoundary === 'dev-worker'
            ? NextResponse.next({ request })
            : NextResponse.json({ error: 'DEV_LIVE_WORKER_DISABLED' }, { status: 403 });
        response.headers.set('Cache-Control', 'private, no-store');
        response.headers.set('X-Robots-Tag', DEV_UI_ROBOTS_HEADER);
        return response;
    }
    const deploymentBoundary = devUiRequestBoundary(request);
    const withDevHeaders = (response: NextResponse): NextResponse => {
        if (deploymentBoundary !== 'production') {
            response.headers.set('X-Robots-Tag', DEV_UI_ROBOTS_HEADER);
            response.headers.set('Cache-Control', 'private, no-store');
        }
        return response;
    };
    if (deploymentBoundary === 'invalid' || deploymentBoundary === 'forbidden') {
        return withDevHeaders(NextResponse.json({
            error: deploymentBoundary === 'invalid' ? 'DEV_UI_DEPLOYMENT_REJECTED' : 'DEV_UI_ROUTE_DISABLED',
        }, { status: deploymentBoundary === 'invalid' ? 503 : 403 }));
    }
    const publicLegalPage = deploymentBoundary === 'production' && isLegalPagePath(request.nextUrl.pathname);
    if (publicLegalPage && isKnownAiFetcher(request.headers.get('user-agent'))) {
        return new NextResponse(null, {
            status: 403,
            headers: { 'Cache-Control': 'private, no-store', Vary: 'User-Agent' },
        });
    }
    // Keep the old webhook/API endpoints reachable while external providers
    // switch to the canonical domain. Browser navigations are permanently
    // redirected so one public URL is indexed and shared.
    if (
        (request.method === 'GET' || request.method === 'HEAD')
        && LEGACY_PUBLIC_HOSTNAMES.has(request.nextUrl.hostname)
    ) {
        const canonicalUrl = new URL(request.nextUrl.pathname + request.nextUrl.search, CANONICAL_APP_ORIGIN);
        return NextResponse.redirect(canonicalUrl, 308);
    }

    // GoTrue can return a missing/expired OAuth state to SiteURL before our
    // callback runs. The intent only restores the login screen destination.
    const parameters = request.nextUrl.searchParams;
    const isRootOAuthStateError = request.method === 'GET' && request.nextUrl.pathname === '/'
        && parameters.getAll('error').length === 1 && parameters.get('error') === 'invalid_request'
        && parameters.getAll('error_code').length === 1 && parameters.get('error_code') === 'bad_oauth_state'
        && !parameters.has('code');
    const oauthRedirectIntent = isRootOAuthStateError
        ? readOAuthRedirectIntent(request.headers.get('cookie'))
        : null;
    if (isRootOAuthStateError && deploymentBoundary === 'production') {
        const destination = readAdminConsoleDestination(oauthRedirectIntent);
        if (destination) {
            const url = appRedirectUrlForRequest(request.url, destination);
            url.searchParams.set('error', 'bad_oauth_state');
            const response = NextResponse.redirect(url);
            response.cookies.delete(AUTH_REDIRECT_INTENT_COOKIE);
            response.headers.set('Cache-Control', 'private, no-store');
            return withDevHeaders(response);
        }
    }

    let supabaseResponse = NextResponse.next({
        request,
    });

    const pathname = request.nextUrl.pathname;
    // Dev's exact callback is the session entry point. Its handler checks the
    // exchanged account before proceeding with the app's callback work.
    if (deploymentBoundary === 'dev' && pathname === '/auth/callback') {
        return withDevHeaders(supabaseResponse);
    }
    // Production APIs and shared pages retain their own access policies.
    if (deploymentBoundary === 'production' && (
        pathname.startsWith('/auth') || pathname.startsWith('/api') || pathname.startsWith('/share')
        || pathname.startsWith('/_next') || pathname.startsWith('/static')
    )) return supabaseResponse;

    // Capture first touch once on a real page navigation only. The server never
    // stores a URL, query string, referrer, click ID, or other identifier.
    if (deploymentBoundary === 'production' && request.method === 'GET' && !request.cookies.has(KAKAO_ATTRIBUTION_COOKIE)) {
        supabaseResponse.cookies.set(KAKAO_ATTRIBUTION_COOKIE,
            encodeKakaoSignupAttribution(classifyKakaoSignupAttribution(request.nextUrl.search, request.headers.get('referer') ?? ''), normalizeKakaoReferrerOrigin(request.headers.get('referer') ?? '')), {
                maxAge: 30 * 60, path: '/', httpOnly: true, sameSite: 'lax', secure: true,
            });
    }

    const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                getAll() {
                    return request.cookies.getAll();
                },
                setAll(cookiesToSet) {
                    cookiesToSet.forEach(({ name, value }) =>
                        request.cookies.set(name, value)
                    );
                    supabaseResponse = NextResponse.next({
                        request,
                    });
                    if (deploymentBoundary === 'production' && !request.cookies.has(KAKAO_ATTRIBUTION_COOKIE)) {
                        supabaseResponse.cookies.set(KAKAO_ATTRIBUTION_COOKIE,
                            encodeKakaoSignupAttribution(classifyKakaoSignupAttribution(
                                request.nextUrl.search, request.headers.get('referer') ?? '',
                            ), normalizeKakaoReferrerOrigin(request.headers.get('referer') ?? '')), {
                                maxAge: 30 * 60, path: '/', httpOnly: true, sameSite: 'lax', secure: true,
                            });
                    }
                    cookiesToSet.forEach(({ name, value, options }) =>
                        supabaseResponse.cookies.set(name, value, options)
                    );
                },
            },
        }
    );

    // 세션 체크 (getUser는 서버 사이드에서 안전한 방법)
    const { data: { user }, error: authError } = await supabase.auth.getUser().catch(error => {
        if (deploymentBoundary === 'production') throw error;
        return { data: { user: null }, error: new Error('DEV_UI_AUTH_UNAVAILABLE') };
    });

    const withAuthCookies = (response: NextResponse): NextResponse => {
        supabaseResponse.cookies.getAll().forEach(cookie => response.cookies.set(cookie));
        return withDevHeaders(response);
    };
    const redirectWithAuthCookies = (url: URL) => withAuthCookies(NextResponse.redirect(url));

    if (deploymentBoundary === 'dev') {
        let access = authError
            ? classifyOperatorAuthError(authError) === 'unauthorized' ? 'unauthenticated' : 'unavailable'
            : getDevUiSiteAccess(user, request);
        if (access === 'denied') {
            try {
                if (await isDevCloudSixOwnerRead(user, request, supabase)) access = 'allowed';
            } catch {
                access = 'unavailable';
            }
        }
        const isLoginRequest = (pathname === '/login' || pathname === '/login/')
            && (request.method === 'GET' || request.method === 'HEAD');
        if (isLoginRequest) {
            if (access === 'allowed') {
                return redirectWithAuthCookies(devUiPostLoginUrl(request.url, parameters.get('redirectTo')));
            }
            return withDevHeaders(supabaseResponse);
        }
        if (access !== 'allowed') {
            const status = access === 'unavailable' ? 503 : access === 'denied' ? 403 : 401;
            if (pathname.startsWith('/api') || (request.method !== 'GET' && request.method !== 'HEAD')) {
                const error = access === 'unavailable' ? 'DEV_UI_AUTH_UNAVAILABLE'
                    : access === 'denied' ? 'DEV_UI_ACCESS_DENIED' : 'UNAUTHORIZED';
                return withAuthCookies(NextResponse.json({ error }, { status }));
            }
            const destination = isRootOAuthStateError
                ? readAdminConsoleDestination(oauthRedirectIntent) ?? oauthRedirectIntent
                : `${pathname}${request.nextUrl.search}`;
            const error = access === 'denied' ? 'dev_access_denied'
                : access === 'unavailable' ? 'dev_auth_unavailable'
                    : isRootOAuthStateError ? 'bad_oauth_state' : undefined;
            const response = redirectWithAuthCookies(devUiLoginUrl(request.url, destination, error));
            if (isRootOAuthStateError) response.cookies.delete(AUTH_REDIRECT_INTENT_COOKIE);
            return response;
        }
        const adminDestination = isRootOAuthStateError ? readAdminConsoleDestination(oauthRedirectIntent) : null;
        if (adminDestination) {
            const url = appRedirectUrlForRequest(request.url, adminDestination);
            url.searchParams.set('error', 'bad_oauth_state');
            const response = redirectWithAuthCookies(url);
            response.cookies.delete(AUTH_REDIRECT_INTENT_COOKIE);
            return response;
        }
    }

    // A completed callback consumes its intent cookie. A later duplicate
    // provider return may still carry the state error while its session is valid.
    if (isRootOAuthStateError && !oauthRedirectIntent && !authError && user) {
        let authorized = false;
        try {
            if (deploymentBoundary === 'dev') {
                assertDevUiAdministrator(user.id, request);
                authorized = true;
            } else {
                authorized = getAnalysisAuditOperatorDecision(user.id) === 'authorized';
            }
        } catch {
            // Unavailable operator configuration retains the normal landing.
        }
        if (authorized) {
            const response = redirectWithAuthCookies(appRedirectUrlForRequest(request.url, ADMIN_CONSOLE_PATH));
            response.headers.set('Cache-Control', 'private, no-store');
            return response;
        }
    }

    // 디버깅: 로그인 직후 리다이렉트된 경우인데 유저가 없으면 로그 출력
    if (deploymentBoundary === 'production' && parameters.get('verified') === 'true' && !user) {
        console.error('Proxy: Login verified but NO USER FOUND.');
        const cookies = request.cookies.getAll();
        console.log('Proxy Cookies:', cookies.map(c => c.name).join(', '));
    }

    // 보호된 경로 체크
    // Anonymous users may run the profile-only preflight and see its bounded
    // plan/pricing snapshot on /analyze. Execution, results, and checkout stay
    // owner-gated below and at their respective API boundaries.
    const protectedPaths = ['/progress', '/result', '/earlybird'];
    const isProtectedPath = protectedPaths.some((path) =>
        request.nextUrl.pathname.startsWith(path)
    );

    // 보호된 경로인데 로그인 안 된 경우 → 로그인 페이지로
    if (isProtectedPath && !user) {
        const url = appRedirectUrlForRequest(request.url, '/login');
        const redirectTo = `${request.nextUrl.pathname}${request.nextUrl.search}`;
        url.searchParams.set('redirectTo', redirectTo);
        return redirectWithAuthCookies(url);
    }

    // 이미 로그인된 사용자는 검증된 내부 목적지로 이동
    if (request.nextUrl.pathname === '/login' && user) {
        const redirectUrl = appRedirectUrlForRequest(
            request.url,
            request.nextUrl.searchParams.get('redirectTo')
        );
        return redirectWithAuthCookies(redirectUrl);
    }

    if (publicLegalPage) {
        supabaseResponse.headers.set('X-Robots-Tag', 'noindex, nosnippet, noarchive');
        supabaseResponse.headers.append('Vary', 'User-Agent');
    }
    return withDevHeaders(supabaseResponse);
}

export const config = {
    matcher: [
        // An encoded API prefix can also end in an image suffix. Its raw URL
        // must reach the guard before Next decodes it into a dynamic handler.
        // Next's encoded dynamic-page chunks retain the static asset bypass.
        '/((?!_next/static|_next/image|favicon.ico).*%.*)',
        // Dynamic API/owned page parameters can resemble image filenames. They
        // must still pass the deployment boundary instead of the static bypass.
        '/api/:path*',
        '/auth/:path*',
        '/admin/:path*',
        '/progress/:path*',
        '/result/:path*',
        '/earlybird/:path*',
        '/mypage/:path*',
        '/share/:path*',
        '/dev-ui/:path*',
        '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
    ],
};
