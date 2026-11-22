import { beginCherryRenewal } from '@/lib/services/cherry/checkout';
import { cherryJson, readCherryMutation, requireCherryMember } from '@/lib/services/cherry/session';

export async function POST(request: Request) {
    const mutation = await readCherryMutation(request);
    if (!mutation.ok) return mutation.response;
    const member = await requireCherryMember();
    if (!member.ok) return member.response;
    try {
        return cherryJson(await beginCherryRenewal(member.userId));
    } catch {
        return cherryJson({ code: 'UNAVAILABLE' }, 503);
    }
}
