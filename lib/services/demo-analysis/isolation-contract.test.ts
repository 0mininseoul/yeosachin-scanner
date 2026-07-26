import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../../../supabase/migrations/20260726050000_add_demo_analysis_runs.sql', import.meta.url), 'utf8');
const waitlist = readFileSync(new URL('../../../app/api/earlybird/waitlist/route.ts', import.meta.url), 'utf8');

describe('demo persistence isolation contract', () => {
    it('keeps the demo migration service-only and out of production/commercial domains', () => {
        expect(migration).toContain('enable row level security');
        expect(migration).toContain('grant execute');
        expect(migration).toMatch(/to service_role/);
        expect(migration).not.toMatch(/analysis_preflights|analysis_requests|earlybird_|groble|inventory|provider|gemini|cloud tasks|cost/i);
        expect(migration).not.toContain('junho_dem');
    });

    it('rejects a demo waitlist request before the production waitlist RPC', () => {
        expect(waitlist).toMatch(/demoAnalysisStore\.findForOwner[\s\S]*?PLAN_SELECTION_UNAVAILABLE[\s\S]*?joinEarlybirdWaitlist/);
    });
});
