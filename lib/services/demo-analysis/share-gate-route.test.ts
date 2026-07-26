import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getUser: vi.fn(), createClient: vi.fn(), from: vi.fn(), demoFind: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock('@/lib/services/demo-analysis/store', () => ({ demoAnalysisStore: { findForOwner: mocks.demoFind } }));
import { POST } from '@/app/api/share/enable/route';

const userId = '123e4567-e89b-42d3-a456-426614174000';
const requestId = '223e4567-e89b-42d3-a456-426614174000';

describe('demo share server gate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createClient.mockResolvedValue({ auth: { getUser: mocks.getUser } });
        mocks.getUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
    });
    it('rejects an owner demo before production analysis queries or updates', async () => {
        vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
        vi.stubEnv('DEMO_ANALYSIS_OPERATOR_USER_IDS', userId);
        mocks.demoFind.mockResolvedValue({ id: requestId, user_id: userId });
        const response = await POST(new Request('https://example.com/api/share/enable', { method: 'POST', body: JSON.stringify({ requestId }) }));
        expect(response.status).toBe(409);
        expect(response.headers.get('x-analytics-eligible')).toBe('0');
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(mocks.from).not.toHaveBeenCalled();
        vi.unstubAllEnvs();
    });
});
