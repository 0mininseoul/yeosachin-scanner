import { describe, expect, it } from 'vitest';
import { shareObservationEvent, ShareObservationError } from './share-observation';

const base = { requestId: '123e4567-e89b-42d3-a456-426614174000', clientNonce: 'nonce-for-share-1234' };
describe('share observation semantics', () => {
    it('distinguishes copy, OS handoff, and Kakao confirmation', () => {
        expect(shareObservationEvent({ ...base, channel: 'clipboard', outcome: 'succeeded' }).event).toBe('result_share_copy_succeeded');
        expect(shareObservationEvent({ ...base, channel: 'web_share', outcome: 'succeeded' }).event).toBe('result_share_handoff_completed');
        expect(shareObservationEvent({ ...base, channel: 'kakao', outcome: 'confirmed' }).event).toBe('result_shared_confirmed');
    });
    it('never upgrades a non-Kakao result to confirmed', () => {
        expect(() => shareObservationEvent({ ...base, channel: 'clipboard', outcome: 'confirmed' })).toThrowError(new ShareObservationError('SEMANTIC_MISMATCH'));
    });
});
