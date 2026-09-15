import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
    createProfileProviderCanaryAmbiguousStartDependencies,
    parseProfileProviderCanaryAmbiguousStartArgs,
    resolveProfileProviderCanaryAmbiguousStart,
    runProfileProviderCanaryAmbiguousStartCli,
    writeProfileProviderCanaryOwnerSqlArtifact,
    type ProfileProviderCanaryAmbiguousStartDependencies,
} from '../../../../scripts/resolve-profile-provider-canary-ambiguous-start';
import { orderedProfileProviderCanaryHmac } from '../../../../scripts/profile-provider-canary-runtime';

const SOURCE_REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const ORDERED_HMAC = 'a'.repeat(64);
const RUN_ID = 'SensitiveRun1234';
const EVIDENCE_PATH = '/secure/evidence-reference.txt';
const SQL_OUTPUT_PATH = '/secure/profile-provider-resolution.sql';
const RESERVATION_TOKEN = '22222222-2222-4222-8222-222222222222';
const RESERVED_AT = '2026-07-19T01:00:00.000Z';
const AMBIGUOUS_AT = '2026-07-19T01:01:00.000Z';
const RUN_STARTED_AT = '2026-07-19T01:00:30.000Z';
const HMAC_SECRET = Buffer.alloc(32, 7).toString('base64');
const TEST_USERNAMES = Array.from({ length: 15 }, (_, index) => `test_user_${index + 1}`);

function artifactInput(kind: 'verified_no_run' | 'adopt_run', paths: {
    evidenceReferenceFile: string;
    sqlOutputFile: string;
}) {
    return {
        kind,
        sourceRequestId: SOURCE_REQUEST_ID,
        repetition: 1 as const,
        reservationToken: RESERVATION_TOKEN,
        orderedSetHmac: ORDERED_HMAC,
        ...paths,
        ...(kind === 'adopt_run' ? {
            candidate: {
                runId: RUN_ID,
                actorId: 'apify/instagram-scraper' as const,
                actorBuild: '0.0.692' as const,
                credentialSlot: 'primary' as const,
                startedAt: RUN_STARTED_AT,
            },
        } : {}),
    };
}

function args(): string[] {
    return [
        '--source-request-id', SOURCE_REQUEST_ID,
        '--repetition', '1',
        '--evidence-reference-file', EVIDENCE_PATH,
        '--sql-output-file', SQL_OUTPUT_PATH,
        '--confirm-ambiguous-start-resolution',
    ];
}

function dependencies(candidates: Array<{
    runId: string;
    inputHmac: string;
    actorId?: 'apify/instagram-scraper';
    actorBuild?: string;
    credentialSlot?: 'primary';
    startedAt?: string;
}> = []) {
    const startActor = vi.fn();
    const normalizedCandidates = candidates.map(candidate => ({
        actorId: candidate.actorId ?? ('apify/instagram-scraper' as const),
        actorBuild: candidate.actorBuild ?? '0.0.692',
        credentialSlot: candidate.credentialSlot ?? ('primary' as const),
        startedAt: candidate.startedAt ?? RUN_STARTED_AT,
        runId: candidate.runId,
        inputHmac: candidate.inputHmac,
    }));
    const attachConfirmedRun = vi.fn(async () => undefined);
    const recordVerifiedNoRun = vi.fn(async () => undefined);
    const writeOwnerSqlArtifact = vi.fn(async () => undefined);
    const deps: ProfileProviderCanaryAmbiguousStartDependencies & {
        attachConfirmedRun: typeof attachConfirmedRun;
        recordVerifiedNoRun: typeof recordVerifiedNoRun;
        writeOwnerSqlArtifact: typeof writeOwnerSqlArtifact;
        startActor: typeof startActor;
    } = {
        now: vi.fn(() => Date.parse(AMBIGUOUS_AT) + 5 * 60_000),
        wait: vi.fn(async () => undefined),
        loadAmbiguousReservation: vi.fn(async () => ({
            state: 'ambiguous' as const,
            orderedSetHmac: ORDERED_HMAC,
            reservationToken: RESERVATION_TOKEN,
            actorId: 'apify/instagram-scraper' as const,
            actorBuild: '0.0.692' as const,
            credentialSlot: 'primary' as const,
            reservedAt: RESERVED_AT,
            ambiguousAt: AMBIGUOUS_AT,
        })),
        listStartCandidates: vi.fn(async () => normalizedCandidates),
        writeOwnerSqlArtifact,
        attachConfirmedRun,
        recordVerifiedNoRun,
        writeStdout: vi.fn(),
        startActor,
    };
    return deps;
}

