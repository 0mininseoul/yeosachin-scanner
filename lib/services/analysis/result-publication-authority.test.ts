import { describe, expect, it, vi } from 'vitest';
import { isAnalysisResultAuthoritativelyPublished } from './result-publication-authority';

describe('result publication authority boundary', () => {
    it('returns the database publication decision without accepting truthy non-boolean data', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: true, error: null });

        await expect(isAnalysisResultAuthoritativelyPublished(
            '123e4567-e89b-42d3-a456-426614174000',
            { rpc },
        )).resolves.toBe(true);
        expect(rpc).toHaveBeenCalledWith(
            'analysis_result_publication_authorized',
            { p_request_id: '123e4567-e89b-42d3-a456-426614174000' },
        );
    });

    it('fails closed to pending when the authority RPC errors', async () => {
        const rpc = vi.fn().mockResolvedValue({
            data: null,
            error: { code: 'PGRST000', message: 'unavailable' },
        });

        await expect(isAnalysisResultAuthoritativelyPublished(
            '123e4567-e89b-42d3-a456-426614174000',
            { rpc },
        )).resolves.toBe(false);
    });
});
