import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    createCanonicalCommerceStore,
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
            /REVOKE EXECUTE ON FUNCTION public\.record_payment_event_v1\(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER\) FROM PUBLIC, anon, authenticated;/,
        );
        expect(sql).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.record_payment_event_v1\(TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER\) TO service_role;/,
        );
    });
});

describe('canonical commerce store', () => {
    it('records a payment event idempotently through the service RPC', async () => {
        const rpc = async (name: string, params: Record<string, unknown>) => {
            expect(name).toBe('record_payment_event_v1');
            expect(params).toEqual({
                p_event_id: 'evt_1',
                p_idempotency_key: 'delivery_1',
                p_event_type: 'payment.completed',
                p_payment_id: 'merchant_1',
                p_payload_hash: 'a'.repeat(64),
                p_amount_krw: 14900,
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
            payloadHash: 'a'.repeat(64),
            amountKrw: 14900,
        })).resolves.toEqual({ status: 'recorded', duplicate: false });
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
            payloadHash: 'b'.repeat(64),
            amountKrw: 14900,
        }, async input => {
            calls.push(`maintenance:${input.kind}`);
        })).resolves.toEqual({ status: 'maintenance_queued' });
        expect(calls).toEqual(['record_payment_event_v1', 'maintenance:payment_event']);
    });
});
