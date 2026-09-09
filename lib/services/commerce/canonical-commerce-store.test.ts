import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    createCanonicalCommerceStore,
    canonicalJsonHash,
    recordPaymentEventWithMaintenance,
} from './canonical-commerce-store';

function migrationSql(): string {
    const migration = readdirSync(join(process.cwd(), 'supabase/migrations'))
        .filter(name => name.endsWith('_add_commerce_operation_canonical_tables.sql'))
        .sort();
    if (migration.length !== 1) {
        throw new Error(
            `Expected one generated commerce migration, found ${migration.length}`,
        );
    }
    return readFileSync(
        join(process.cwd(), 'supabase/migrations', migration[0]),
        'utf8',
    );
}

describe('commerce canonical migration contract', () => {
    it('preserves the provider order/evidence fields and accepts zero-value events', () => {
        const sql = migrationSql();
        expect(sql).toContain('order_id UUID REFERENCES public.earlybird_orders(id) ON DELETE SET NULL');
        expect(sql).toContain('occurred_at TIMESTAMPTZ NOT NULL');
        expect(sql).toContain('disposition TEXT NOT NULL');
        expect(sql).toContain('payload JSONB NOT NULL');
        expect(sql).toContain('p_amount_krw IS NOT NULL AND p_amount_krw < 0');
        expect(sql).toContain('PAYMENT_EVENT_IDEMPOTENCY_CONFLICT');
        expect(sql).toContain('PAYMENT_EVENT_IDEMPOTENCY_KEY_CONFLICT');
    });

    it('defines the seven additive canonical tables and their bounded state checks', () => {
        const sql = migrationSql();
        for (const table of [
            'payment_events',
            'fulfillment_jobs',
            'notification_outbox',
            'account_lifecycle',
            'system_configuration',
            'system_leases',
            'maintenance_jobs',
        ]) {
            expect(sql).toContain(`CREATE TABLE public.${table}`);
            expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
            expect(sql).toContain(`ALTER TABLE public.${table} FORCE ROW LEVEL SECURITY`);
        }
        expect(sql).toContain('UNIQUE (kind, target_key_hash)');
        expect(sql).toContain('event_id TEXT NOT NULL UNIQUE');
        expect(sql).toContain('idempotency_key TEXT NOT NULL UNIQUE');
        expect(sql).toContain('dedupe_key TEXT NOT NULL UNIQUE');
        expect(sql).toContain("state IN ('draft', 'effective', 'retired')");
        expect(sql).toContain("kind IN ('provider', 'capacity', 'maintenance', 'notification')");
        expect(sql).toContain('PAYMENT_PENDING_PROVIDER_EVIDENCE_REQUIRED');
    });

    it('keeps canonical evidence append-only and exposes no browser ACL', () => {
        const sql = migrationSql();
        expect(sql).toContain('commerce_append_only');
        expect(sql).toContain('BEFORE UPDATE OR DELETE');
        expect(sql).toContain('REVOKE ALL ON TABLE public.payment_events');
        expect(sql).toContain('REVOKE ALL ON TABLE public.maintenance_jobs');
        expect(sql).not.toMatch(/GRANT .* TO anon/i);
        expect(sql).not.toMatch(/GRANT .* TO authenticated/i);
        expect(sql).not.toMatch(/provider_token|access_token|cookie|raw_body|buyer_phone/i);
    });

    it('restricts every canonical security-definer RPC to service_role', () => {
        const sql = migrationSql();
        const functionBodies = [...sql.matchAll(
            /CREATE(?: OR REPLACE)? FUNCTION public\.[\s\S]*?\$\$[\s\S]*?\$\$/g,
        )].map(match => match[0]);
        expect(functionBodies.length).toBeGreaterThan(0);
        for (const body of functionBodies) {
            expect(body).toMatch(/SECURITY DEFINER/);
            expect(body).toMatch(/SET search_path = ''/);
        }
        expect(sql).toMatch(
            /REVOKE EXECUTE ON FUNCTION public\.record_payment_event_v1\(TEXT, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ, INTEGER\) FROM PUBLIC, anon, authenticated;/,
        );
        expect(sql).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.record_payment_event_v1\(TEXT, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, JSONB, TIMESTAMPTZ, INTEGER\) TO service_role;/,
        );
    });
});

