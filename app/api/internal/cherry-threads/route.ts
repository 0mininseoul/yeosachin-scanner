import { createHash, timingSafeEqual } from 'node:crypto';
import { workOnCherryThreads } from '@/lib/services/cherry/threads/worker';
import { privateJson } from '@/lib/services/admin/operator-route';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(request: Request) {
    const key = process.env.CHERRY_THREADS_CRON_SECRET;
    const authorization = request.headers.get('authorization');
    const hash = (value: string) => createHash('sha256').update(value).digest();
    if (!key || !authorization || !timingSafeEqual(hash(authorization), hash(`Bearer ${key}`))) {
        return privateJson({ error: 'unauthorized' }, 401);
    }
    const result = await workOnCherryThreads();
    return privateJson(result, result.draftOk && result.threadsOk ? 200 : 503);
}
