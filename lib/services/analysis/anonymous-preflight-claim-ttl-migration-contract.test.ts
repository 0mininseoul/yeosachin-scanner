import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationsDir = resolve(process.cwd(), 'supabase/migrations');
const migrations = readdirSync(migrationsDir)
    .filter(name => name.endsWith('.sql'))
    .map(name => readFileSync(resolve(migrationsDir, name), 'utf8'))
    .join('\n');

describe('anonymous preflight claim TTL migration contract', () => {
    it('accepts claims for the full preflight lifetime and retry window', () => {
        expect(migrations).toContain(
            "p_claim_expires_at > v_now + INTERVAL '30 minutes'",
        );
    });
});
