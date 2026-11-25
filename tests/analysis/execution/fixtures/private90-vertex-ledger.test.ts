import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { private90VertexLedger } from './private90-vertex-ledger';

it('accepts an unused pre-dispatch release and identifies orphan, duplicate and unsettled holds', async () => {
    const db = await PGlite.create();
    const grant = randomUUID();
    const sent = randomUUID();
    const attempt = randomUUID();
    try {
        await db.exec(`CREATE SCHEMA dev_live_budget;
            CREATE TABLE dev_live_budget.reservations (grant_id uuid, provider text, reservation_id uuid,
            vertex_attempt_key uuid, actual_micros integer, unused_before_dispatch boolean);`);
        const hold = (id: string, key: string, cost: number | null, released: boolean) => db.query(
            "INSERT INTO dev_live_budget.reservations VALUES($1,'vertex',$2,$3,$4,$5)", [grant,id,key,cost,released]);
        await hold(sent, attempt, 24, false);
        await hold(randomUUID(), attempt, 0, true);
        expect(await private90VertexLedger(db, grant, [sent])).toEqual({
            positive: 1, unused: 1, unresolved: 0, duplicate: 0, orphan: 0, debit: 24,
        });
        await hold(randomUUID(), attempt, 12, false);
        await hold(randomUUID(), randomUUID(), null, false);
        await hold(randomUUID(), randomUUID(), 0, false);
        expect(await private90VertexLedger(db, grant, [sent])).toEqual({
            positive: 2, unused: 1, unresolved: 2, duplicate: 1, orphan: 1, debit: 36,
        });
    } finally {
        await db.close();
    }
});