describe('canonical commerce store', () => {
    it('records a payment event with order linkage, provider time, disposition, and payload', async () => {
        const rpc = async (name: string, params: Record<string, unknown>) => {
            expect(name).toBe('record_payment_event_v1');
            expect(params).toEqual({
                p_event_id: 'evt_1',
                p_idempotency_key: 'delivery_1',
                p_event_type: 'payment.completed',
                p_payment_id: 'merchant_1',
                p_order_id: '123e4567-e89b-42d3-a456-426614174000',
                p_provider: 'groble',
                p_disposition: 'accepted',
                p_payload_hash: 'a'.repeat(64),
                p_payload: { amount_krw: 0, occurred_at: '2026-09-09T00:00:00.000Z' },
                p_occurred_at: '2026-09-09T00:00:00.000Z',
                p_amount_krw: 0,
            });
            return {
                data: { status: 'recorded', duplicate: false },
                error: null,
            };
        };
        const store = createCanonicalCommerceStore({ rpc });

        await expect(store.recordPaymentEvent({
            eventId: 'evt_1',
            idempotencyKey: 'delivery_1',
            eventType: 'payment.completed',
            paymentId: 'merchant_1',
            orderId: '123e4567-e89b-42d3-a456-426614174000',
            provider: 'groble',
            disposition: 'accepted',
            payloadHash: 'a'.repeat(64),
            payload: { amount_krw: 0, occurred_at: '2026-09-09T00:00:00.000Z' },
            occurredAt: '2026-09-09T00:00:00.000Z',
            amountKrw: 0,
        })).resolves.toEqual({ status: 'recorded', duplicate: false });
    });

    it('rejects a payment event whose idempotency evidence conflicts', async () => {
        const store = createCanonicalCommerceStore({
            rpc: async () => ({
                data: null,
                error: { code: 'P0001', message: 'PAYMENT_EVENT_IDEMPOTENCY_CONFLICT' },
            }),
        });

        await expect(store.recordPaymentEvent({
            eventId: 'evt_1',
            idempotencyKey: 'delivery_1',
            eventType: 'payment.completed',
            paymentId: 'merchant_1',
            orderId: null,
            provider: 'groble',
            disposition: 'accepted',
            payloadHash: 'a'.repeat(64),
            payload: {},
            occurredAt: '2026-09-09T00:00:00.000Z',
            amountKrw: 0,
        })).rejects.toMatchObject({
            code: 'CANONICAL_COMMERCE_IDEMPOTENCY_CONFLICT',
        });
    });

    it('queues a bounded maintenance marker when a canonical write fails', async () => {
        const calls: string[] = [];
        const store = createCanonicalCommerceStore({
            rpc: async name => {
                calls.push(name);
                return { data: null, error: new Error('canonical unavailable') };
            },
        });

        await expect(recordPaymentEventWithMaintenance(store, {
            eventId: 'evt_2',
            idempotencyKey: 'delivery_2',
            eventType: 'payment.completed',
            paymentId: 'merchant_2',
            orderId: null,
            provider: 'groble',
            disposition: 'accepted',
            payloadHash: 'b'.repeat(64),
            payload: {},
            occurredAt: '2026-09-09T00:00:00.000Z',
            amountKrw: 14900,
        }, async input => {
            calls.push(`maintenance:${input.kind}`);
        })).resolves.toEqual({ status: 'maintenance_queued' });
        expect(calls).toEqual(['record_payment_event_v1', 'maintenance:payment_event']);
    });

    it('reports canonical and maintenance outage instead of claiming a queued marker', async () => {
        const store = createCanonicalCommerceStore({
            rpc: async () => ({ data: null, error: new Error('unavailable') }),
        });

        await expect(recordPaymentEventWithMaintenance(store, {
            eventId: 'evt_3',
            idempotencyKey: 'delivery_3',
            eventType: 'payment.completed',
            paymentId: 'merchant_3',
            orderId: null,
            provider: 'groble',
            disposition: 'accepted',
            payloadHash: 'c'.repeat(64),
            payload: {},
            occurredAt: '2026-09-09T00:00:00.000Z',
            amountKrw: 0,
        }, async () => {
            throw new Error('maintenance unavailable');
        })).resolves.toEqual({
            status: 'unavailable',
            code: 'CANONICAL_MAINTENANCE_UNAVAILABLE',
        });
    });

    it('derives deterministic configuration-style hashes from validated JSON values', () => {
        expect(canonicalJsonHash('config', { b: 2, a: 1 }))
            .toBe(canonicalJsonHash('config', { a: 1, b: 2 }));
    });
});
