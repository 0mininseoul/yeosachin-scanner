import { describe, expect, it, vi } from 'vitest';
import { createBootstrapDemoFixturePayload } from './bootstrap-demo-editable-fixture';
import { publishDemoEditableFixture } from './publish-demo-editable-fixture';

function client(payload: unknown, error: unknown = null) {
    const maybeSingle = vi.fn().mockResolvedValue({ data: payload === null ? null : { version: 'operator-editable-fixture-v2', status: 'draft', payload }, error });
    const eqStatus = vi.fn().mockReturnValue({ maybeSingle });
    const eqVersion = vi.fn().mockReturnValue({ eq: eqStatus });
    const rpc = vi.fn().mockResolvedValue({ error: null });
    return { from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ eq: eqVersion }) }), rpc, maybeSingle };
}

describe('controlled demo fixture publisher', () => {
    it('does not promote a Zod-invalid draft', async () => {
        const invalid = createBootstrapDemoFixturePayload();
        invalid.summary.targetProfileImage = null;
        const db = client(invalid);
        await expect(publishDemoEditableFixture(db as never, 'operator-editable-fixture-v2')).rejects.toThrow(/invalid/i);
        expect(db.rpc).not.toHaveBeenCalled();
    });

    it('passes the exact validated payload to the atomic database publisher', async () => {
        const payload = createBootstrapDemoFixturePayload();
        const db = client(payload);
        await publishDemoEditableFixture(db as never, 'operator-editable-fixture-v2');
        expect(db.rpc).toHaveBeenCalledWith('publish_demo_analysis_fixture', {
            p_version: 'operator-editable-fixture-v2', p_expected_payload: payload,
        });
    });
});
