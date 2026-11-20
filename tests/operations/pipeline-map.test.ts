import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { buildPipelineMap } = await import('@/lib/services/admin/pipeline-map');

describe('operator console pipeline map', () => {
    const map = buildPipelineMap({});

    it('points only at code that exists', () => {
        const missing = map.nodes.flatMap(node => node.code)
            .filter(path => !existsSync(resolve(process.cwd(), path)));
        expect(missing).toEqual([]);
    });

    it('keeps every edge on known nodes and every node on the path from input to result', () => {
        const ids = new Set(map.nodes.map(node => node.id));
        expect(ids.size).toBe(map.nodes.length);
        for (const edge of map.edges) {
            expect(ids.has(edge.from), edge.from).toBe(true);
            expect(ids.has(edge.to), edge.to).toBe(true);
        }
        const reached = new Set(['input']);
        let grew = true;
        while (grew) {
            grew = false;
            for (const edge of map.edges) {
                if (reached.has(edge.from) && !reached.has(edge.to)) { reached.add(edge.to); grew = true; }
            }
        }
        expect([...ids].filter(id => !reached.has(id))).toEqual([]);
    });

    it('places each node in its own cell inside its band', () => {
        const rows = new Map(map.bands.map(band => [band.id, band.rows]));
        const cells = new Set<string>();
        for (const node of [...map.nodes, ...map.notes.map(note => ({ ...note, id: note.text }))]) {
            expect(node.col >= 0 && node.col < 4, node.id).toBe(true);
            expect(node.row >= 0 && node.row < (rows.get(node.band) ?? 0), node.id).toBe(true);
            const key = `${node.band}:${node.col}:${node.row}`;
            expect(cells.has(key), key).toBe(false);
            cells.add(key);
        }
    });

    it('draws every worker DAG stage', () => {
        const stages = map.nodes.filter(node => node.workerStage).map(node => node.workerStage);
        expect(stages).toHaveLength(map.workerStageCount);
        expect(new Set(stages).size).toBe(stages.length);
        expect(stages).toContain('finalize');
    });
});