function operationalDependencies(input: {
    items: Array<{ id: string; buildNumber: string; startedAt: Date }>;
    total?: number;
    providerInput?: unknown;
    listError?: Error;
}) {
    const env = { ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: HMAC_SECRET };
    const orderedSetHmac = orderedProfileProviderCanaryHmac(TEST_USERNAMES, env);
    const list = vi.fn(async () => {
        if (input.listError) throw input.listError;
        return { total: input.total ?? input.items.length, items: input.items };
    });
    const getRecord = vi.fn(async () => input.providerInput ?? ({
        value: {
            directUrls: TEST_USERNAMES.map(
                username => `https://www.instagram.com/${username}/`
            ),
            resultsType: 'details',
        },
    }));
    const actor = vi.fn(() => ({ runs: () => ({ list }) }));
    const run = vi.fn(() => ({ keyValueStore: () => ({ getRecord }) }));
    const writeOwnerSqlArtifact = vi.fn(async () => undefined);
    const store = {
        loadExperiment: vi.fn(async () => ({ orderedSetHmac }) as never),
        loadRun: vi.fn(async () => ({
            state: 'ambiguous',
            reservationToken: RESERVATION_TOKEN,
            actorId: 'apify/instagram-scraper',
            actorBuild: '0.0.692',
            credentialSlot: 'primary',
            reservedAt: RESERVED_AT,
            ambiguousAt: AMBIGUOUS_AT,
        }) as never),
    };
    const deps = createProfileProviderCanaryAmbiguousStartDependencies({
        env,
        store,
        getClient: () => ({ actor, run }),
        writeOwnerSqlArtifact,
        writeStdout: vi.fn(),
        now: () => Date.parse(AMBIGUOUS_AT) + 5 * 60_000,
        wait: vi.fn(async () => undefined),
    });
    return { deps, actor, run, list, getRecord, writeOwnerSqlArtifact, orderedSetHmac, store };
}

describe('profile provider ambiguous-start arguments', () => {
    it('requires one exact valueless manual-resolution confirmation', () => {
        expect(parseProfileProviderCanaryAmbiguousStartArgs(args())).toEqual({
            sourceRequestId: SOURCE_REQUEST_ID,
            repetition: 1,
            evidenceReferenceFile: EVIDENCE_PATH,
            sqlOutputFile: SQL_OUTPUT_PATH,
            confirmAmbiguousStartResolution: true,
        });
        expect(() => parseProfileProviderCanaryAmbiguousStartArgs(args().slice(0, -1)))
            .toThrow('required');
        expect(() => parseProfileProviderCanaryAmbiguousStartArgs([
            ...args().slice(0, -1), '--confirm-ambiguous-start-resolution=true',
        ])).toThrow('exact and valueless');
        expect(() => parseProfileProviderCanaryAmbiguousStartArgs([
            ...args(), '--confirm-paid-api-call',
        ])).toThrow('unknown argument');
    });
});

