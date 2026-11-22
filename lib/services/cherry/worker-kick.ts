import { createCloudTasksClient } from '@/lib/services/analysis/background-tasks';
import { getCloudTasksCallerAuthConfig } from '@/lib/services/google/vercel-wif';

/**
 * Asks the worker to start now instead of at its next minute. Losing a kick is harmless: the scheduler
 * finds the same queued row.
 */
export async function kickCherryWorker(
    work: { kind: 'target_check'; id: string }, env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
    const project = env.CHERRY_TASKS_PROJECT?.trim() ?? '';
    const location = env.CHERRY_TASKS_LOCATION?.trim() ?? '';
    const queue = env.CHERRY_TASKS_QUEUE?.trim() ?? '';
    const workerOrigin = env.CHERRY_WORKER_AUDIENCE?.trim().replace(/\/$/, '') ?? '';
    const serviceAccountEmail = env.CHERRY_TASKS_SERVICE_ACCOUNT_EMAIL?.trim() ?? '';
    if (!project || !location || !queue || !serviceAccountEmail || !workerOrigin.startsWith('https://')) return false;
    try {
        const client = await createCloudTasksClient({ callerAuth: getCloudTasksCallerAuthConfig({
            env, projectId: project, modeKey: 'ANALYSIS_V2_TASKS_CALLER_AUTH_MODE',
            enqueuerServiceAccountEmailKey: 'ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL', errorPrefix: 'CHERRY_TASKS',
        }) });
        await client.createTask({
            parent: client.queuePath(project, location, queue),
            task: {
                name: client.taskPath(project, location, queue, `${work.kind.replace('_', '-')}-${work.id}`),
                dispatchDeadline: { seconds: 300 },
                httpRequest: {
                    httpMethod: 'POST', url: `${workerOrigin}/api/cherry/worker`, headers: { 'Content-Type': 'application/json' },
                    body: Buffer.from(JSON.stringify(work)).toString('base64'),
                    oidcToken: { serviceAccountEmail, audience: workerOrigin },
                },
            },
        });
        return true;
    } catch {
        return false;
    }
}
