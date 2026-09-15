import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../../../../supabase/migrations/20260716130001_add_selfhosted_profile_global_gate.sql',
        import.meta.url
    ),
    'utf8'
);

interface Reservation {
    schemaVersion: number;
    waitMs: number;
    reservedAt: string;
}

interface ReservationRow {
    result: Reservation;
}

interface GateStateRow {
    nextStartAt: string;
}

let db: PGlite;

async function asRole<T>(
    role: 'anon' | 'authenticated' | 'service_role',
    sql: string,
    params: unknown[] = []
): Promise<Results<T>> {
    await db.exec(`SET ROLE ${role}`);
    try {
        return await db.query<T>(sql, params);
    } finally {
        await db.exec('RESET ROLE');
    }
}

async function reserve(
    intervalMs: number,
    responseGuardMs = 100,
    maxWaitMs = 300_000
): Promise<Reservation> {
    const result = await asRole<ReservationRow>(
        'service_role',
        'SELECT public.reserve_selfhosted_profile_request_start($1, $2, $3) AS result',
        [intervalMs, responseGuardMs, maxWaitMs]
    );
    return result.rows[0].result;
}

describe('selfhosted profile global request-start gate PGlite contract', () => {
    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec(`
            CREATE ROLE anon NOLOGIN;
            CREATE ROLE authenticated NOLOGIN;
            CREATE ROLE service_role NOLOGIN;
        `);
        await db.exec(migration);
    }, 30_000);

    beforeEach(async () => {
        await db.exec(`
            UPDATE public.selfhosted_profile_request_start_gate
            SET next_start_at = pg_catalog.clock_timestamp() + INTERVAL '1 second'
            WHERE singleton IS TRUE;
        `);
    });

    afterAll(async () => {
        await db.close();
    });

    it('serializes overlapping callers into unique interval-spaced reservations', async () => {
        const reservations = await Promise.all([
            reserve(750),
            reserve(750),
            reserve(750),
        ]);
        const reservedTimes = reservations
            .map(reservation => Date.parse(reservation.reservedAt))
            .sort((left, right) => left - right);
        const gateState = await db.query<GateStateRow>(`
            SELECT next_start_at::TEXT AS "nextStartAt"
            FROM public.selfhosted_profile_request_start_gate
            WHERE singleton IS TRUE
        `);

        expect(Object.keys(reservations[0]).sort()).toEqual([
            'reservedAt',
            'schemaVersion',
            'waitMs',
        ]);
        expect(reservations.map(reservation => reservation.schemaVersion)).toEqual([1, 1, 1]);
        expect(new Set(reservedTimes)).toHaveLength(3);
        expect(reservedTimes[1] - reservedTimes[0]).toBe(850);
        expect(reservedTimes[2] - reservedTimes[1]).toBe(850);
        expect(Math.max(...reservations.map(reservation => reservation.waitMs)))
            .toBeLessThanOrEqual(300_000);
        expect(Date.parse(gateState.rows[0].nextStartAt) - reservedTimes[2]).toBe(850);
    });

    it('rejects invalid timing inputs and direct table access for service_role', async () => {
        await expect(reserve(249)).rejects.toThrow();
        await expect(reserve(60_001)).rejects.toThrow();
        await expect(reserve(750, 49)).rejects.toThrow();
        await expect(reserve(750, 1_001)).rejects.toThrow();
        await expect(reserve(750, 100, -1)).rejects.toThrow();
        await expect(reserve(750, 100, 300_001)).rejects.toThrow();
        await expect(asRole(
            'service_role',
            'SELECT * FROM public.selfhosted_profile_request_start_gate'
        )).rejects.toThrow(/permission denied/i);
    });

    it('rejects an over-budget reservation without advancing the singleton', async () => {
        await db.exec(`
            UPDATE public.selfhosted_profile_request_start_gate
            SET next_start_at = pg_catalog.clock_timestamp() + INTERVAL '10 seconds'
            WHERE singleton IS TRUE;
        `);
        const before = await db.query<GateStateRow>(`
            SELECT next_start_at::TEXT AS "nextStartAt"
            FROM public.selfhosted_profile_request_start_gate
            WHERE singleton IS TRUE
        `);

        await expect(reserve(750, 100, 100)).rejects.toThrow();

        const after = await db.query<GateStateRow>(`
            SELECT next_start_at::TEXT AS "nextStartAt"
            FROM public.selfhosted_profile_request_start_gate
            WHERE singleton IS TRUE
        `);
        expect(after.rows[0].nextStartAt).toBe(before.rows[0].nextStartAt);
    });

    it('denies the reservation RPC to anon and authenticated roles', async () => {
        for (const role of ['anon', 'authenticated'] as const) {
            await expect(asRole(
                role,
                'SELECT public.reserve_selfhosted_profile_request_start(750, 100, 300000)'
            )).rejects.toThrow(/permission denied/i);
        }
    });
});
