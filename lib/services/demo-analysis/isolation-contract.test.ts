import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../../../supabase/migrations/20260726050000_add_demo_analysis_runs.sql', import.meta.url), 'utf8');
const waitlist = readFileSync(new URL('../../../app/api/earlybird/waitlist/route.ts', import.meta.url), 'utf8');
const expiryMigration = readFileSync(new URL('../../../supabase/migrations/20260727010000_expire_demo_analysis_runs.sql', import.meta.url), 'utf8');

describe('demo persistence isolation contract', () => {
    it('keeps the demo migration service-only and out of production/commercial domains', () => {
        expect(migration).toContain('enable row level security');
        expect(migration).toContain('grant execute');
        expect(migration).toMatch(/to service_role/);
        expect(migration).toContain('grant select, delete on table public.demo_analysis_runs to service_role');
        expect(migration).not.toMatch(/grant\s+(insert|update)\s+on table public\.demo_analysis_runs/i);
        expect(migration).not.toMatch(/analysis_preflights|analysis_requests|earlybird_|groble|inventory|provider|gemini|cloud tasks|cost/i);
        expect(migration).not.toContain('junho_dem');
    });

    it('rejects a demo waitlist request before the production waitlist RPC', () => {
        expect(waitlist).toMatch(/demoAnalysisStore\.findForOwner[\s\S]*?PLAN_SELECTION_UNAVAILABLE[\s\S]*?joinEarlybirdWaitlist/);
    });

    it('atomically rejects an expired unstarted run while allowing idempotent started replays', () => {
        expect(expiryMigration).toMatch(/started_at IS NOT NULL\s+OR\s+created_at \+ interval '30 minutes' > clock_timestamp\(\)/i);
        expect(expiryMigration).toContain('set started_at = coalesce(started_at, clock_timestamp())');
        expect(expiryMigration).toContain('where id = p_run_id and user_id = p_user_id');
    });
});
