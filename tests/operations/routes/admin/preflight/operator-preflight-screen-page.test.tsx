/** @vitest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getUser: vi.fn(),
    decision: vi.fn(),
    maybeSingle: vi.fn(),
    stored: vi.fn(),
    dto: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: mocks.getUser } }) }));
vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { from: (table: string) => ({ select: () => ({ eq: () => ({ maybeSingle: () => mocks.maybeSingle(table) }) }) }) },
}));
vi.mock('@/lib/services/analysis/score-audit', () => ({ getAnalysisAuditOperatorDecision: mocks.decision }));
vi.mock('@/lib/services/analysis/preflight', () => ({
    storedPreflightFromRow: mocks.stored,
    publicPreflightStatusDto: mocks.dto,
}));
vi.mock('../../../../../app/admin0min/preflight/[preflightId]/preflight-screen', () => ({
    PreflightScreen: ({ preflight }: { preflight: { target: { username: string } } }) => <p>screen:{preflight.target.username}</p>,
}));

import Page from '../../../../../app/admin0min/preflight/[preflightId]/page';

const id = '50000000-0000-4000-8000-000000000001';
const render = async (preflightId = id) => renderToStaticMarkup(await Page({ params: Promise.resolve({ preflightId }) }));

describe('operator preflight screen page', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getUser.mockResolvedValue({ data: { user: { id: '10000000-0000-4000-8000-000000000001' } }, error: null });
        mocks.decision.mockReturnValue('authorized');
    });

    it('refuses anyone who is not an operator without touching the database', async () => {
        mocks.decision.mockReturnValue('forbidden');
        expect(await render()).toContain('접근할 수 없습니다');
        expect(mocks.maybeSingle).not.toHaveBeenCalled();
    });

    it('rejects a malformed id and explains a purged preflight with no archive', async () => {
        expect(await render('nope')).toContain('잘못된 preflight ID');
        mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
        expect(await render()).toContain('운영자 보관본도 없습니다');
    });

    it('does not rebuild the screen from a scrubbed live row', async () => {
        mocks.maybeSingle.mockImplementation(async (table: string) => (table === 'analysis_preflights'
            ? { data: { pii_scrubbed_at: '2026-11-19T00:00:00Z', ready_at: '2026-11-18T00:00:00Z' }, error: null }
            : { data: null, error: null }));
        expect(await render()).toContain('운영자 보관본이 만들어지기 전');
        expect(mocks.dto).not.toHaveBeenCalled();
    });

    it('replays the operator archive after the user-facing preflight is gone', async () => {
        mocks.maybeSingle.mockImplementation(async (table: string) => (table === 'analysis_preflights'
            ? { data: null, error: null }
            : { data: { preflight_id: id, captured_at: '2026-11-18T00:00:00Z', target_instagram_id: 'target.two' }, error: null }));
        mocks.stored.mockReturnValue({ readySnapshot: {}, status: 'ready', expiresAt: '2026-11-01T00:00:00Z' });
        mocks.dto.mockReturnValue({ status: 'ready', target: { username: 'target.two' } });
        const html = await render();
        expect(html).toContain('screen:target.two');
        expect(html).toContain('운영자 보관본');
        expect(mocks.stored).toHaveBeenCalledWith(expect.objectContaining({ id, status: 'ready', error_code: null }));
    });

    it('replays the ready screen even after the preflight was consumed', async () => {
        mocks.maybeSingle.mockImplementation(async (table: string) => (table === 'analysis_preflights'
            ? { data: { pii_scrubbed_at: null }, error: null }
            : { data: null, error: null }));
        mocks.stored.mockReturnValue({ readySnapshot: {}, status: 'consumed', expiresAt: '2026-11-01T00:00:00Z' });
        mocks.dto.mockReturnValue({ status: 'ready', target: { username: 'target.one' } });
        const html = await render();
        expect(html).toContain('screen:target.one');
        expect(mocks.dto).toHaveBeenCalledWith(expect.objectContaining({ status: 'ready', expiresAt: '2999-01-01T00:00:00.000Z' }));
    });
});
