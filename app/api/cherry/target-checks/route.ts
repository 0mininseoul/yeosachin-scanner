import { after } from 'next/server';
import { cherryIpHash, requestTargetCheck } from '@/lib/services/cherry/checkout';
import { targetRequestSchema } from '@/lib/services/cherry/contracts';
import { normalizeTargetUsername } from '@/lib/services/cherry/instagram';
import { cherryJson, cherryUser, readCherryMutation } from '@/lib/services/cherry/session';
import { kickCherryWorker } from '@/lib/services/cherry/worker-kick';

export async function POST(request: Request) {
    const mutation = await readCherryMutation(request);
    if (!mutation.ok) return mutation.response;
    const parsed = targetRequestSchema.safeParse(mutation.body);
    const username = parsed.success ? normalizeTargetUsername(parsed.data.username) : null;
    if (!username) return cherryJson({ code: 'INVALID_USERNAME' }, 400);
    try {
        const user = await cherryUser();
        const result = await requestTargetCheck(username, user?.id ?? null, cherryIpHash(request));
        if (result === 'limited') return cherryJson({ code: 'LIMITED' }, 429);
        if (result.created) after(() => kickCherryWorker({ kind: 'target_check', id: result.id }));
        return cherryJson({ id: result.id });
    } catch {
        return cherryJson({ code: 'UNAVAILABLE' }, 503);
    }
}
