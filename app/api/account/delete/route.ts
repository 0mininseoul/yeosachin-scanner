import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { isJsonRequest, isSameOriginMutation } from '@/lib/services/earlybird/contracts';
import {
    AccountDeletionError,
    deleteAccountPermanently,
} from '@/lib/services/identity/account-deletion';

const bodySchema = z.object({ confirmation: z.literal('탈퇴') }).strict();

export async function POST(request: Request) {
    if (!isSameOriginMutation(request) || !isJsonRequest(request)) {
        return NextResponse.json({ code: 'ACCOUNT_DELETION_REQUEST_REJECTED' }, { status: 403 });
    }

    const body = bodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
        return NextResponse.json({ code: 'ACCOUNT_DELETION_CONFIRMATION_REQUIRED' }, { status: 400 });
    }

    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) {
        return NextResponse.json({ code: 'ACCOUNT_DELETION_AUTH_REQUIRED' }, { status: 401 });
    }

    try {
        await deleteAccountPermanently(user.id);
        await supabase.auth.signOut({ scope: 'local' }).catch(() => undefined);
        return NextResponse.json({ deleted: true });
    } catch (deletionError) {
        const code = deletionError instanceof AccountDeletionError
            ? deletionError.code
            : 'ACCOUNT_DELETION_FAILED';
        console.error('[account-deletion] request failed', { code });
        return NextResponse.json({ code }, { status: 503 });
    }
}
