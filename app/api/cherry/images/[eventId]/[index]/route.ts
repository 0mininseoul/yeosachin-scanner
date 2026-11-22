import { z } from 'zod';
import { readCherryImage } from '@/lib/services/cherry/images';
import { loadMemberImageKey } from '@/lib/services/cherry/member';
import { cherryJson, cherryUser } from '@/lib/services/cherry/session';

const parameters = z.object({ eventId: z.string().uuid(), index: z.coerce.number().int().min(0).max(6) });

export async function GET(_request: Request, context: { params: Promise<{ eventId: string; index: string }> }) {
    const parsed = parameters.safeParse(await context.params);
    const user = await cherryUser();
    if (!parsed.success || !user) return cherryJson({ code: 'NOT_FOUND' }, 404);
    try {
        const key = await loadMemberImageKey(parsed.data.eventId, parsed.data.index, user.id);
        if (!key) return cherryJson({ code: 'NOT_FOUND' }, 404);
        return new Response(new Uint8Array(await readCherryImage(key)), {
            headers: {
                'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=3600',
                'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, noimageindex',
            },
        });
    } catch {
        return cherryJson({ code: 'UNAVAILABLE' }, 503);
    }
}
