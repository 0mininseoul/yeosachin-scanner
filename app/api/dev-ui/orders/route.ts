import { handleDevUiOwnerOrders } from '@/lib/services/dev-ui/routes';

export async function GET(request: Request) {
    return handleDevUiOwnerOrders(request);
}
