import { NextResponse } from 'next/server';
import {
    deliverSentryDiscordAlerts,
    reconcileStaleSentryDiscordAlertClaims,
} from '@/lib/services/sentry-discord-alert';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<NextResponse> {
    const expected = process.env.CRON_SECRET;
    if (!expected || request.headers.get('authorization') !== `Bearer ${expected}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const reconciled = await reconcileStaleSentryDiscordAlertClaims();
    const claimed = await deliverSentryDiscordAlerts({ limit: 10 });
    return NextResponse.json({ claimed, reconciled });
}
