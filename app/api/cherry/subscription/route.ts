import { memberActionSchema } from '@/lib/services/cherry/contracts';
import { cherryRpc } from '@/lib/services/cherry/rpc';
import { cherryJson, readCherryMutation, requireCherryMember } from '@/lib/services/cherry/session';

export async function POST(request: Request) {
    const mutation = await readCherryMutation(request);
    if (!mutation.ok) return mutation.response;
    const parsed = memberActionSchema.safeParse(mutation.body);
    if (!parsed.success) return cherryJson({ code: 'INVALID' }, 400);
    const member = await requireCherryMember();
    if (!member.ok) return member.response;
    try {
        const result = await cherryRpc<{ outcome: string }>('cherry_member_action', { p_user: member.userId, p_action: parsed.data.action });
        return cherryJson({ outcome: result.outcome }, result.outcome === 'done' ? 200 : 409);
    } catch {
        return cherryJson({ code: 'UNAVAILABLE' }, 503);
    }
}
