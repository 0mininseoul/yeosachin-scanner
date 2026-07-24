import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ insert: vi.fn(), from: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { from: mocks.from },
}));

import { insertLandingLead, LeadPersistenceError } from './store';

beforeEach(() => {
    mocks.insert.mockReset();
    mocks.from.mockReset();
    mocks.from.mockReturnValue({ insert: mocks.insert });
});

describe('insertLandingLead', () => {
    it('maps input to snake_case columns and inserts once', async () => {
        mocks.insert.mockResolvedValue({ error: null });
        await insertLandingLead({
            instagramId: 'suzy',
            rawInput: '@Suzy',
            utmSource: 'instagram',
            referrer: 'https://x',
            userAgent: 'UA',
        });
        expect(mocks.from).toHaveBeenCalledWith('landing_leads');
        expect(mocks.insert).toHaveBeenCalledWith({
            instagram_id: 'suzy',
            input_context: 'target',
            source_preflight_id: undefined,
            raw_input: '@Suzy',
            utm_source: 'instagram',
            utm_medium: undefined,
            utm_campaign: undefined,
            utm_content: undefined,
            utm_term: undefined,
            referrer: 'https://x',
            user_agent: 'UA',
        });
    });

    it('stores an excluded lead with its replay key and no raw input', async () => {
        mocks.insert.mockResolvedValue({ error: null });

        await insertLandingLead({
            instagramId: 'girlfriend.name',
            inputContext: 'excluded',
            sourcePreflightId: '123e4567-e89b-42d3-a456-426614174000',
        });

        expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({
            instagram_id: 'girlfriend.name',
            input_context: 'excluded',
            source_preflight_id: '123e4567-e89b-42d3-a456-426614174000',
            raw_input: undefined,
        }));
    });

    it('throws LeadPersistenceError when supabase reports an error', async () => {
        mocks.insert.mockResolvedValue({ error: { message: 'boom' } });
        await expect(insertLandingLead({ instagramId: 'suzy' }))
            .rejects.toBeInstanceOf(LeadPersistenceError);
    });
});
