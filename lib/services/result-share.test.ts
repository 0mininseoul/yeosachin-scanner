import { describe, expect, it, vi } from 'vitest';
import { shareResult } from './result-share';

const shareData = {
    title: 'Result',
    text: 'Result text',
    url: 'https://app.example/share/token',
};

describe('result sharing', () => {
    it('reports web_share only after native share resolves', async () => {
        const share = vi.fn().mockResolvedValue(undefined);
        const writeText = vi.fn();

        await expect(shareResult({ share, writeText }, shareData)).resolves.toBe('web_share');
        expect(share).toHaveBeenCalledWith(shareData);
        expect(writeText).not.toHaveBeenCalled();
    });

    it('reports clipboard only after a confirmed fallback write', async () => {
        const share = vi.fn().mockRejectedValue(new Error('cancelled'));
        const writeText = vi.fn().mockResolvedValue(undefined);

        await expect(shareResult({ share, writeText }, shareData)).resolves.toBe('clipboard');
        expect(writeText).toHaveBeenCalledWith(shareData.url);
    });

    it('returns null when native share and clipboard both fail', async () => {
        const share = vi.fn().mockRejectedValue(new Error('cancelled'));
        const writeText = vi.fn().mockRejectedValue(new Error('denied'));

        await expect(shareResult({ share, writeText }, shareData)).resolves.toBeNull();
    });

    it('returns null when no sharing capability exists', async () => {
        await expect(shareResult({}, shareData)).resolves.toBeNull();
    });
});
