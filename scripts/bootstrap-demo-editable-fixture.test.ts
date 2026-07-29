import { describe, expect, it, vi } from 'vitest';
import { bootstrapDemoEditableFixture, createBootstrapDemoFixturePayload } from './bootstrap-demo-editable-fixture';

describe('operator editable demo fixture bootstrap', () => {
    it('builds the synthetic v2 payload with the complete dashboard-editable shape', () => {
        const payload = createBootstrapDemoFixturePayload();
        expect(payload).toMatchObject({
            target: { username: 'junho_dem', fullName: '김도윤', bio: null },
            summary: { detectedMutuals: 313, publicMutuals: 168, privateMutuals: 145, screenedMutuals: 168 },
        });
        expect(payload.public).toHaveLength(84);
        expect(payload.private).toHaveLength(145);
        expect(payload.public.every(row => row.profileImage?.startsWith('/demo-avatars/'))).toBe(true);
    });

    it('refuses to overwrite an existing operator fixture row', async () => {
        const rpc = vi.fn();
        const maybeSingle = vi.fn().mockResolvedValue({ data: { version: 'operator-editable-fixture-v1' }, error: null });
        const client = { from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle }) }) }), rpc };
        await expect(bootstrapDemoEditableFixture(client as never)).rejects.toThrow(/already exists/i);
        expect(rpc).not.toHaveBeenCalled();
    });
});
