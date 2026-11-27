import { randomBytes, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { CHERRY_THREADS_CONSOLE_PATH } from '@/lib/contracts/admin-console';
import { privateJson, requireConsoleOperator } from '@/lib/services/admin/operator-route';
import { authorizeUrl, connectThreads, metaConfigured } from '@/lib/services/cherry/threads/meta';
import { writeConnection } from '@/lib/services/cherry/threads/store';

const cookieName = 'cherry_threads_oauth_state';
const path = '/api/admin/cherry/threads/oauth';

export async function GET(request: NextRequest) {
    const operator = await requireConsoleOperator();
    if (!operator.ok) return operator.response;
    if (!metaConfigured()) return privateJson({ error: 'not_configured' }, 503);

    const params = request.nextUrl.searchParams;
    if (params.get('start') === '1') {
        const state = randomBytes(32).toString('hex');
        const response = NextResponse.redirect(authorizeUrl(state));
        response.headers.set('Cache-Control', 'private, no-store');
        response.cookies.set(cookieName, state, { httpOnly: true, secure: true, sameSite: 'lax', path, maxAge: 600 });
        return response;
    }

    const saved = request.cookies.get(cookieName)?.value || '';
    const state = params.get('state') || '';
    const code = params.get('code');
    let result = 'failed';
    if (code && /^[a-f0-9]{64}$/.test(saved) && /^[a-f0-9]{64}$/.test(state)
        && timingSafeEqual(Buffer.from(saved), Buffer.from(state))) {
        try {
            const account = await connectThreads(code);
            await writeConnection(account.profile.id, account.access_token, account.expires_in);
            result = 'connected';
        } catch { /* Never return provider errors or credentials in the browser. */ }
    }
    const target = new URL(CHERRY_THREADS_CONSOLE_PATH, process.env.CHERRY_THREADS_REDIRECT_URI);
    target.searchParams.set('threads', result);
    const response = NextResponse.redirect(target);
    response.headers.set('Cache-Control', 'private, no-store');
    response.cookies.set(cookieName, '', { httpOnly: true, secure: true, sameSite: 'lax', path, maxAge: 0 });
    return response;
}
