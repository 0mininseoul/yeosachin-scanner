import { handleDevUiCheckoutComplete, handleDevUiCheckoutRead } from '@/lib/services/dev-ui/routes';

export async function GET(request: Request, context: { params: Promise<{ orderId: string }> }) {
    return handleDevUiCheckoutRead(request, (await context.params).orderId);
}

export async function POST(request: Request, context: { params: Promise<{ orderId: string }> }) {
    return handleDevUiCheckoutComplete(request, (await context.params).orderId);
}
