import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

export async function GET(request: Request) {
    const { searchParams, origin } = new URL(request.url);
    const code = searchParams.get('code');
    // 오픈 리다이렉트 방지: 내부 절대경로('/...')만 허용, 프로토콜-상대('//')·절대 URL 차단
    const rawNext = searchParams.get('next') ?? '/analyze';
    const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/analyze';

    // 리다이렉트 URL 계산
    const forwardedHost = request.headers.get('x-forwarded-host');
    const baseUrl = forwardedHost ? `https://${forwardedHost}` : origin;

    if (!code) {
        console.error('Auth callback: No code provided');
        return NextResponse.redirect(`${baseUrl}/login?error=no_code`);
    }

    const cookieStore = await cookies();

    // Supabase 클라이언트 생성 - cookieStore.set() 사용 (Next.js 네이티브 방식)
    const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
            cookies: {
                getAll() {
                    return cookieStore.getAll();
                },
                setAll(cookiesToSet) {
                    cookiesToSet.forEach(({ name, value, options }) => {
                        cookieStore.set(name, value, options);
                    });
                },
            },
        }
    );

    // 코드 교환 실행
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
        console.error('Auth callback error:', error);
        return NextResponse.redirect(`${baseUrl}/login?error=${encodeURIComponent(error.message)}`);
    }

    // 세션 검증을 통해 쿠키 설정 강제 (setAll 트리거)
    await supabase.auth.getUser();

    const redirectUrl = new URL(next, baseUrl);
    redirectUrl.searchParams.set('verified', 'true');

    return NextResponse.redirect(redirectUrl);
}
