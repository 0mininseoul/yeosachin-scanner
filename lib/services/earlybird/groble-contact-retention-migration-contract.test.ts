import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
    '../../../supabase/migrations/20260719130000_stop_persisting_groble_buyer_contacts.sql',
    import.meta.url
);
const migration = existsSync(migrationUrl) ? readFileSync(migrationUrl, 'utf8') : '';

const CONTACT_COLUMNS = [
    'groble_buyer_email',
    'groble_buyer_phone_number',
    'groble_buyer_display_name',
] as const;

describe('Groble buyer contact retention fence migration', () => {
    it('is a forward-only purge after the current remote migration sequence', () => {
        expect(migration).toContain("SET LOCAL lock_timeout = '5s'");
        expect(migration).toContain("SET LOCAL statement_timeout = '2min'");
        for (const table of ['earlybird_orders', 'earlybird_webhook_events']) {
            expect(migration).toMatch(new RegExp(
                `UPDATE public\\.${table}[\\s\\S]*?SET[\\s\\S]*?groble_buyer_email = NULL[\\s\\S]*?groble_buyer_phone_number = NULL[\\s\\S]*?groble_buyer_display_name = NULL`
            ));
        }
    });

    it('installs an old-writer-compatible nulling fence on both contact-bearing tables', () => {
        expect(migration).toMatch(
            /CREATE OR REPLACE FUNCTION public\.clear_groble_buyer_contacts\(\)[\s\S]*?RETURNS TRIGGER[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = ''/
        );
        for (const column of CONTACT_COLUMNS) {
            expect(migration).toContain(`NEW.${column} := NULL`);
        }
        expect(migration).toMatch(
            /CREATE TRIGGER clear_groble_contacts_on_orders[\s\S]*?BEFORE INSERT OR UPDATE ON public\.earlybird_orders[\s\S]*?EXECUTE FUNCTION public\.clear_groble_buyer_contacts\(\)/
        );
        expect(migration).toMatch(
            /CREATE TRIGGER clear_groble_contacts_on_webhook_events[\s\S]*?BEFORE INSERT OR UPDATE ON public\.earlybird_webhook_events[\s\S]*?EXECUTE FUNCTION public\.clear_groble_buyer_contacts\(\)/
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.clear_groble_buyer_contacts\(\)\s+FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(migration).not.toMatch(/GRANT EXECUTE[\s\S]*?clear_groble_buyer_contacts/);
        expect(migration).not.toMatch(/DROP COLUMN\s+groble_buyer_/);
    });
});
