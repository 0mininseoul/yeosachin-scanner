import { describe, expect, it, vi } from 'vitest';
import {
    BACKFILL_MAX_LIMIT,
    backfillAnalysisCanonical,
    buildBackfillBatch,
    parseBackfillCliArgs,
    type AnalysisBackfillSourceRow,
} from './backfill-analysis-canonical';

const sourceRows: AnalysisBackfillSourceRow[] = [
    {
        id: '123e4567-e89b-42d3-a456-426614174000',
        created_at: '2026-09-01T00:00:00.000Z',
        status: 'completed',
    },
    {
        id: '123e4567-e89b-42d3-a456-174000000001',
        created_at: '2026-09-01T00:00:01.000Z',
        status: 'processing',
    },
];

describe('bounded analysis canonical backfill tooling', () => {
    it('orders source rows and never builds a batch larger than 100', () => {
        const rows = Array.from({ length: BACKFILL_MAX_LIMIT + 20 }, (_, index) => ({
            id: `123e4567-e89b-42d3-a456-42661417${String(index).padStart(4, '0')}`,
            created_at: `2026-09-01T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
            status: 'completed',
        }));
        const batch = buildBackfillBatch(rows, BACKFILL_MAX_LIMIT);
        expect(batch.rows).toHaveLength(BACKFILL_MAX_LIMIT);
        expect(batch.rows[0]?.created_at).toBe(rows[0]?.created_at);
        expect(batch.rows.at(-1)?.created_at).toBe(rows[BACKFILL_MAX_LIMIT - 1]?.created_at);
        expect(batch.checksum).toMatch(/^[a-f0-9]{64}$/);
    });

    it('rejects a limit above the hard bound', () => {
        expect(() => buildBackfillBatch(sourceRows, BACKFILL_MAX_LIMIT + 1))
            .toThrow('hard maximum');
    });

    it('returns aggregate report data without request identifiers', async () => {
        const chain = {
            select: vi.fn(),
            order: vi.fn(),
            limit: vi.fn(),
        };
        chain.select.mockReturnValue(chain);
        chain.order.mockReturnValue(chain);
        chain.limit.mockResolvedValue({ data: sourceRows, error: null });
        const client = { from: vi.fn(() => chain) };

        const report = await backfillAnalysisCanonical({
            client,
            limit: 100,
            reportOnly: true,
        });

        expect(report).toMatchObject({
            status: 'report_only',
            scanned: 2,
            complete: 2,
            blocked: 0,
        });
        expect(report).not.toHaveProperty('requestIds');
        expect(JSON.stringify(report)).not.toContain(sourceRows[0]!.id);
        expect(chain.order).toHaveBeenNthCalledWith(1, 'created_at', { ascending: true });
        expect(chain.order).toHaveBeenNthCalledWith(2, 'id', { ascending: true });
        expect(chain.limit).toHaveBeenCalledWith(100);
    });

    it('fails closed when the source query is unavailable', async () => {
        const client = {
            from: vi.fn(() => ({
                select: vi.fn().mockReturnThis(),
                order: vi.fn().mockReturnThis(),
                limit: vi.fn().mockResolvedValue({ data: null, error: { message: 'unavailable' } }),
            })),
        };
        await expect(backfillAnalysisCanonical({ client, limit: 100, reportOnly: true }))
            .resolves.toMatchObject({ status: 'blocked', blocked: 1, scanned: 0 });
    });

    it('rejects destructive and apply CLI options', () => {
        for (const option of ['--apply', '--drop', '--truncate', '--delete', '--mutate']) {
            expect(() => parseBackfillCliArgs([option])).toThrow('report-only');
        }
        expect(parseBackfillCliArgs(['--limit=100', '--report-only'])).toEqual({
            limit: 100,
            reportOnly: true,
        });
    });
});
