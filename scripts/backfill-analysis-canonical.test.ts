import { describe, expect, it, vi } from 'vitest';
import {
    ANALYSIS_CANONICAL_BACKFILL_APPLY_ACKNOWLEDGEMENT,
    ANALYSIS_CANONICAL_BACKFILL_FAMILIES,
    BACKFILL_MAX_LIMIT,
    backfillAnalysisCanonical,
    buildBackfillBatch,
    compareBackfillFamilyRows,
    compareNormalizedBackfillFamilyRows,
    encodeBackfillCursor,
    normalizeBackfillFamilyRows,
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
            in: vi.fn().mockReturnThis(),
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

        const executableSources = ANALYSIS_CANONICAL_BACKFILL_FAMILIES.flatMap(family => family.legacyTables);
        expect(executableSources).toHaveLength(21);
        expect(new Set(executableSources)).toHaveLength(21);
        expect(tables).toEqual(expect.arrayContaining(executableSources));
        expect(tables).toEqual(expect.arrayContaining(
            ANALYSIS_CANONICAL_BACKFILL_FAMILIES
                .filter(family => !family.deferred)
                .map(family => family.canonicalTable),
        ));
        expect(tables).not.toEqual(expect.arrayContaining([
            'ai_analysis_cache',
            'analysis_v2_ai_global_result_cache',
            'analysis_cache',
            'analysis_audit_bundles',
            'analysis_order_audit_assembly_queue',
            'analysis_order_audit_bundles',
            'analysis_order_audit_candidates',
            'analysis_order_audit_interactions',
        ]));
        expect(chain.limit).toHaveBeenCalled();
        expect(chain.limit.mock.calls.every(([value]) => value === 101)).toBe(true);
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
            in: vi.fn(),
            limit: vi.fn(),
        };
        emptyChain.select.mockReturnValue(emptyChain);
        emptyChain.order.mockReturnValue(emptyChain);
        emptyChain.in = vi.fn().mockReturnValue(emptyChain);
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
            status: 'blocked',
            scanned: 2,
            complete: 2,
            blocked: 2,
        });
        expect(report).not.toHaveProperty('requestIds');
        expect(JSON.stringify(report)).not.toContain(sourceRows[0]!.id);
        expect(Object.keys(report.families).sort()).toEqual([
            'artifacts', 'audit', 'cache', 'costs', 'events', 'jobs',
        ]);
        const deferredFamily = {
            source: { count: 0, checksum: null, complete: false },
            canonical: { count: 0, checksum: null, complete: false },
            parity: { status: 'blocked', mismatchPaths: ['source.missing'] },
            logical: {
                sourceCount: 0,
                canonicalCount: 0,
                sourceChecksum: null,
                canonicalChecksum: null,
            },
            requiredFields: [],
            targetEvidence: {
                sourceCount: 0,
                canonicalCount: 0,
                sourceChecksum: null,
                canonicalChecksum: null,
                sourceInteractionCount: 0,
                canonicalInteractionCount: 0,
                sourceInteractionChecksum: null,
                canonicalInteractionChecksum: null,
            },
        };
        expect(report.families.cache).toEqual(deferredFamily);
        expect(report.families.audit).toEqual(deferredFamily);
        expect(chain.order).toHaveBeenNthCalledWith(1, 'created_at', { ascending: true });
        expect(chain.order).toHaveBeenNthCalledWith(2, 'id', { ascending: true });
        expect(chain.limit).toHaveBeenCalledWith(101);
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

        expect(first).toMatchObject({ status: 'blocked', scanned: 100, complete: 100 });
        expect(second).toMatchObject({ status: 'blocked', scanned: 100, complete: 100 });
        expect(second.nextCursor).not.toBe(first.nextCursor);
        expect(boundaryCalls).toHaveLength(1);
        expect(boundaryCalls[0]).toContain('created_at.gt.');
        expect(boundaryCalls[0]).toContain('id.gt.');
    });

    it('advances a legacy family page with its own bounded keyset boundary', async () => {
        const jobs = Array.from({ length: 101 }, (_, index) => ({
            request_id: sourceRows[0]!.id,
            job_key: `job:${String(index).padStart(3, '0')}`,
            kind: 'collection',
            status: 'completed',
            dispatch_generation: 0,
            attempt_count: 1,
            created_at: `2026-09-01T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
            updated_at: `2026-09-01T01:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
        }));
        const eventSource = {
            id: 'event:1',
            request_id: sourceRows[0]!.id,
            revision: 1,
            status: 'source',
            created_at: '2026-09-01T00:00:00.000Z',
            updated_at: '2026-09-01T00:00:00.000Z',
        };
        const eventCanonical = {
            id: 'event:1',
            request_id: sourceRows[0]!.id,
            kind: 'progress',
            state: 'canonical',
            created_at: '2026-09-01T00:00:00.000Z',
        };
        let jobsRead = 0;
        const boundaries: string[] = [];
        const client = {
            from: vi.fn((table: string) => {
                const data = table === 'analysis_requests'
                    ? sourceRows
                    : table === 'analysis_pipeline_jobs' && jobsRead++ === 0
                        ? jobs
                        : table === 'analysis_progress_state'
                            ? [eventSource]
                            : table === 'analysis_events'
                                ? [eventCanonical]
                                : [];
                const chain = {
                    select: vi.fn().mockReturnThis(),
                    in: vi.fn().mockReturnThis(),
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
        const second = await backfillAnalysisCanonical({
            client,
            limit: 100,
            cursor: first.nextCursor,
            reportOnly: true,
        });

        expect(first.nextCursor).toBeTruthy();
        expect(first.families.jobs.parity).toEqual({
            status: 'blocked',
            mismatchPaths: ['source.missing'],
        });
        expect(second.families.jobs.parity).toEqual({
            status: 'blocked',
            mismatchPaths: ['source.missing'],
        });
        expect(first.families.events.parity).toEqual({
            status: 'mismatch',
            mismatchPaths: ['logical.row.fields'],
        });
        expect(second.families.events.parity).toEqual({
            status: 'mismatch',
            mismatchPaths: ['logical.row.fields'],
        });
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

    it('rejects a cursor position outside the bounded family allowlist', async () => {
        const cursor = Buffer.from(JSON.stringify({
            version: 2,
            positions: {
                'untrusted_table:created_at:id': {
                    createdAt: '2026-09-01T00:00:00.000Z',
                    key: 'row:1',
                    rowHash: 'a'.repeat(64),
                },
            },
            requestIds: [],
            sourceHasMore: false,
            completed: [],
        }), 'utf8').toString('base64url');
        const from = vi.fn();
        await expect(backfillAnalysisCanonical({
            client: { from },
            limit: 100,
            cursor,
            reportOnly: true,
        })).resolves.toMatchObject({ status: 'blocked', blocked: 1, complete: 0 });
        expect(from).not.toHaveBeenCalled();
    });

    it('keeps report-only as the default and guards apply CLI options', () => {
        for (const option of ['--drop', '--truncate', '--delete', '--mutate']) {
            expect(() => parseBackfillCliArgs([option])).toThrow('destructive');
        }
        expect(() => parseBackfillCliArgs(['--apply'])).toThrow('acknowledgement');
        expect(parseBackfillCliArgs([
            '--apply',
            `--acknowledge=${ANALYSIS_CANONICAL_BACKFILL_APPLY_ACKNOWLEDGEMENT}`,
        ])).toEqual({
            limit: BACKFILL_MAX_LIMIT,
            reportOnly: false,
            apply: true,
            acknowledgement: ANALYSIS_CANONICAL_BACKFILL_APPLY_ACKNOWLEDGEMENT,
        });
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

    it('constrains every family query to the selected request ids and includes live target manifests', async () => {
        const selected = sourceRows;
        const calls: Array<{ table: string; column: string; values: string[] }> = [];
        const client = {
            from: vi.fn((table: string) => {
                const chain = {
                    select: vi.fn().mockReturnThis(),
                    in: vi.fn((column: string, values: string[]) => {
                        calls.push({ table, column, values });
                        return chain;
                    }),
                    order: vi.fn().mockReturnThis(),
                    limit: vi.fn().mockResolvedValue({
                        data: table === 'analysis_requests' ? selected : [],
                        error: null,
                    }),
                };
                return chain;
            }),
        };

        await backfillAnalysisCanonical({ client, limit: 100, reportOnly: true });

        expect(calls.length).toBeGreaterThan(0);
        expect(calls.every(call => call.column === 'request_id')).toBe(true);
        expect(calls.every(call => (
            call.values.length === selected.length
            && call.values.every(id => selected.some(row => row.id === id))
        ))).toBe(true);
        const artifact = ANALYSIS_CANONICAL_BACKFILL_FAMILIES.find(family => family.family === 'artifacts');
        expect(artifact?.legacyTables).toContain('analysis_v2_target_evidence_manifests');
        expect(artifact?.legacy.some(table => table.columns.includes('result_hash'))).toBe(true);
    });

    it('fails closed for ambiguous page limits and duplicate composite cursor ties', async () => {
        const limit = 2;
        const tied = [
            { id: sourceRows[0]!.id, created_at: '2026-09-01T00:00:00.000Z', status: 'completed' },
            { id: sourceRows[1]!.id, created_at: '2026-09-01T00:00:00.000Z', status: 'completed' },
            { id: '123e4567-e89b-42d3-a456-426614174002', created_at: '2026-09-01T00:00:00.000Z', status: 'completed' },
        ];
        const client = {
            from: vi.fn(() => ({
                select: vi.fn().mockReturnThis(),
                order: vi.fn().mockReturnThis(),
                limit: vi.fn().mockResolvedValue({ data: tied, error: null }),
            })),
        };
        const report = await backfillAnalysisCanonical({ client, limit, reportOnly: true });
        expect(report.status).toBe('blocked');
        expect(report.nextCursor).toBeTruthy();
    });

    it('normalizes live target manifests and interactions into bidirectional logical evidence', () => {
        const request = sourceRows[0]!.id;
        const manifest = {
            request_id: request,
            job_key: 'track:target-evidence:collect',
            input_hash: 'a'.repeat(64),
            liker_source_hash: 'b'.repeat(64),
            comment_source_hash: 'c'.repeat(64),
            result_hash: 'd'.repeat(64),
            interactor_count: 1,
            liker_count: 1,
            comment_count: 0,
            created_at: '2026-09-01T00:00:00.000Z',
        };
        const interaction = {
            request_id: request,
            job_key: 'track:target-evidence:collect',
            ordinal: 1,
            signal: 'target_post_like',
            source_interaction_id: 'like:1',
            occurred_at: '2026-09-01T00:00:01.000Z',
            created_at: '2026-09-01T00:00:01.000Z',
        };
        const normalized = normalizeBackfillFamilyRows(
            'artifacts',
            [manifest, interaction],
            [request],
        );
        expect(normalized).toHaveLength(2);
        expect(normalized.find(row => row.evidence.targetManifest)?.evidence.targetManifest).toBe(true);
        expect(normalized.find(row => row.evidence.targetInteractions.length > 0)?.evidence.targetInteractions).toEqual([{
            key: 'like:1',
            signal: 'target_post_like',
            occurredAt: '2026-09-01T00:00:01.000Z',
            evidenceId: 'like:1',
        }]);
        expect(compareNormalizedBackfillFamilyRows(
            'artifacts',
            [manifest, interaction],
            [manifest, interaction],
            [request],
        )).toEqual({ status: 'match', mismatchPaths: [] });
    });
});
