import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationsDirectory = new URL('../../../supabase/migrations/', import.meta.url);

describe('Supabase migration versions', () => {
    it('keeps every filename prefix unique', () => {
        const versions = readdirSync(migrationsDirectory)
            .filter(name => name.endsWith('.sql'))
            .map(name => name.split('_', 1)[0]);

        expect(new Set(versions).size).toBe(versions.length);
    });
});
