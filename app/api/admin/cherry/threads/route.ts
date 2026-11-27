import { privateJson, requireConsoleOperator } from '@/lib/services/admin/operator-route';
import { readCherryMutation } from '@/lib/services/cherry/session';
import { adminAction, applyEditorialAction, loadEditorialConsole } from '@/lib/services/cherry/threads/store';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function GET() {
    const operator = await requireConsoleOperator();
    if (!operator.ok) return operator.response;
    try {
        return privateJson(await loadEditorialConsole());
    } catch {
        return privateJson({ error: 'unavailable' }, 503);
    }
}

export async function POST(request: Request) {
    const requestBody = await readCherryMutation(request, 20_000);
    if (!requestBody.ok) return requestBody.response;
    const operator = await requireConsoleOperator();
    if (!operator.ok) return operator.response;
    const action = adminAction.safeParse(requestBody.body);
    if (!action.success) return privateJson({ error: 'invalid_request' }, 400);
    try {
        const result = await applyEditorialAction(action.data);
        return result ? privateJson({ outcome: result }) : privateJson({ error: 'conflict' }, 409);
    } catch {
        return privateJson({ error: 'unavailable' }, 503);
    }
}
