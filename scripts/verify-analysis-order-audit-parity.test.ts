import { describe, expect, it, vi } from 'vitest';
import {
    parseOrderAuditParityCliArgs,
    runOrderAuditParityCli,
    type OrderAuditParityCliDependencies,
} from './verify-analysis-order-audit-parity';
import type { OrderAuditParitySnapshot } from '../lib/services/analysis/order-audit-consolidation';

const REQUEST_A = '423e4567-e89b-42d3-a456-426614174001';
const REQUEST_B = '423e4567-e89b-42d3-a456-426614174002';
const HASH = 'a'.repeat(64);

function snapshot(completed: boolean): OrderAuditParitySnapshot {
    const section = {
        sourceCount: completed ? 1 : null,
        bundleCount: completed ? 1 : null,
        sourceChecksum: completed ? HASH : null,
        bundleChecksum: completed ? HASH : null,
        sourceComplete: completed ? true : null,
        bundleComplete: completed ? true : null,
    };
    return {
        request: {
            completed,
            productionOrder: completed,
            sourceDataPresent: completed,
        },
        bundle: {
            present: completed,
            completeness: completed ? 'complete' : null,
            costStatus: completed ? 'complete' : null,
            version: completed ? 1 : null,
        },
        recovery: {
            present: completed,
            completed,
        },
        sections: {
            relationships: section,
            targetEvidence: section,
            candidates: section,
            risk: section,
            costLedger: section,
        },
    };
}

describe('order-audit parity report CLI', () => {
    it('accepts bounded repeated request IDs and optional shadow-read/archive markers', () => {
        expect(parseOrderAuditParityCliArgs([`--request-id=${REQUEST_A}`])).toMatchObject({
            shadowRead: false,
            includeArchiveManifest: false,
        });
        expect(parseOrderAuditParityCliArgs([
            `--request-id=${REQUEST_A}`,
            '--request-id', REQUEST_B,
            '--shadow-read',
            '--archive-manifest',
        ])).toEqual({
            requestIds: [REQUEST_A, REQUEST_B],
            shadowRead: true,
            includeArchiveManifest: true,
        });
        expect(() => parseOrderAuditParityCliArgs(['--execute', REQUEST_A]))
            .toThrow('destructive mode is not supported');
        expect(() => parseOrderAuditParityCliArgs([])).toThrow('request-id');
    });

    it('prints aggregate-only output without selected UUIDs and blocks absent real bundles', async () => {
        const writeStdout = vi.fn();
        const readSnapshot = vi.fn(async (requestId: string) =>
            requestId === REQUEST_A ? snapshot(true) : snapshot(false));
        const dependencies: OrderAuditParityCliDependencies = {
            readSnapshot,
            writeStdout,
        };

        const result = await runOrderAuditParityCli([
            '--request-id', REQUEST_A,
            '--request-id', REQUEST_B,
            '--archive-manifest',
        ], dependencies);

        expect(result.exitCode).toBe(1);
        expect(readSnapshot).toHaveBeenCalledWith(REQUEST_A);
        expect(readSnapshot).toHaveBeenCalledWith(REQUEST_B);
        const output = writeStdout.mock.calls[0]?.[0] as string;
        expect(output).not.toContain(REQUEST_A);
        expect(output).not.toContain(REQUEST_B);
        expect(JSON.parse(output)).toMatchObject({
            selectedCount: 2,
            realCompletedCount: 1,
            parityPassedCount: 1,
            blockedCount: 1,
            archive: { mode: 'dry-run', destructiveOperations: 'refused' },
        });
    });
});
