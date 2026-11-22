import { NextResponse } from 'next/server';
import { isJsonRequest, isSameOriginMutation } from '@/lib/services/earlybird/contracts';
import { requireActiveAccountSession } from '@/lib/services/identity/account-principal-store';
import { createClient } from '@/lib/supabase/server';

export function cherryJson(body: unknown, status = 200): NextResponse {
    return NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

export async function cherryUser(): Promise<{ id: string; email: string | null } | null> {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    return error || !user ? null : { id: user.id, email: user.email ?? null };
}

/** A signed-in member with an active account row; first-time Kakao members get theirs here. */
export async function requireCherryMember(): Promise<{ ok: true; userId: string } | { ok: false; response: NextResponse }> {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) return { ok: false, response: cherryJson({ code: 'UNAUTHORIZED' }, 401) };
    try {
        await requireActiveAccountSession(user);
    } catch {
        return { ok: false, response: cherryJson({ code: 'ACCOUNT_UNAVAILABLE' }, 403) };
    }
    return { ok: true, userId: user.id };
}

export async function readCherryMutation(request: Request, maxBytes = 2048): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
    if (!isSameOriginMutation(request)) return { ok: false, response: cherryJson({ code: 'ORIGIN' }, 403) };
    if (!isJsonRequest(request)) return { ok: false, response: cherryJson({ code: 'CONTENT_TYPE' }, 415) };
    const text = await request.text().catch(() => '');
    if (Buffer.byteLength(text) > maxBytes) return { ok: false, response: cherryJson({ code: 'TOO_LARGE' }, 413) };
    try {
        return { ok: true, body: JSON.parse(text) };
    } catch {
        return { ok: false, response: cherryJson({ code: 'INVALID' }, 400) };
    }
}