describe('profile provider ambiguous-start resolution', () => {
    it('reads the exact owner journal and exact Actor/build/primary/time/input candidate', async () => {
        const setup = operationalDependencies({
            items: [{
                id: RUN_ID,
                buildNumber: '0.0.692',
                startedAt: new Date(RUN_STARTED_AT),
            }],
        });

        await expect(resolveProfileProviderCanaryAmbiguousStart(
            parseProfileProviderCanaryAmbiguousStartArgs(args()), setup.deps
        )).resolves.toMatchObject({
            outcome: 'owner_sql_artifact_written',
            artifact_kind: 'adopt_run',
            actor_start_count: 0,
            artifact_written: true,
        });
        expect(setup.store.loadExperiment).toHaveBeenCalledWith({
            sourceRequestId: SOURCE_REQUEST_ID,
        });
        expect(setup.store.loadRun).toHaveBeenCalledWith({
            sourceRequestId: SOURCE_REQUEST_ID,
            repetition: 1,
        });
        expect(setup.actor).toHaveBeenCalledWith('apify/instagram-scraper');
        expect(setup.list).toHaveBeenCalledWith({
            desc: false,
            limit: 100,
            startedAfter: '2026-07-19T00:59:00.000Z',
            startedBefore: '2026-07-19T01:02:00.000Z',
        });
        expect(setup.run).toHaveBeenCalledWith(RUN_ID);
        expect(setup.getRecord).toHaveBeenCalledWith('INPUT');
        expect(setup.writeOwnerSqlArtifact).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'adopt_run',
            orderedSetHmac: setup.orderedSetHmac,
            candidate: expect.objectContaining({
                runId: RUN_ID,
                actorId: 'apify/instagram-scraper',
                actorBuild: '0.0.692',
                credentialSlot: 'primary',
                startedAt: RUN_STARTED_AT,
            }),
        }));
    });

    it('sanitizes raw Apify lookup errors and never exposes provider details', async () => {
        const setup = operationalDependencies({
            items: [],
            listError: new Error(`provider token=secret run=${RUN_ID} username=test_user_1`),
        });

        const rejected = resolveProfileProviderCanaryAmbiguousStart(
            parseProfileProviderCanaryAmbiguousStartArgs(args()), setup.deps
        );
        await expect(rejected).rejects.toThrow(
            'PROFILE_PROVIDER_CANARY_CANDIDATE_READ_FAILED'
        );
        await rejected.catch(error => {
            expect(String(error)).not.toMatch(/token=|SensitiveRun|username=/i);
        });
        expect(setup.writeOwnerSqlArtifact).not.toHaveBeenCalled();
    });

    it('generates only the no-run owner artifact when the exact window has zero candidates', async () => {
        const setup = operationalDependencies({ items: [] });

        await expect(resolveProfileProviderCanaryAmbiguousStart(
            parseProfileProviderCanaryAmbiguousStartArgs(args()), setup.deps
        )).resolves.toMatchObject({
            outcome: 'owner_sql_artifact_written',
            artifact_kind: 'verified_no_run',
            actor_start_count: 0,
            artifact_written: true,
        });
        expect(setup.writeOwnerSqlArtifact).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'verified_no_run',
        }));
        expect(setup.list).toHaveBeenCalledTimes(2);
        expect(setup.run).not.toHaveBeenCalled();
    });

    it('blocks no-run resolution when the ambiguity is too recent for provider convergence', async () => {
        const deps = dependencies([]);
        deps.now = vi.fn(() => Date.parse(AMBIGUOUS_AT) + 119_999);

        await expect(resolveProfileProviderCanaryAmbiguousStart(
            parseProfileProviderCanaryAmbiguousStartArgs(args()), deps
        )).rejects.toThrow('PROFILE_PROVIDER_CANARY_NO_RUN_OBSERVATION_TOO_EARLY');
        expect(deps.listStartCandidates).not.toHaveBeenCalled();
        expect(deps.writeOwnerSqlArtifact).not.toHaveBeenCalled();
    });

    it('blocks no-run resolution when a candidate appears on the second observation', async () => {
        const deps = dependencies([]);
        vi.mocked(deps.listStartCandidates)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{
                runId: RUN_ID,
                inputHmac: ORDERED_HMAC,
                actorId: 'apify/instagram-scraper',
                actorBuild: '0.0.692',
                credentialSlot: 'primary',
                startedAt: RUN_STARTED_AT,
            }]);

        await expect(resolveProfileProviderCanaryAmbiguousStart(
            parseProfileProviderCanaryAmbiguousStartArgs(args()), deps
        )).resolves.toMatchObject({
            outcome: 'blocked_candidate_set_unstable',
            artifact_written: false,
        });
        expect(deps.wait).toHaveBeenCalledOnce();
        expect(deps.writeOwnerSqlArtifact).not.toHaveBeenCalled();
    });

    it('blocks multiple exact candidates without writing a mutation artifact', async () => {
        const setup = operationalDependencies({
            items: [
                { id: RUN_ID, buildNumber: '0.0.692', startedAt: new Date(RUN_STARTED_AT) },
                {
                    id: 'SensitiveRun5678',
                    buildNumber: '0.0.692',
                    startedAt: new Date(RUN_STARTED_AT),
                },
            ],
        });

        await expect(resolveProfileProviderCanaryAmbiguousStart(
            parseProfileProviderCanaryAmbiguousStartArgs(args()), setup.deps
        )).resolves.toMatchObject({
            outcome: 'blocked_multiple_candidates',
            artifact_kind: null,
            actor_start_count: 0,
            artifact_written: false,
        });
        expect(setup.run).toHaveBeenCalledTimes(2);
        expect(setup.writeOwnerSqlArtifact).not.toHaveBeenCalled();
    });

    it('adopts one exact build and INPUT match when another build shares the time window', async () => {
        const setup = operationalDependencies({
            items: [
                { id: RUN_ID, buildNumber: '0.0.692', startedAt: new Date(RUN_STARTED_AT) },
                {
                    id: 'UnrelatedRun5678',
                    buildNumber: '0.0.691',
                    startedAt: new Date(RUN_STARTED_AT),
                },
            ],
        });

        await expect(resolveProfileProviderCanaryAmbiguousStart(
            parseProfileProviderCanaryAmbiguousStartArgs(args()), setup.deps
        )).resolves.toMatchObject({
            outcome: 'owner_sql_artifact_written',
            artifact_kind: 'adopt_run',
        });
        expect(setup.run).toHaveBeenCalledTimes(1);
        expect(setup.run).toHaveBeenCalledWith(RUN_ID);
    });

    it('fails closed when the full candidate window exceeds the bounded read', async () => {
        const setup = operationalDependencies({
            total: 200,
            items: [
                { id: RUN_ID, buildNumber: '0.0.692', startedAt: new Date(RUN_STARTED_AT) },
                {
                    id: 'SensitiveRun5678',
                    buildNumber: '0.0.692',
                    startedAt: new Date(RUN_STARTED_AT),
                },
            ],
        });

        await expect(resolveProfileProviderCanaryAmbiguousStart(
            parseProfileProviderCanaryAmbiguousStartArgs(args()), setup.deps
        )).rejects.toThrow('PROFILE_PROVIDER_CANARY_CANDIDATE_READ_FAILED');
        expect(setup.list).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
        expect(setup.run).not.toHaveBeenCalled();
        expect(setup.writeOwnerSqlArtifact).not.toHaveBeenCalled();
    });

    it.each([
        {
            label: 'build',
            buildNumber: '0.0.693',
            providerInput: undefined,
        },
        {
            label: 'INPUT ordered HMAC',
            buildNumber: '0.0.692',
            providerInput: {
                value: {
                    directUrls: [...TEST_USERNAMES].reverse().map(
                        username => `https://www.instagram.com/${username}/`
                    ),
                    resultsType: 'details',
                },
            },
        },
    ])('blocks a single candidate with mismatched $label', async ({
        buildNumber,
        providerInput,
    }) => {
        const setup = operationalDependencies({
            items: [{ id: RUN_ID, buildNumber, startedAt: new Date(RUN_STARTED_AT) }],
            providerInput,
        });

        await expect(resolveProfileProviderCanaryAmbiguousStart(
            parseProfileProviderCanaryAmbiguousStartArgs(args()), setup.deps
        )).resolves.toMatchObject({
            outcome: 'blocked_input_mismatch',
            artifact_kind: null,
            actor_start_count: 0,
            artifact_written: false,
        });
        expect(setup.writeOwnerSqlArtifact).not.toHaveBeenCalled();
    });

    it('generates a verified-no-run artifact without any Actor start capability', async () => {
        const deps = dependencies([]);

        await expect(resolveProfileProviderCanaryAmbiguousStart(
            parseProfileProviderCanaryAmbiguousStartArgs(args()), deps
        )).resolves.toEqual({
            mode: 'resolve_ambiguous_start',
            repetition: 1,
            outcome: 'owner_sql_artifact_written',
            artifact_kind: 'verified_no_run',
            actor_start_count: 0,
            artifact_written: true,
        });
        expect(deps.writeOwnerSqlArtifact).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'verified_no_run',
            evidenceReferenceFile: EVIDENCE_PATH,
            sqlOutputFile: SQL_OUTPUT_PATH,
        }));
        expect(deps.recordVerifiedNoRun).not.toHaveBeenCalled();
        expect(deps.attachConfirmedRun).not.toHaveBeenCalled();
        expect(deps.startActor).not.toHaveBeenCalled();
    });

    it('generates an adopt artifact only for one timing-safe HMAC match', async () => {
        const deps = dependencies([{
            runId: RUN_ID,
            inputHmac: ORDERED_HMAC,
            actorId: 'apify/instagram-scraper',
            actorBuild: '0.0.692',
            credentialSlot: 'primary',
            startedAt: RUN_STARTED_AT,
        }]);

        const result = await resolveProfileProviderCanaryAmbiguousStart(
            parseProfileProviderCanaryAmbiguousStartArgs(args()), deps
        );

        expect(result).toMatchObject({
            outcome: 'owner_sql_artifact_written',
            artifact_kind: 'adopt_run',
            actor_start_count: 0,
            artifact_written: true,
        });
        expect(deps.writeOwnerSqlArtifact).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'adopt_run',
            candidate: expect.objectContaining({ runId: RUN_ID, startedAt: RUN_STARTED_AT }),
        }));
        expect(deps.attachConfirmedRun).not.toHaveBeenCalled();
        expect(deps.recordVerifiedNoRun).not.toHaveBeenCalled();
        expect(deps.startActor).not.toHaveBeenCalled();
    });

    it('sanitizes artifact-writer errors without exposing provider identity or paths', async () => {
        const deps = dependencies([]);
        deps.writeOwnerSqlArtifact.mockRejectedValueOnce(
            new Error(`raw ${RUN_ID} ${SQL_OUTPUT_PATH} token=secret`)
        );

        const rejected = resolveProfileProviderCanaryAmbiguousStart(
            parseProfileProviderCanaryAmbiguousStartArgs(args()), deps
        );
        await expect(rejected).rejects.toThrow(
            'PROFILE_PROVIDER_CANARY_SQL_ARTIFACT_WRITE_FAILED'
        );
        await rejected.catch(error => {
            expect(String(error)).not.toMatch(/SensitiveRun|\/secure|token=secret/i);
        });
    });

    it.each([
        [[{ runId: RUN_ID, inputHmac: 'b'.repeat(64) }], 'blocked_input_mismatch'],
        [[
            { runId: RUN_ID, inputHmac: ORDERED_HMAC },
            { runId: 'SensitiveRun5678', inputHmac: ORDERED_HMAC },
        ], 'blocked_multiple_candidates'],
    ] as const)('blocks mismatch or multiplicity with zero writes and zero starts', async (
        candidates,
        outcome
    ) => {
        const deps = dependencies([...candidates]);
        await expect(resolveProfileProviderCanaryAmbiguousStart(
            parseProfileProviderCanaryAmbiguousStartArgs(args()), deps
        )).resolves.toMatchObject({ outcome, actor_start_count: 0 });
        expect(deps.attachConfirmedRun).not.toHaveBeenCalled();
        expect(deps.recordVerifiedNoRun).not.toHaveBeenCalled();
        expect(deps.startActor).not.toHaveBeenCalled();
    });

    it('writes only a fixed aggregate outcome to stdout', async () => {
        const deps = dependencies([{ runId: RUN_ID, inputHmac: ORDERED_HMAC }]);
        await runProfileProviderCanaryAmbiguousStartCli(args(), deps);
        const stdout = vi.mocked(deps.writeStdout!).mock.calls.flat().join('');
        expect(JSON.parse(stdout)).toMatchObject({
            mode: 'resolve_ambiguous_start',
            outcome: 'owner_sql_artifact_written',
            artifact_kind: 'adopt_run',
            actor_start_count: 0,
        });
        expect(Object.keys(JSON.parse(stdout)).sort()).toEqual([
            'actor_start_count',
            'artifact_kind',
            'artifact_written',
            'mode',
            'outcome',
            'repetition',
        ]);
        expect(stdout).not.toMatch(/SensitiveRun|run_?id|hmac|hash|token|url|email/i);
        expect(stdout).not.toContain(SOURCE_REQUEST_ID);
        expect(stdout).not.toContain(EVIDENCE_PATH);
        expect(stdout).not.toContain(SQL_OUTPUT_PATH);
    });
});

