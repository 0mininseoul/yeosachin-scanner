import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { appRedirectUrlForRequest } from '@/lib/constants/app-url';

export async function proxy(request: NextRequest) {
    let supabaseResponse = NextResponse.next({
        request,
    });

    // Auth Callback, API, Static, Share 파일은 proxy 로직 건너뛰기
    // /share는 비로그인 상태에서도 접근 가능해야 함 (결과 공유 기능)
    if (request.nextUrl.pathname.startsWith('/auth') ||
        request.nextUrl.pathname.startsWith('/api') ||
        request.nextUrl.pathname.startsWith('/share') ||
        request.nextUrl.pathname.startsWith('/_next') ||
        request.nextUrl.pathname.startsWith('/static')) {
        return supabaseResponse;
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
                    cookiesToSet.forEach(({ name, value, options }) =>
                        supabaseResponse.cookies.set(name, value, options)
                    );
                },
            },
        }
    );

    // 세션 체크 (getUser는 서버 사이드에서 안전한 방법)
    const {
        data: { user },
    } = await supabase.auth.getUser();

    const redirectWithAuthCookies = (url: URL) => {
        const redirectResponse = NextResponse.redirect(url);
        supabaseResponse.cookies.getAll().forEach(cookie => {
            redirectResponse.cookies.set(cookie);
        });
        return redirectResponse;
    };

    // 디버깅: 로그인 직후 리다이렉트된 경우인데 유저가 없으면 로그 출력
    if (request.nextUrl.searchParams.get('verified') === 'true' && !user) {
        console.error('Proxy: Login verified but NO USER FOUND.');
        const cookies = request.cookies.getAll();
        console.log('Proxy Cookies:', cookies.map(c => c.name).join(', '));
    }

    // 보호된 경로 체크
    const protectedPaths = ['/analyze', '/progress', '/result'];
    const isProtectedPath = protectedPaths.some((path) =>
        request.nextUrl.pathname.startsWith(path)
    );

    // 보호된 경로인데 로그인 안 된 경우 → 로그인 페이지로
    if (isProtectedPath && !user) {
        const url = request.nextUrl.clone();
        const redirectTo = `${request.nextUrl.pathname}${request.nextUrl.search}`;
        url.pathname = '/login';
        url.search = '';
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

    return supabaseResponse;
}

export const config = {
    matcher: [
        '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
    ],
};
