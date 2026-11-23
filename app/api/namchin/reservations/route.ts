import { NextResponse } from 'next/server';
import { z } from 'zod';
import { normalizeKoreanMobileNumber } from '@/lib/services/identity/phone-number';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { campaignClosesAt } from '@/public/cherry/campaign.mjs';

const maxBytes = 2048;
const reservationSchema = z.object({
    email: z.string().trim().max(254).email().toLowerCase(),
    phone: z.string().max(24),
    consent: z.literal(true),
    privateAck: z.literal(true),
}).strict();

function reply(body: object, status = 200) {
    return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function readRequest(request: Request): Promise<unknown> {
    const reader = request.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) return JSON.parse(Buffer.concat(chunks).toString('utf8'));
            size += value.byteLength;
            if (size > maxBytes) {
                await reader.cancel();
                return null;
            }
            chunks.push(value);
        }
    } catch {
        return null;
    } finally {
        reader.releaseLock();
    }
}

export function GET() {
    const serverTime = Date.now();
    return reply({ status: serverTime < campaignClosesAt ? 'open' : 'closed', serverTime });
}

export async function POST(request: Request) {
    if (request.headers.get('origin') !== new URL(request.url).origin) return reply({ error: 'origin' }, 403);
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') {
        return reply({ error: 'content_type' }, 415);
    }
    const parsed = reservationSchema.safeParse(await readRequest(request));
    if (!parsed.success) return reply({ error: 'invalid_registration' }, 400);
    const phone = normalizeKoreanMobileNumber(parsed.data.phone);
    if (!phone) return reply({ error: 'invalid_registration' }, 400);
    if (Date.now() >= campaignClosesAt) return reply({ status: 'closed' }, 410);

    const { email } = parsed.data;
    try {
        const { error } = await supabaseAdmin.from('namchin_launch_reservations').insert({ email, phone });
        // Keep the original consent and make retries indistinguishable from new submissions.
        if (!error || error.code === '23505') return reply({ received: true });
    } catch {
        // Avoid emitting storage errors that can contain the submitted contact details.
    }
    return reply({ error: 'unavailable' }, 503);
}
