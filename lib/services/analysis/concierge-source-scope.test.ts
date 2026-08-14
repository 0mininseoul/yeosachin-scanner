import { describe, expect, it } from 'vitest';
import { selectConciergeSourceRequest } from './concierge-source-scope';

const scope = {
    sourceRequestId: 'source-request',
    userId: 'owner',
    targetInstagramId: 'target',
};

describe('concierge source request scope', () => {
    it('uses the exact order lineage source instead of an unrelated failed request', () => {
        expect(selectConciergeSourceRequest([
            {
                id: 'unrelated-request', user_id: 'owner', target_instagram_id: 'target',
                status: 'failed', pipeline_version: 'v2',
            },
            {
                id: 'source-request', user_id: 'owner', target_instagram_id: 'target',
                status: 'failed', pipeline_version: 'v2',
            },
        ], scope).id).toBe('source-request');
    });

    it('fails closed when the lineage source is not the same user and target', () => {
        expect(() => selectConciergeSourceRequest([
            {
                id: 'source-request', user_id: 'other-owner', target_instagram_id: 'target',
                status: 'failed', pipeline_version: 'v2',
            },
        ], scope)).toThrow('CONCIERGE_SAMPLE_REQUEST_SCOPE_CONFLICT');
    });

    it('accepts the finalization placeholder from a scrubbed V2 source request', () => {
        expect(selectConciergeSourceRequest([{
            id: 'source-request', user_id: 'owner', target_instagram_id: 'retained.1234567890abcdef1234',
            status: 'failed', pipeline_version: 'v2',
        }], scope).id).toBe('source-request');
    });
});
