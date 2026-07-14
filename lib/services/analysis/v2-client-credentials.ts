import type { PlanId } from '@/lib/domain/analysis/plan-catalog';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
const SIGNED_TOKEN_PATTERN = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const USERNAME_PATTERN = /^[a-z0-9._]{1,30}$/;

export interface TestAdmissionCredential {
    idempotencyKey: string;
    token: string;
}

interface ReadableStorage {
    getItem(key: string): string | null;
}

interface MutableStorage extends ReadableStorage {
    removeItem(key: string): void;
}

export function normalizeInstagramUsername(value: string): string | null {
    const normalized = value.trim().replace(/^@+/, '').toLowerCase();
    return USERNAME_PATTERN.test(normalized) ? normalized : null;
}

export function testAdmissionStorageKey(targetInstagramId: string): string {
    return `analysis_v2_test_admission:${targetInstagramId}`;
}

export function testEntitlementStorageKey(preflightId: string, planId: PlanId): string {
    return `analysis_v2_test_entitlement:${preflightId}:${planId}`;
}

export function readTestAdmissionCredential(
    storage: ReadableStorage,
    targetInstagramId: string
): TestAdmissionCredential | null {
    const raw = storage.getItem(testAdmissionStorageKey(targetInstagramId));
    if (!raw) return null;

    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (
            typeof parsed.idempotencyKey !== 'string'
            || !IDEMPOTENCY_KEY_PATTERN.test(parsed.idempotencyKey)
            || typeof parsed.token !== 'string'
            || !SIGNED_TOKEN_PATTERN.test(parsed.token)
        ) {
            return null;
        }
        return {
            idempotencyKey: parsed.idempotencyKey,
            token: parsed.token,
        };
    } catch {
        return null;
    }
}

export function consumeTestAdmissionCredential(
    storage: MutableStorage,
    targetInstagramId: string
): void {
    storage.removeItem(testAdmissionStorageKey(targetInstagramId));
}

export function readTestEntitlementToken(
    storage: ReadableStorage,
    preflightId: string,
    planId: PlanId
): string | null {
    const token = storage.getItem(testEntitlementStorageKey(preflightId, planId));
    return token && SIGNED_TOKEN_PATTERN.test(token) ? token : null;
}

export function consumeTestEntitlementToken(
    storage: MutableStorage,
    preflightId: string,
    planId: PlanId
): void {
    storage.removeItem(testEntitlementStorageKey(preflightId, planId));
}
