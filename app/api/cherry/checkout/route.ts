import { beginCherryCheckout } from '@/lib/services/cherry/checkout';
import { checkoutRequestSchema } from '@/lib/services/cherry/contracts';
import { cherryJson, readCherryMutation, requireCherryMember } from '@/lib/services/cherry/session';

export async function POST(request: Request) {
    const mutation = await readCherryMutation(request);
    if (!mutation.ok) return mutation.response;
    const parsed = checkoutRequestSchema.safeParse(mutation.body);
    if (!parsed.success) return cherryJson({ code: 'INVALID' }, 400);
    const member = await requireCherryMember();
    if (!member.ok) return member.response;
    try {
        return cherryJson(await beginCherryCheckout(member.userId, parsed.data.targetCheckId, parsed.data.expectedAmountKrw));
    } catch {
        return cherryJson({ code: 'UNAVAILABLE' }, 503);
    }
}