describe('database-owner SQL artifact', () => {
    it('writes an idempotent no-run owner function call outside the repo with mode 0600', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'profile-canary-resolver-'));
        const evidenceReferenceFile = join(directory, 'evidence.txt');
        const sqlOutputFile = join(directory, 'resolve.sql');
        const evidence = 'incident-reference-without-user-data';
        try {
            await writeFile(evidenceReferenceFile, evidence, { mode: 0o600 });
            const input = artifactInput('verified_no_run', {
                evidenceReferenceFile,
                sqlOutputFile,
            });

            await writeProfileProviderCanaryOwnerSqlArtifact(input);
            const first = await readFile(sqlOutputFile, 'utf8');
            expect((await stat(sqlOutputFile)).mode & 0o777).toBe(0o600);
            expect(first).toContain(
                'SELECT public.resolve_analysis_v2_profile_provider_canary_no_run('
            );
            expect(first).toContain(
                createHash('sha256').update(evidence).digest('hex')
            );
            expect(first).not.toMatch(/\b(?:UPDATE|INSERT|DELETE)\b/i);

            await expect(writeProfileProviderCanaryOwnerSqlArtifact(input)).resolves.toBeUndefined();
            expect(await readFile(sqlOutputFile, 'utf8')).toBe(first);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('writes the exact adopt-run owner function call without usernames or URLs', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'profile-canary-resolver-'));
        const evidenceReferenceFile = join(directory, 'evidence.txt');
        const sqlOutputFile = join(directory, 'resolve.sql');
        try {
            await writeFile(evidenceReferenceFile, 'incident-reference', { mode: 0o600 });
            await writeProfileProviderCanaryOwnerSqlArtifact(artifactInput('adopt_run', {
                evidenceReferenceFile,
                sqlOutputFile,
            }));

            const sql = await readFile(sqlOutputFile, 'utf8');
            expect(sql).toContain(
                'SELECT public.resolve_analysis_v2_profile_provider_canary_adopt_run('
            );
            expect(sql).toContain(RUN_ID);
            expect(sql).toContain("'apify/instagram-scraper'::TEXT");
            expect(sql).toContain("'0.0.692'::TEXT");
            expect(sql).toContain("'primary'::TEXT");
            expect(sql).toContain(ORDERED_HMAC);
            expect(sql).not.toMatch(/instagram\.com|test_user|\b(?:UPDATE|INSERT|DELETE)\b/i);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('rejects an output path inside the repository before creating an artifact', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'profile-canary-resolver-'));
        const evidenceReferenceFile = join(directory, 'evidence.txt');
        const sqlOutputFile = join(
            process.cwd(), 'scripts', 'profile-provider-resolution-must-not-exist.sql'
        );
        try {
            await writeFile(evidenceReferenceFile, 'incident-reference', { mode: 0o600 });
            await expect(writeProfileProviderCanaryOwnerSqlArtifact(
                artifactInput('verified_no_run', { evidenceReferenceFile, sqlOutputFile })
            )).rejects.toThrow('PROFILE_PROVIDER_CANARY_SQL_ARTIFACT_PATH_INVALID');
            await expect(readFile(sqlOutputFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
