import { loadToss } from '@/lib/services/toss/browser';

/** Opens the card registration window. Card numbers are entered at Toss, never on this site. */
export async function openTossBilling(input: {
    clientKey: string; customerKey: string; email: string | null; checkId: string | null;
}): Promise<void> {
    const toss = await loadToss();
    const origin = window.location.origin;
    const back = input.checkId ? `/cherry/start?check=${input.checkId}&pay=failed` : '/cherry/home?pay=failed';
    await toss(input.clientKey).payment({ customerKey: input.customerKey }).requestBillingAuth({
        method: 'CARD', successUrl: `${origin}/api/cherry/toss/return`, failUrl: `${origin}${back}`,
        ...(input.email ? { customerEmail: input.email } : {}),
    });
}
