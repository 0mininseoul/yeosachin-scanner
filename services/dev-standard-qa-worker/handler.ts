import { z } from 'zod';
import { POST as paidWorker } from '@/app/api/analysis/v2/worker/route';
import { POST as preflightWorker } from '@/app/api/analysis/preflight/worker/route';
import { parseAnalysisV2WorkerTaskPayload, verifyAnalysisV2TaskAuthorization } from '@/lib/services/analysis/v2-tasks';
import { verifyPreflightTaskAuthorization } from '@/lib/services/analysis/preflight-tasks';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { qaWorkerConfig } from './config';
import { queueName } from './queue-name.mjs';
import { origin, runQaDelivery, taskPath, type QaRole } from './scope';

const preflight = z.object({
    workloadRole: z.literal('preflight'), preflightId: z.uuid(), kind: z.literal('precheckout_blite').optional(),
    generation: z.number().int().positive().optional(), reservationToken: z.uuid().optional(),
    dispatchGeneration: z.number().int().positive().optional(), dispatchToken: z.uuid().optional(),
}).strict();

function resource(role: QaRole, body: unknown) {
    if (role === 'preflight') {
        const task = preflight.parse(body);
        const fenced = task.kind ? task.dispatchGeneration && task.dispatchToken : task.generation && task.reservationToken;
        if (!fenced) throw new Error('DEV_STANDARD_QA_FENCE_REQUIRED');
        return { preflightId: task.preflightId, logicalStage: task.kind ?? 'preflight' };
    }
    const task = parseAnalysisV2WorkerTaskPayload(body);
    if (task.workloadRole !== 'paid') throw new Error('DEV_STANDARD_QA_ROLE_REQUIRED');
    return 'kind' in task ? { preflightId: task.preflightId, logicalStage: task.kind }
        : { requestId: task.requestId, logicalStage: task.jobKey };
}
export async function handleQaWorker(request: Request) {
    const { role, wave } = qaWorkerConfig();
    if (request.method !== 'POST' || request.url !== origin(role) + taskPath(role)
        || request.headers.get('host') !== new URL(origin(role)).host
        || request.headers.get('x-cloudtasks-queuename') !== queueName(role, wave)) return new Response(null, { status: 403 });
    const verify = role === 'paid' ? verifyAnalysisV2TaskAuthorization : verifyPreflightTaskAuthorization;
    if (!await verify(request.headers.get('authorization'))) return new Response(null, { status: 403 });
    let selected;
    try { selected = resource(role, await request.clone().json()); }
    catch { return new Response(null, { status: 400 }); }
    // Verify sealed cohort lineage before setting the provider context. The unchanged
    // route checks OIDC again and claims the exact current DB dispatch generation/token.
    const { data: slot, error } = await supabaseAdmin.rpc('dev_cloud_six_scope_v1', {
        p_wave: wave, ...('preflightId' in selected ? { p_preflight_id: selected.preflightId } : { p_request_id: selected.requestId }),
    });
    if (error) return new Response(null, { status: 503 });
    if (!Number.isInteger(slot) || slot < 1 || slot > 6) return new Response(null, { status: 403 });
    return runQaDelivery({ role, wave, slot, ...selected }, () => role === 'paid' ? paidWorker(request) : preflightWorker(request));
}
