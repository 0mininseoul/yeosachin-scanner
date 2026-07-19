import { createClient } from '@/lib/supabase/server';
import { appOriginForRequest } from '@/lib/constants/app-url';
import { NextResponse } from 'next/server';

export async function POST(request: Request) {
    try {
        const supabase = await createClient();
        const { error } = await supabase.auth.signOut();
        if (error) {
            console.error('Sign out failed');
            return NextResponse.json({ error: 'Failed to sign out' }, { status: 500 });
        }

        return NextResponse.redirect(new URL('/', appOriginForRequest(request.url)), {
            status: 302,
        });
    } catch {
        console.error('Sign out failed');
        return NextResponse.json({ error: 'Failed to sign out' }, { status: 500 });
    }
}
