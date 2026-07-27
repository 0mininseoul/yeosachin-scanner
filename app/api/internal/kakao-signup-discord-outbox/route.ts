import { NextResponse } from 'next/server';
import { deliverKakaoSignupDiscordNotifications } from '@/lib/services/identity/kakao-signup-discord';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<NextResponse> {
    const expected = process.env.KAKAO_SIGNUP_DISCORD_OUTBOX_CRON_SECRET;
    const authorization = request.headers.get('authorization');
    if (!expected || authorization !== `Bearer ${expected}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // The response contains no recipient or Discord information.
    const claimed = await deliverKakaoSignupDiscordNotifications({ limit: 10 });
    return NextResponse.json({ claimed });
}
