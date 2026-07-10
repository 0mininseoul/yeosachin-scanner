import { describe, expect, it, vi } from 'vitest';
import { readBoundedDatabasePages } from './paginated-query';

describe('readBoundedDatabasePages', () => {
    it('reads more than the Data API default 1,000 rows without truncation', async () => {
        const source = Array.from({ length: 1_990 }, (_, id) => ({ id }));
        const fetchPage = vi.fn(async (from: number, to: number) => ({
            data: source.slice(from, to + 1),
            error: null,
        }));

        const result = await readBoundedDatabasePages(fetchPage, {
            pageSize: 500,
            maximumRows: 2_500,
        });

        expect(result).toEqual(source);
        expect(fetchPage).toHaveBeenCalledTimes(4);
        expect(fetchPage).toHaveBeenLastCalledWith(1_500, 1_999);
    });

    it('fails closed instead of silently truncating at the configured row cap', async () => {
        const fetchPage = vi.fn(async (from: number, to: number) => ({
            data: Array.from({ length: to - from + 1 }, (_, index) => from + index),
            error: null,
        }));

        await expect(readBoundedDatabasePages(fetchPage, {
            pageSize: 500,
            maximumRows: 2_500,
        })).rejects.toThrow('exceeded its row cap');
    });

    it('propagates a page failure as a persistence error', async () => {
        await expect(readBoundedDatabasePages(async () => ({
            data: null,
            error: new Error('transport'),
        }), {
            maximumRows: 2_500,
        })).rejects.toThrow('paginated database read failed');
    });
});
