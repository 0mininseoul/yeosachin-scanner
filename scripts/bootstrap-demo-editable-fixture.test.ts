import { describe, expect, it, vi } from 'vitest';
import { bootstrapDemoEditableFixture, createBootstrapDemoFixturePayload } from './bootstrap-demo-editable-fixture';

describe('operator editable demo fixture bootstrap', () => {
    it('builds the redacted v4 payload with the complete dashboard-editable shape', () => {
        const payload = createBootstrapDemoFixturePayload();
        expect(payload).toMatchObject({ target: { username: 'junho_dem' }, summary: { publicMutuals: 84, privateMutuals: 145 } });
        expect(payload.public).toHaveLength(84);
        expect(payload.private).toHaveLength(145);
        expect(payload.public.every(row => row.profileImage?.startsWith('/demo-avatars/'))).toBe(true);
    });

    it('refuses to overwrite an existing operator fixture row', async () => {
        const insert = vi.fn();
        const maybeSingle = vi.fn().mockResolvedValue({ data: { version: 'operator-editable-fixture-v1' }, error: null });
        const client = { from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle }) }), insert }) };
        await expect(bootstrapDemoEditableFixture(client as never)).rejects.toThrow(/already exists/i);
        expect(insert).not.toHaveBeenCalled();
    });
});
