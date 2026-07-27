import { NextResponse } from 'next/server';
import {
    deliverKakaoSignupDiscordNotifications,
    reconcileStaleKakaoSignupDiscordClaims,
} from '@/lib/services/identity/kakao-signup-discord';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<NextResponse> {
    const expected = process.env.CRON_SECRET;
    const authorization = request.headers.get('authorization');
    if (!expected || authorization !== `Bearer ${expected}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // The response contains no recipient or Discord information.
    const reconciled = await reconcileStaleKakaoSignupDiscordClaims();
    const claimed = await deliverKakaoSignupDiscordNotifications({ limit: 10 });
    return NextResponse.json({ claimed, reconciled });
}
