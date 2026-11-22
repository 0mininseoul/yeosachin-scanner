import { NextResponse } from 'next/server';
import { appRedirectUrlForRequest } from '@/lib/constants/app-url';
import { completeTossBilling } from '@/lib/services/cherry/billing';
import { requireCherryMember } from '@/lib/services/cherry/session';

export const maxDuration = 120;

const KEY = /^[A-Za-z0-9_\-=.@]{1,300}$/;

function finish(request: Request, pay: string): NextResponse {
    const response = NextResponse.redirect(appRedirectUrlForRequest(request.url, `/cherry/home?pay=${pay}`), 303);
    response.headers.set('Cache-Control', 'private, no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
}

/** Toss returns the browser here after the card window; the one-time key is exchanged on the server. */
export async function GET(request: Request) {
    const parameters = new URL(request.url).searchParams;
    const authKey = parameters.get('authKey') ?? '';
    const customerKey = parameters.get('customerKey') ?? '';
    if (!KEY.test(authKey) || !KEY.test(customerKey)) return finish(request, 'failed');
    const member = await requireCherryMember();
    if (!member.ok) return finish(request, 'login');
    try {
        const outcome = await completeTossBilling({ userId: member.userId, authKey, customerKey });
        return finish(request, outcome === 'paid' || outcome === 'no_order' ? 'done' : outcome === 'unknown' ? 'checking' : 'failed');
    } catch {
        return finish(request, 'checking');
    }
}
