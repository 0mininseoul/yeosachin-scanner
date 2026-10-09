import { handleDevUiProgressRead } from '@/lib/services/dev-ui/routes';

export async function GET(request: Request, context: { params: Promise<{ requestId: string }> }) {
    return handleDevUiProgressRead(request, (await context.params).requestId);
}
