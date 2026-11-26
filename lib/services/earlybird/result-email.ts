import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isDevUiDeploymentContext } from '@/lib/constants/dev-ui';
import { sendAnalysisCompleteEmail } from '@/lib/services/email';
import { supabaseAdmin } from '@/lib/supabase/admin';

type Environment = Readonly<Record<string, string | undefined>>;
const claimSchema = z.array(z.object({
    order_id: z.string().uuid(),
    request_id: z.string().uuid(),
    recipient: z.string().max(254).regex(/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/),
    target: z.string().regex(/^[a-z0-9._]{1,30}$/),
    send_before: z.string().datetime({ offset: true }),
})).max(1);

function enabled(env: Environment): boolean {
    return env.PAID_RESULT_EMAIL_ENABLED === 'true' && env.NODE_ENV === 'production'
        && !isDevUiDeploymentContext(env) && !env.DEV_LIVE_WORKLOAD && !env.CLOUD_RUN_JOB;
}

/** Caller already authenticated this order owner. The UI receives only a boolean. */
export async function isPaidResultEmailAvailableForOrder(orderId: string, userId: string): Promise<boolean> {
    if (!enabled(process.env) || process.env.VERCEL_ENV !== 'production') return false;
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
    if (!enabled(process.env) || process.env.K_SERVICE !== 'analysis-paid-worker'
        || process.env.ANALYSIS_WORKLOAD_ROLE !== 'paid') return summary;
    summary.enabled = true;
    if (!process.env.RESEND_API_KEY?.trim() || !process.env.RESEND_FROM_EMAIL?.trim()) {
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
        const receipt = await sendAnalysisCompleteEmail(
            task.recipient, task.target, task.request_id, `paid-result/${task.request_id}`,
        );
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
