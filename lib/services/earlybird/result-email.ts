import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isDevUiDeploymentContext } from '@/lib/constants/dev-ui';
import { sendEmail } from '@/lib/services/email';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { openResultEmailRecipient, paidResultEmailEnabled, readResultEmailKey } from './result-email-recipient';
import { PAID_RESULT_EMAIL_REPLY_TO, renderPaidResultEmail } from './result-email-template';

const claimSchema = z.array(z.object({
    order_id: z.string().uuid(),
    request_id: z.string().uuid(),
    recipient: z.string().regex(/^ord\.[a-f0-9]{32}:[A-Za-z0-9_-]{40,1400}$/),
    target: z.string().regex(/^[a-z0-9._]{1,30}$/),
    send_before: z.string().datetime({ offset: true }),
})).max(1);
const senderAddress = /^[a-z0-9._+-]{1,64}@notify\.yeosachin\.com$/i;
const deadlineSchema = z.string().datetime({ offset: true });

/** Caller already authenticated this order owner. The UI receives only a boolean. */
export async function isPaidResultEmailAvailableForOrder(orderId: string, userId: string): Promise<boolean> {
    if (!paidResultEmailEnabled(process.env) || process.env.VERCEL_ENV !== 'production') return false;
    try {
        const { data, error } = await supabaseAdmin.rpc('paid_result_email_available', {
            p_order_id: orderId, p_owner_id: userId,
        });
        return !error && data === true;
    } catch {
        return false;
    }
}

export async function deliverPaidResultEmails() {
    const summary = { accepted: 0, failed: 0, enabled: false };
    if (process.env.NODE_ENV !== 'production' || isDevUiDeploymentContext(process.env)
        || process.env.DEV_LIVE_WORKLOAD || process.env.CLOUD_RUN_JOB
        || process.env.K_SERVICE !== 'analysis-paid-worker' || process.env.ANALYSIS_WORKLOAD_ROLE !== 'paid') {
        return summary;
    }
    const purge = await supabaseAdmin.rpc('purge_paid_result_email_recipients_v1');
    if (purge.error) summary.failed++;
    if (!paidResultEmailEnabled(process.env)) return summary;
    summary.enabled = true;
    const fromAddress = process.env.PAID_RESULT_EMAIL_FROM?.trim();
    if (!process.env.RESEND_API_KEY?.trim() || !fromAddress || !senderAddress.test(fromAddress)) {
        summary.failed++;
        return summary;
    }
    let key: Buffer;
    try {
        key = readResultEmailKey(process.env);
    } catch {
        summary.failed++;
        return summary;
    }
    for (let i = 0; i < 8; i++) {
        const token = randomUUID();
        const claim = await supabaseAdmin.rpc('claim_paid_result_email', { p_token: token });
        const parsed = claimSchema.safeParse(claim.data);
        if (claim.error || !parsed.success) {
            summary.failed++;
            break;
        }
        const task = parsed.data[0];
        if (!task) break;
        if (Date.now() >= Date.parse(task.send_before)) {
            summary.failed++;
            continue;
        }
        const [sellerReference, sealed] = task.recipient.split(':');
        const delivery = await supabaseAdmin.rpc('paid_result_email_send_deadline_v1', {
            p_order_id: task.order_id, p_token: token,
        });
        if (delivery.error) {
            summary.failed++;
            break;
        }
        let receipt: Awaited<ReturnType<typeof sendEmail>> = null;
        const deadline = deadlineSchema.safeParse(delivery.data);
        if (deadline.success && Date.now() < Date.parse(deadline.data)) {
            try {
                receipt = await sendEmail({
                    ...renderPaidResultEmail(task.target, task.request_id),
                    to: openResultEmailRecipient(sealed, sellerReference, key),
                    replyTo: PAID_RESULT_EMAIL_REPLY_TO,
                    from: `위장여사친판독기 <${fromAddress}>`,
                    idempotencyKey: `paid-result/${task.request_id}`,
                });
            } catch {
                // Retry under the same claim identity without logging recipient data.
            }
        }
        const accepted = Boolean(receipt?.id);
        const finish = await supabaseAdmin.rpc('finish_paid_result_email', {
            p_order_id: task.order_id, p_token: token, p_accepted: accepted,
        });
        if (finish.error || finish.data !== true) {
            // A lost acknowledgement may follow a real send. Keep the claimed row
            // and its original provider key for lease recovery.
            summary.failed++;
            break;
        }
        if (accepted) summary.accepted++;
        else summary.failed++;
    }
    return summary;
}
