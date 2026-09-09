import { describe, expect, it, vi } from 'vitest';
import {
    ANALYSIS_CANONICAL_BACKFILL_FAMILIES,
    BACKFILL_MAX_LIMIT,
    backfillAnalysisCanonical,
    buildBackfillBatch,
    compareBackfillFamilyRows,
    encodeBackfillCursor,
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
    it('compares rows in both directions instead of treating matching counts as parity', () => {
        expect(compareBackfillFamilyRows(
            [{ key: 'candidate:1', score: 8.2 }],
            [{ key: 'candidate:1', score: 8.2 }],
        )).toEqual({ status: 'match', mismatchPaths: [] });
        expect(compareBackfillFamilyRows(
            [{ key: 'candidate:1', score: 8.2 }],
            [{ key: 'candidate:1', score: 8.3 }],
        )).toEqual({ status: 'mismatch', mismatchPaths: ['row.fields'] });
        expect(compareBackfillFamilyRows(
            [{ key: 'candidate:1', score: 8.2 }],
            [],
        )).toEqual({ status: 'mismatch', mismatchPaths: ['row.count'] });
        expect(compareBackfillFamilyRows(
            [],
            [{ key: 'candidate:1', score: 8.2 }],
        )).toEqual({ status: 'mismatch', mismatchPaths: ['row.count'] });
    });

    it('reads every legacy source and canonical family through bounded keyset pages', async () => {
        const tables: string[] = [];
        const chain = {
            select: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({ data: [], error: null }),
        };
        const client = {
            from: vi.fn((table: string) => {
                tables.push(table);
                return chain;
            }),
        };

        await backfillAnalysisCanonical({ client, limit: 100, reportOnly: true });

        for (const family of ANALYSIS_CANONICAL_BACKFILL_FAMILIES) {
            expect(tables).toContain(family.canonicalTable);
            expect(tables).toEqual(expect.arrayContaining([...family.legacyTables]));
        }
        expect(chain.limit).toHaveBeenCalled();
        expect(chain.limit.mock.calls.every(([value]) => value === 100)).toBe(true);
    });

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
        const emptyChain = {
            select: vi.fn(),
            order: vi.fn(),
            limit: vi.fn(),
        };
        emptyChain.select.mockReturnValue(emptyChain);
        emptyChain.order.mockReturnValue(emptyChain);
        emptyChain.limit.mockResolvedValue({ data: [], error: null });
        const client = {
            from: vi.fn((table: string) => table === 'analysis_requests' ? chain : emptyChain),
        };

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

    it('advances across multiple bounded pages at the deterministic source keyset boundary', async () => {
        const rows: AnalysisBackfillSourceRow[] = Array.from({ length: 205 }, (_, index) => ({
            id: `123e4567-e89b-42d3-a456-42661417${String(index).padStart(4, '0')}`,
            created_at: `2026-09-01T${String(Math.floor(index / 3600)).padStart(2, '0')}:${String(Math.floor(index / 60) % 60).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
            status: 'completed',
        }));
        const boundaryCalls: string[] = [];
        let cursorBoundary: AnalysisBackfillSourceRow | null = null;
        const client = {
            from: vi.fn((table: string) => {
                if (table !== 'analysis_requests') {
                    return {
                        select: vi.fn().mockReturnThis(),
                        order: vi.fn().mockReturnThis(),
                        limit: vi.fn().mockResolvedValue({ data: [], error: null }),
                    };
                }
                let exactId: string | null = null;
                let exactCreatedAt: string | null = null;
                const chain = {
                    select: vi.fn().mockReturnThis(),
                    eq: vi.fn((column: string, value: string) => {
                        if (column === 'id') exactId = value;
                        if (column === 'created_at') exactCreatedAt = value;
                        return chain;
                    }),
                    or: vi.fn((expression: string) => {
                        boundaryCalls.push(expression);
                        const match = expression.match(/created_at\.eq\.([^,]+),id\.gt\.([^\)]+)/);
                        if (match) {
                            cursorBoundary = rows.find(row => (
                                row.created_at === match[1]
                                && row.id === match[2]
                            )) ?? null;
                        }
                        return chain;
                    }),
                    order: vi.fn().mockReturnThis(),
                    limit: vi.fn(async (limit: number) => {
                        if (exactId && exactCreatedAt) {
                            return {
                                data: rows.filter(row => (
                                    row.id === exactId && row.created_at === exactCreatedAt
                                )),
                                error: null,
                            };
                        }
                        if (cursorBoundary) {
                            const cursorIndex = rows.findIndex(row => row.id === cursorBoundary!.id);
                            return { data: rows.slice(cursorIndex + 1, cursorIndex + 1 + limit), error: null };
                        }
                        return { data: rows.slice(0, limit), error: null };
                    }),
                };
                return chain;
            }),
        };

        const first = await backfillAnalysisCanonical({ client, limit: 100, reportOnly: true });
        const second = await backfillAnalysisCanonical({
            client,
            limit: 100,
            cursor: first.nextCursor,
            reportOnly: true,
        });

        expect(first).toMatchObject({ status: 'report_only', scanned: 100, complete: 100 });
        expect(second).toMatchObject({ status: 'report_only', scanned: 100, complete: 100 });
        expect(second.nextCursor).not.toBe(first.nextCursor);
        expect(boundaryCalls).toHaveLength(1);
        expect(boundaryCalls[0]).toContain('created_at.gt.');
        expect(boundaryCalls[0]).toContain('id.gt.');
    });

    it('advances a legacy family page with its own bounded keyset boundary', async () => {
        const jobs = Array.from({ length: 100 }, (_, index) => ({
            request_id: sourceRows[0]!.id,
            job_key: `job:${String(index).padStart(3, '0')}`,
            kind: 'collection',
            status: 'completed',
            dispatch_generation: 0,
            attempt_count: 1,
            created_at: `2026-09-01T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
            updated_at: `2026-09-01T01:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
        }));
        let jobsRead = 0;
        const boundaries: string[] = [];
        const client = {
            from: vi.fn((table: string) => {
                const data = table === 'analysis_pipeline_jobs' && jobsRead++ === 0 ? jobs : [];
                const chain = {
                    select: vi.fn().mockReturnThis(),
                    or: vi.fn((expression: string) => {
                        if (table === 'analysis_pipeline_jobs') boundaries.push(expression);
                        return chain;
                    }),
                    order: vi.fn().mockReturnThis(),
                    limit: vi.fn().mockResolvedValue({ data, error: null }),
                };
                return chain;
            }),
        };

        const first = await backfillAnalysisCanonical({ client, limit: 100, reportOnly: true });
        await backfillAnalysisCanonical({
            client,
            limit: 100,
            cursor: first.nextCursor,
            reportOnly: true,
        });

        expect(first.nextCursor).toBeTruthy();
        expect(boundaries).toHaveLength(1);
        expect(boundaries[0]).toContain('created_at.gt.');
        expect(boundaries[0]).toContain('job_key.gt.');
    });

    it('rejects an unknown cursor before querying the source boundary', async () => {
        const from = vi.fn();
        await expect(backfillAnalysisCanonical({
            client: { from },
            limit: 100,
            cursor: 'unknown-cursor',
            reportOnly: true,
        })).resolves.toMatchObject({
            status: 'blocked',
            blocked: 1,
            complete: 0,
        });
        expect(from).not.toHaveBeenCalled();

        expect(() => encodeBackfillCursor({
            id: sourceRows[0]!.id,
            created_at: sourceRows[0]!.created_at,
            status: sourceRows[0]!.status,
        })).not.toThrow();
        expect(() => encodeBackfillCursor({
            id: sourceRows[0]!.id,
            created_at: '2026-09-01T00:00:00.000Z,or(id.eq.injected)',
            status: sourceRows[0]!.status,
        })).toThrow('cursor row is invalid');

        await expect(backfillAnalysisCanonical({
            client: { from },
            limit: 100,
            cursor: '',
            reportOnly: true,
        })).resolves.toMatchObject({
            status: 'blocked',
            blocked: 1,
        });
        expect(from).not.toHaveBeenCalled();
    });

    it('rejects destructive and apply CLI options', () => {
        for (const option of ['--apply', '--drop', '--truncate', '--delete', '--mutate']) {
            expect(() => parseBackfillCliArgs([option])).toThrow('report-only');
        }
        expect(parseBackfillCliArgs(['--limit=100', '--report-only'])).toEqual({
            limit: 100,
            reportOnly: true,
        });
        const cursor = encodeBackfillCursor(sourceRows[0]!);
        expect(parseBackfillCliArgs(['--limit=100', '--report-only', `--cursor=${cursor}`]))
            .toEqual({ limit: 100, reportOnly: true, cursor });
        expect(() => parseBackfillCliArgs(['--report-only', '--cursor=unknown']))
            .toThrow('cursor is unknown');
    });
});
