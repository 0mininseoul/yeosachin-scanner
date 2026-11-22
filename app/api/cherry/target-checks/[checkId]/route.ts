import { z } from 'zod';
import { loadTargetCheck, targetView } from '@/lib/services/cherry/checkout';
import { cherryJson, cherryUser } from '@/lib/services/cherry/session';

export async function GET(_request: Request, context: { params: Promise<{ checkId: string }> }) {
    const { checkId } = await context.params;
    if (!z.string().uuid().safeParse(checkId).success) return cherryJson({ code: 'NOT_FOUND' }, 404);
    try {
        const row = await loadTargetCheck(checkId, (await cherryUser())?.id ?? null);
        return row ? cherryJson(targetView(row)) : cherryJson({ code: 'NOT_FOUND' }, 404);
    } catch {
        return cherryJson({ code: 'UNAVAILABLE' }, 503);
    }
}
