import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ insert: vi.fn(), from: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));

import { insertLandingLead, LeadPersistenceError } from './store';

beforeEach(() => {
    mocks.insert.mockReset();
    mocks.from.mockReset();
    mocks.rpc.mockReset();
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
        mocks.rpc.mockResolvedValue({ data: true, error: null });

        await insertLandingLead({
            instagramId: 'girlfriend.name',
            inputContext: 'excluded',
            sourcePreflightId: '123e4567-e89b-42d3-a456-426614174000',
        });

        expect(mocks.rpc).toHaveBeenCalledWith('create_or_replay_landing_lead_exclusion', {
            p_source_preflight_id: '123e4567-e89b-42d3-a456-426614174000',
            p_instagram_id: 'girlfriend.name',
        });
    });

    it('persists only the capture token hash and principal HMAC for a journey capture', async () => {
        mocks.rpc.mockResolvedValue({
            data: [{
                journey_id: '123e4567-e89b-42d3-a456-426614174000',
                created: true,
            }],
            error: null,
        });

        const result = await insertLandingLead({
            instagramId: 'suzy',
            captureToken: 'v1.opaque.signature',
            anonymousPrincipalHash: 'a'.repeat(64),
            journeyId: '123e4567-e89b-42d3-a456-426614174000',
        });

        expect(result).toMatchObject({ status: 'stored', captureToken: 'v1.opaque.signature' });
        expect(mocks.rpc).toHaveBeenCalledWith('create_or_replay_landing_lead_capture', {
            p_journey_id: '123e4567-e89b-42d3-a456-426614174000',
            p_instagram_id: 'suzy',
            p_input_context: 'target',
            p_anonymous_principal_hash: 'a'.repeat(64),
            p_capture_token_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain('v1.opaque.signature');
    });

    it('throws LeadPersistenceError when supabase reports an error', async () => {
        mocks.insert.mockResolvedValue({ error: { message: 'boom' } });
        await expect(insertLandingLead({ instagramId: 'suzy' }))
            .rejects.toBeInstanceOf(LeadPersistenceError);
    });
});
