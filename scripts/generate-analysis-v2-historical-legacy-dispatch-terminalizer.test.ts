import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
    generateTerminalizationSql,
    parseCandidateFile,
    parseGeneratorArguments,
    readPrivateCandidateFile,
    writePrivateTerminalizationSqlFile,
} from './generate-analysis-v2-historical-legacy-dispatch-terminalizer';

const UUID = (index: number): string =>
    `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

function candidate(index: number, manualResolution = true): Record<string, unknown> {
    return {
        requestId: UUID(index),
        jobKey: `track:profiles:batch:${index}`,
        inputHash: 'a'.repeat(64),
        priorStatus: index % 2 === 0 ? 'pending' : 'processing',
        priorDispatchState: 'delivered',
        priorDispatchWorkloadRole: null,
        priorDispatchContractVersion: null,
        priorClaimWorkloadRole: null,
        priorClaimContractVersion: null,
        priorDispatchGeneration: 1,
        priorDispatchReservationToken: UUID(index + 10),
        priorDispatchReservedAt: '2026-07-01T00:00:00.000Z',
        priorDispatchedAt: '2026-07-01T00:01:00.000Z',
        priorDeliveredAt: '2026-07-01T00:02:00.000Z',
        priorDispatchTaskName: `analysis-v2-${index}`,
        priorLeaseToken: index % 2 === 0 ? null : UUID(index + 20),
        priorLeaseExpiresAt: index % 2 === 0 ? null : '2026-08-01T00:00:00.000Z',
        manualResolutionOperationKey: manualResolution ? `target-profile:${'b'.repeat(64)}` : null,
        manualResolutionEvidenceHash: manualResolution ? 'c'.repeat(64) : null,
    };
}

describe('historical legacy-dispatch terminalizer SQL generator', () => {
    it('accepts exactly five sanitized, unique, fully-bound candidates', () => {
        const parsed = parseCandidateFile(JSON.stringify([1, 2, 3, 4, 5].map((index) => candidate(index))));
        expect(parsed).toHaveLength(5);
        expect(() => parseCandidateFile(JSON.stringify([candidate(1)]))).toThrow(/exactly five/);
        expect(() => parseCandidateFile(JSON.stringify([
            { ...candidate(1), username: 'forbidden' }, candidate(2), candidate(3), candidate(4), candidate(5),
        ]))).toThrow(/unsupported field/);
        expect(() => parseCandidateFile(JSON.stringify([
            candidate(1), candidate(1), candidate(3), candidate(4), candidate(5),
        ]))).toThrow(/identity tuples must be unique/);
        expect(() => parseCandidateFile(JSON.stringify([
            { ...candidate(1), priorLeaseToken: UUID(21), priorLeaseExpiresAt: null },
            candidate(2), candidate(3), candidate(4), candidate(5),
        ]))).toThrow(/lease/);
        expect(() => parseCandidateFile(JSON.stringify([
            { ...candidate(1), manualResolutionOperationKey: null },
            candidate(2), candidate(3), candidate(4), candidate(5),
        ]))).toThrow(/manual-resolution fields/);
        expect(() => parseGeneratorArguments([
            '--input', '/private/candidates.json', '--output', '/private/out.sql', '--audit-evidence-hash', 'd'.repeat(64),
            '--unexpected', 'value',
        ])).toThrow(/unknown option/);
    });

    it('emits five owner-only calls with exact pre-state identity and no runtime adapters', () => {
        const sql = generateTerminalizationSql(
            parseCandidateFile(JSON.stringify([1, 2, 3, 4, 5].map((index) => candidate(index)))),
            'd'.repeat(64),
            'failed'
        );
        expect(sql.match(/resolve_analysis_v2_historical_legacy_dispatch/g)).toHaveLength(5);
        expect(sql).toContain("'HISTORICAL_LEGACY_DISPATCH_TERMINALIZED'");
        expect(sql).toContain('BEGIN;');
        expect(sql).toContain('COMMIT;');
        expect(sql).not.toMatch(/\.env|source |username|caption|profile_url|provider_payload/i);
        expect(sql).not.toMatch(/fetch|http|apify-client|gemini|scraper/i);
    });

    it('accepts a candidate with no conservative manual-resolution row and emits typed NULLs', () => {
        const parsed = parseCandidateFile(JSON.stringify([
            candidate(1, false), candidate(2), candidate(3), candidate(4), candidate(5),
        ]));
        expect(parsed[0].manualResolutionOperationKey).toBeNull();
        const sql = generateTerminalizationSql(parsed, 'd'.repeat(64));
        expect(sql).toContain('NULL::TEXT,\n    NULL::TEXT,');
    });

    it('requires private regular input and exclusive private output outside repository', () => {
        const directory = mkdtempSync(join(tmpdir(), 'v2-terminalizer-generator-'));
        try {
            const input = join(directory, 'candidates.json');
            writeFileSync(input, '[]', { encoding: 'utf8', mode: 0o600 });
            chmodSync(input, 0o600);
            expect(readPrivateCandidateFile(input)).toBe('[]');
            const publicInput = join(directory, 'public.json');
            writeFileSync(publicInput, '[]', { encoding: 'utf8', mode: 0o644 });
            chmodSync(publicInput, 0o644);
            expect(() => readPrivateCandidateFile(publicInput)).toThrow(/private mode/);
            const link = join(directory, 'link.json');
            symlinkSync(input, link);
            expect(() => readPrivateCandidateFile(link)).toThrow(/symbolic link/);
            const repositoryParentLink = join(directory, 'repository-parent');
            symlinkSync(resolvePath(process.cwd()), repositoryParentLink, 'dir');
            expect(() => readPrivateCandidateFile(join(repositoryParentLink, 'package.json')))
                .toThrow(/outside the repository/);
            const output = join(directory, 'resolution.sql');
            writePrivateTerminalizationSqlFile(output, 'BEGIN;\nCOMMIT;\n');
            expect(readFileSync(output, 'utf8')).toContain('BEGIN;');
            expect(() => writePrivateTerminalizationSqlFile(output, 'retry')).toThrow();
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
