import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260727020000_add_analysis_v2_ai_scheduler_policy_snapshot.sql',
    import.meta.url
), 'utf8');

let db: PGlite;

async function validates(snapshot: unknown): Promise<boolean> {
    const result = await db.query<{ valid: boolean }>(
        'SELECT public.analysis_v2_valid_policy_versions_snapshot($1::JSONB) AS valid',
        [JSON.stringify(snapshot)]
    );
    return result.rows[0]?.valid ?? false;
}

beforeAll(async () => {
    db = new PGlite();
    await db.exec('CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;');
    await db.exec(migration);
});

afterAll(async () => {
    await db.close();
});

describe('analysis V2 AI scheduler policy snapshot validator', () => {
    const legacySnapshot = {
        pipeline: 'v2',
        risk: 'risk-policy-v2.4',
        aiStage: 'ai-stage-policy-v2.7',
    };

    it('preserves the exact legacy snapshot', async () => {
        expect(await validates(legacySnapshot)).toBe(true);
    });

    it('accepts only the exact optional scheduler value', async () => {
        expect(await validates({ ...legacySnapshot, scheduler: 'ai-scheduler-v1' })).toBe(true);
        expect(await validates({ ...legacySnapshot, scheduler: 'ai-scheduler-v2' })).toBe(false);
        expect(await validates({ ...legacySnapshot, scheduler: null })).toBe(false);
        expect(await validates({ ...legacySnapshot, scheduler: { version: 'ai-scheduler-v1' } })).toBe(false);
    });

    it('rejects unknown policy fields', async () => {
        expect(await validates({ ...legacySnapshot, futurePolicy: 'v1' })).toBe(false);
    });
});
