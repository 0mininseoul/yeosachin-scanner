import {
    chmodSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
    generateResolutionSql,
    parseGeneratorArguments,
    parseCandidateFile,
    readPrivateCandidateFile,
    writePrivateResolutionSqlFile,
} from './generate-analysis-v2-conservative-max-charge-resolution';

function candidate(index: number): Record<string, unknown> {
    return {
        requestId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        jobKey: `track:profiles:batch:${index}`,
        operationKey: `target-profile:${'a'.repeat(64)}`,
        inputHash: 'b'.repeat(64),
        jobClaimToken: `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
        reservationToken: `00000000-0000-4000-8000-${String(index + 20).padStart(12, '0')}`,
        runId: `run-${String(index).padStart(8, '0')}`,
        logicalProvider: 'apify',
        actorId: 'apify/instagram-profile-scraper',
        credentialSlot: 'tertiary',
        maxChargeUsd: 0.0026,
        reservedAt: '2026-08-14T01:00:00.000Z',
        runStartedAt: '2026-08-14T01:01:00.000Z',
        terminalizedAt: '2026-08-14T01:02:00.000Z',
        status: 'succeeded',
    };
}

describe('conservative max-charge SQL generator', () => {
    it('accepts only a five-row identity-only candidate file', () => {
        const parsed = parseCandidateFile(JSON.stringify([0, 1, 2, 3, 4].map(candidate)));
        expect(parsed).toHaveLength(5);
        expect(() => parseCandidateFile(JSON.stringify([candidate(1)]))).toThrow(/exactly five/);
        expect(() => parseCandidateFile(JSON.stringify([
            { ...candidate(1), username: 'must-not-be-present' },
            candidate(2),
            candidate(3),
            candidate(4),
            candidate(5),
        ]))).toThrow(/unsupported field/);
        expect(() => parseCandidateFile(JSON.stringify([
            candidate(1), candidate(1), candidate(3), candidate(4), candidate(5),
        ]))).toThrow(/identity tuples must be unique/);
        expect(() => parseCandidateFile(JSON.stringify([
            { ...candidate(1), reservedAt: '2026-08-14T01:02:00.000Z', runStartedAt: '2026-08-14T01:01:00.000Z' },
            candidate(2), candidate(3), candidate(4), candidate(5),
        ]))).toThrow(/reserved <= started <= terminal/);
        expect(() => parseCandidateFile(JSON.stringify([
            { ...candidate(1), terminalizedAt: '2026-08-14T01:02:00.000' },
            candidate(2), candidate(3), candidate(4), candidate(5),
        ]))).toThrow(/include a timezone/);
        expect(() => parseGeneratorArguments([
            '--input', '/secure/candidates.json',
            '--output', '/secure/resolution.sql',
            '--evidence-hash', 'c'.repeat(64),
            '--unexpected', 'value',
        ])).toThrow(/unknown option/);
    });

    it('emits owner-only latest-resolver calls without environment or PII plumbing', () => {
        const sql = generateResolutionSql(
            parseCandidateFile(JSON.stringify([0, 1, 2, 3, 4].map(candidate))),
            'c'.repeat(64)
        );
        expect(sql.match(/resolve_analysis_v2_provider_run_conservative_max_charge/g)).toHaveLength(5);
        expect(sql).toContain("'conservative_max_charge'");
        expect(sql).not.toMatch(/\.env|source |username|caption|profile_url|provider_payload/i);
        expect(sql).toContain('BEGIN;');
        expect(sql).toContain('COMMIT;');
    });

    it('requires private regular input and exclusive private output outside the repository', () => {
        const directory = mkdtempSync(join(tmpdir(), 'v2-max-charge-generator-'));
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
            expect(() => writePrivateResolutionSqlFile(join(repositoryParentLink, 'resolution.sql'), 'unsafe'))
                .toThrow(/outside the repository/);

            const output = join(directory, 'resolution.sql');
            writePrivateResolutionSqlFile(output, 'BEGIN;\nCOMMIT;\n');
            expect(readFileSync(output, 'utf8')).toContain('BEGIN;');
            expect(statSync(output).mode & 0o777).toBe(0o600);
            expect(() => writePrivateResolutionSqlFile(output, 'retry')).toThrow();
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
