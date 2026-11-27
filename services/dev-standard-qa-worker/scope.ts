import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

export const project = 'gen-lang-client-0311522474';
export const number = '919163272964';
export const region = 'asia-northeast3';
export const dbOrigin = 'https://bgamojfpkxnnumfvkron.supabase.co';
export type QaRole = 'preflight' | 'paid';
export function service(role: QaRole) { return 'dev-standard-qa-' + role; }
export function origin(role: QaRole) { return 'https://' + service(role) + '-' + number + '.' + region + '.run.app'; }
export function taskPath(role: QaRole) { return role === 'paid' ? '/api/analysis/v2/worker' : '/api/analysis/preflight/worker'; }

type Delivery = { wave: string; role: QaRole; slot: number; logicalKey: string; requestId?: string; preflightId?: string };
const delivery = new AsyncLocalStorage<Delivery>();
export function qaDelivery() {
    const active = delivery.getStore();
    if (!active) throw new Error('DEV_STANDARD_QA_DELIVERY_REQUIRED');
    return active;
}
export function runQaDelivery<T>(input: Omit<Delivery, 'logicalKey'> & { logicalStage: string }, run: () => T) {
    const logicalKey = createHash('sha256').update(JSON.stringify([input.wave, input.slot, input.role,
        input.requestId ?? input.preflightId, input.logicalStage])).digest('hex');
    return delivery.run({ ...input, logicalKey }, run);
}
export function isPaidWorkerService(env: Readonly<Record<string, string | undefined>>) {
    const active = delivery.getStore();
    return active?.role === 'paid' && active.wave === env.DEV_STANDARD_QA_WAVE && env.K_SERVICE === service('paid')
        && env.ANALYSIS_WORKLOAD_ROLE === active.role && env.GOOGLE_CLOUD_PROJECT === project;
}
