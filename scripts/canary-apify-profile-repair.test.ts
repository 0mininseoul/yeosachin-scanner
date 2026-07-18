import { describe, expect, it, vi } from 'vitest';
import {
    failedProfileAttempt,
    successfulProfileAttempt,
    unavailableProfileAttempt,
} from '../lib/services/instagram/providers/profile-attempt';
import type {
    ProfileAttemptResult,
    ProviderCallContext,
} from '../lib/services/instagram/providers/types';
import type { InstagramProfile } from '../lib/types/instagram';
import type {
    ProfileRepairCanaryRunStore,
    StoredProfileRepairCanaryRun,
} from '../lib/services/analysis/profile-repair-canary-run-store';
import { parseProfileRepairCanaryArgs } from './canary-apify-profile-repair-options';
import {
    fetchProfileRepairCanaryAccountingSnapshot,
    runProfileRepairCanary,
    runProfileRepairCanaryCli,
    type ProfileRepairCanaryDependencies,
    type ProfileRepairCanarySourceBundle,
} from './canary-apify-profile-repair';
import { parseProfileRepairCanarySourceInput } from './canary-apify-profile-repair-validation';

const SOURCE_REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_EMAIL = 'operator@example.test';
const SLOT = 'tertiary' as const;
const NOW = '2026-07-18T03:00:00.000Z';

function options(paid = false) {
    return parseProfileRepairCanaryArgs([
        '--source-request-id', SOURCE_REQUEST_ID,
        '--critical-job-key', 'track:profiles:batch:7',
        '--credential-slot', SLOT,
        ...(paid ? ['--confirm-paid-api-call'] : []),
    ]);
}

function profile(username: string): InstagramProfile {
    return {
        username,
        followersCount: 0,
        followingCount: 0,
        postsCount: 0,
        isPrivate: false,
        isVerified: false,
    };
}

function incomplete(username: string): ProfileAttemptResult {
    return failedProfileAttempt({
        requestedUsername: username,
        source: 'apify',
        error: new Error('SCRAPING_INCOMPLETE_ERROR: attributed source omission'),
        requestCount: 1,
        latencyMs: 10,
        capturedAt: NOW,
    });
}

function success(username: string): ProfileAttemptResult {
    return successfulProfileAttempt({
        requestedUsername: username,
        source: 'apify',
        profile: profile(username),
        requestCount: 1,
        latencyMs: 10,
        capturedAt: NOW,
    });
}

function unavailable(username: string): ProfileAttemptResult {
    return unavailableProfileAttempt({
        requestedUsername: username,
        source: 'apify',
        reason: 'not_found',
        httpStatus: 404,
        requestCount: 1,
        latencyMs: 10,
        capturedAt: NOW,
    });
}

function sourceFixture(): {
    bundle: ProfileRepairCanarySourceBundle;
    inputs: Map<string, string[]>;
} {
    const inputs = new Map<string, string[]>();
    const runs = Array.from({ length: 8 }, (_, index) => {
        const usernames = index === 7
            ? ['candidate_14']
            : [`candidate_${index * 2}`, `candidate_${index * 2 + 1}`];
        const runId = `SourceRun${String(index).padStart(8, '0')}`;
        inputs.set(runId, usernames);
        return {
            jobKey: `track:profiles:batch:${index}`,
            operationKey: `profile-fallback:${index.toString(16).repeat(64)}`,
            status: 'succeeded',
            runId,
            actorId: 'apify/instagram-profile-scraper',
            credentialSlot: SLOT,
            maxChargeUsd: 0.078,
        };
    });
    return {
        bundle: {
            request: {
                sourceRequestId: SOURCE_REQUEST_ID,
                userId: OWNER_ID,
                ownerEmail: OWNER_EMAIL,
                targetInstagramId: '0_min._.00',
                pipelineVersion: 'v2',
                status: 'failed',
            },
            runs,
        },
        inputs,
    };
}

function storedRun(
    repetition: 1 | 2,
    state: StoredProfileRepairCanaryRun['state'],
    overrides: Partial<StoredProfileRepairCanaryRun> = {}
): StoredProfileRepairCanaryRun {
    const started = state === 'running' || state === 'succeeded' || state === 'failed';
    const terminal = state === 'succeeded' || state === 'failed';
    return {
        sourceRequestId: SOURCE_REQUEST_ID,
        canaryVersion: 'profile-repair-canary-v1',
        repetition,
        actorId: 'apify/instagram-profile-scraper',
        credentialSlot: SLOT,
        requestedCount: 15,
        maxChargeUsd: 0.05,
        reservationToken: `33333333-3333-4333-8333-${String(repetition).padStart(12, '0')}`,
        state,
        runId: started ? `FreshRun${String(repetition).padStart(8, '0')}` : null,
        terminalCount: terminal ? 15 : null,
        successCount: terminal ? 14 : null,
        unavailableCount: terminal ? 1 : null,
        incompleteCount: terminal ? 0 : null,
        otherFailureCount: terminal ? 0 : null,
        criticalRecoveredCount: terminal ? 1 : null,
        latencyMs: terminal ? 1_000 : null,
        gatePassed: terminal ? state === 'succeeded' : null,
        actualUsageUsd: null,
        costStatus: state === 'ambiguous' ? 'unknown' : 'conservative',
        reservedAt: NOW,
        runStartedAt: started ? NOW : null,
        ambiguousAt: state === 'ambiguous' ? NOW : null,
        terminalizedAt: terminal || state === 'ambiguous' ? NOW : null,
        usageReconciledAt: null,
        updatedAt: NOW,
        ...overrides,
    };
}

function memoryStore(
    initial: StoredProfileRepairCanaryRun[] = [],
    events: string[] = []
): ProfileRepairCanaryRunStore & { rows: Map<number, StoredProfileRepairCanaryRun> } {
    const rows = new Map(initial.map(run => [run.repetition, run]));
    return {
        rows,
        load: vi.fn(async ({ repetition }) => rows.get(repetition) ?? null),
        reserve: vi.fn(async ({ repetition, credentialSlot }) => {
            events.push(`reserve:${repetition}`);
            const existing = rows.get(repetition);
            if (existing) return { created: false, run: existing };
            const run = storedRun(repetition, 'starting', { credentialSlot });
            rows.set(repetition, run);
            return { created: true, run };
        }),
        checkpointStarted: vi.fn(async input => {
            events.push(`checkpoint:${input.repetition}`);
            const current = rows.get(input.repetition)!;
            const run = storedRun(input.repetition, 'running', {
                reservationToken: current.reservationToken,
                runId: input.runId,
            });
            rows.set(input.repetition, run);
            return run;
        }),
        markAmbiguous: vi.fn(async input => {
            events.push(`ambiguous:${input.repetition}`);
            const current = rows.get(input.repetition)!;
            const run = storedRun(input.repetition, 'ambiguous', {
                reservationToken: current.reservationToken,
            });
            rows.set(input.repetition, run);
            return run;
        }),
        terminalize: vi.fn(async input => {
            events.push(`terminal:${input.repetition}`);
            const current = rows.get(input.repetition)!;
            const run = storedRun(input.repetition, input.state, {
                reservationToken: current.reservationToken,
                runId: input.runId,
                terminalCount: input.terminalCount,
                successCount: input.successCount,
                unavailableCount: input.unavailableCount,
                incompleteCount: input.incompleteCount,
                otherFailureCount: input.otherFailureCount,
                criticalRecoveredCount: input.criticalRecoveredCount,
                latencyMs: input.latencyMs,
                gatePassed: input.gatePassed,
            });
            rows.set(input.repetition, run);
            return run;
        }),
        reconcileUsage: vi.fn(async input => {
            events.push(`reconcile:${input.repetition}`);
            const current = rows.get(input.repetition)!;
            const run = {
                ...current,
                actualUsageUsd: input.actualUsageUsd,
                costStatus: 'actual' as const,
                usageReconciledAt: NOW,
            };
            rows.set(input.repetition, run);
            return run;
        }),
    };
}

function dependencies(input: {
    source?: ProfileRepairCanarySourceBundle;
    inputs?: Map<string, string[]>;
    sourceInputValue?: (runId: string, usernames: string[] | undefined) => unknown;
    store?: ProfileRepairCanaryRunStore;
    freshOutcomes?: (usernames: readonly string[], repetition: 1 | 2) => ProfileAttemptResult[];
    accounting?: (runId: string) => {
        status?: unknown;
        usageTotalUsd?: unknown;
        finishedAt?: unknown;
    };
    accountingGet?: (
        runId: string,
        options: { credentialSlot: typeof SLOT; signal: AbortSignal }
    ) => Promise<{
        status?: unknown;
        usageTotalUsd?: unknown;
        finishedAt?: unknown;
    } | undefined>;
    events?: string[];
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
} = {}) {
    const fixture = sourceFixture();
    const source = input.source ?? fixture.bundle;
    const sourceInputs = input.inputs ?? fixture.inputs;
    const events = input.events ?? [];
    const actorStart = vi.fn();
    const accountingGet = vi.fn(input.accountingGet ?? (async (runId: string) => (
        input.accounting?.(runId) ?? {
            status: 'SUCCEEDED',
            usageTotalUsd: 0.04,
            finishedAt: '2026-07-18T02:59:00.000Z',
        }
    )));
    let freshRepetition = 0;
    const run = vi.fn((runId: string) => ({
        keyValueStore: () => ({
            getRecord: vi.fn(async (key: string) => ({
                key,
                value: input.sourceInputValue?.(runId, sourceInputs.get(runId)) ?? {
                    usernames: sourceInputs.get(runId),
                    includeAboutSection: false,
                },
            })),
        }),
        get: vi.fn(() => accountingGet(runId, {
            credentialSlot: SLOT,
            signal: new AbortController().signal,
        })),
    }));
    const getProfilesBatchOutcomes = vi.fn(async (
        usernames: readonly string[],
        context: ProviderCallContext
    ) => {
        if (context.resumeRunId?.startsWith('SourceRun')) {
            return usernames.map(incomplete);
        }
        freshRepetition += 1;
        const repetition = freshRepetition as 1 | 2;
        events.push(`before:${repetition}`);
        await context.onBeforeRunStart?.({
            logicalProvider: 'apify',
            actorId: 'apify/instagram-profile-scraper',
            credentialSlot: SLOT,
            maxChargeUsd: 0.05,
        });
        const freshRunId = context.resumeRunId
            ?? `FreshRun${String(repetition).padStart(8, '0')}`;
        if (!context.resumeRunId) {
            events.push(`start:${repetition}`);
            await context.onRunStarted?.(freshRunId);
        }
        events.push(`wait:${repetition}`);
        return input.freshOutcomes?.(usernames, repetition)
            ?? usernames.map((username, index) => index === 13
                ? unavailable(username)
                : success(username));
    });
    const deps: ProfileRepairCanaryDependencies = {
        env: {
            AUTHORIZED_E2E_OWNER_ID: OWNER_ID,
            AUTHORIZED_E2E_OWNER_EMAIL: OWNER_EMAIL,
        },
        loadSource: vi.fn(async () => source),
        getClient: vi.fn(() => ({
            actor: () => ({ start: actorStart }),
            run,
            dataset: vi.fn(),
        })),
        getAccountingSnapshot: accountingGet,
        getProfilesBatchOutcomes,
        runStore: input.store ?? memoryStore([], events),
        now: input.now ?? (() => Date.parse(NOW)),
        sleep: input.sleep ?? (async () => undefined),
    } as ProfileRepairCanaryDependencies & {
        getAccountingSnapshot: typeof accountingGet;
    };
    return {
        deps,
        actorStart,
        run,
        accountingGet,
        getProfilesBatchOutcomes,
        events,
    };
}

describe('profile repair canary source replay', () => {
    it('accepts only the observed Actor INPUT shape and normalizes usernames', () => {
        expect(parseProfileRepairCanarySourceInput({
            value: {
                includeAboutSection: false,
                usernames: ['Candidate_1'],
            },
        })).toEqual(['candidate_1']);
    });

    it('replays exactly eight ledger-owned runs with zero Actor starts or journal writes', async () => {
        const fixture = sourceFixture();
        const store = memoryStore();
        const setup = dependencies({
            source: fixture.bundle,
            inputs: fixture.inputs,
            store,
        });

        await expect(runProfileRepairCanary(options(), setup.deps)).resolves.toEqual({
            mode: 'replay',
            source_run_count: 8,
            requested_count: 15,
            critical_incomplete_count: 1,
            runs: [],
            total_actual_cost_usd: 0,
            session_maximum_exposure_usd: 0,
            cost_status: 'actual',
            gate_passed: false,
        });
        expect(setup.actorStart).not.toHaveBeenCalled();
        expect(setup.deps.loadSource).toHaveBeenCalledWith({
            sourceRequestId: SOURCE_REQUEST_ID,
            ownerId: OWNER_ID,
            ownerEmail: OWNER_EMAIL,
            credentialSlot: SLOT,
        });
        expect(store.load).not.toHaveBeenCalled();
        expect(store.reserve).not.toHaveBeenCalled();
        expect(store.terminalize).not.toHaveBeenCalled();
        expect(setup.getProfilesBatchOutcomes).toHaveBeenCalledTimes(8);
        const replayIds = setup.getProfilesBatchOutcomes.mock.calls.map(
            call => call[1].resumeRunId
        );
        expect(replayIds).toEqual(fixture.bundle.runs.map(row => row.runId));
        expect(new Set(setup.run.mock.calls.map(call => call[0])))
            .toEqual(new Set(fixture.bundle.runs.map(row => row.runId)));
    });

    it.each([
        ['owner', { userId: '99999999-9999-4999-8999-999999999999' }],
        ['owner email', { ownerEmail: 'wrong@example.test' }],
        ['target', { targetInstagramId: 'wrong_target' }],
        ['pipeline', { pipelineVersion: 'v1' }],
        ['status', { status: 'completed' }],
    ])('rejects a source with the wrong %s', async (_label, requestOverride) => {
        const fixture = sourceFixture();
        const source = {
            ...fixture.bundle,
            request: { ...fixture.bundle.request, ...requestOverride },
        } as ProfileRepairCanarySourceBundle;
        await expect(runProfileRepairCanary(
            options(),
            dependencies({ source, inputs: fixture.inputs }).deps
        )).rejects.toThrow('SOURCE_INVALID');
    });

    it.each([
        ['actor', { actorId: 'community/other-actor' }],
        ['slot', { credentialSlot: 'secondary' }],
        ['status', { status: 'running' }],
        ['run id', { runId: null }],
        ['operation', { operationKey: `target-profile:${'a'.repeat(64)}` }],
    ])('rejects a ledger row with the wrong %s', async (_label, rowOverride) => {
        const fixture = sourceFixture();
        const source = {
            ...fixture.bundle,
            runs: fixture.bundle.runs.map((row, index) => index === 0
                ? { ...row, ...rowOverride }
                : row),
        } as ProfileRepairCanarySourceBundle;
        await expect(runProfileRepairCanary(
            options(),
            dependencies({ source, inputs: fixture.inputs }).deps
        )).rejects.toThrow('SOURCE_LEDGER_INVALID');
    });

    it('rejects missing and duplicate batch jobs before touching Apify', async () => {
        const fixture = sourceFixture();
        const missing = { ...fixture.bundle, runs: fixture.bundle.runs.slice(0, 7) };
        const duplicate = {
            ...fixture.bundle,
            runs: fixture.bundle.runs.map((row, index) => index === 7
                ? { ...row, jobKey: fixture.bundle.runs[0].jobKey }
                : row),
        };
        const missingSetup = dependencies({ source: missing, inputs: fixture.inputs });
        await expect(runProfileRepairCanary(options(), missingSetup.deps))
            .rejects.toThrow('SOURCE_LEDGER_INVALID');
        expect(missingSetup.deps.getClient).not.toHaveBeenCalled();
        await expect(runProfileRepairCanary(
            options(),
            dependencies({ source: duplicate, inputs: fixture.inputs }).deps
        )).rejects.toThrow('SOURCE_LEDGER_INVALID');
    });

    it('rejects missing, enabled, mistyped, or unreviewed Actor input fields', async () => {
        for (const sourceInputValue of [
            (_runId: string, usernames: string[] | undefined) => ({
                usernames,
                includeAboutSection: true,
            }),
            (_runId: string, usernames: string[] | undefined) => ({ usernames }),
            (_runId: string, usernames: string[] | undefined) => ({
                usernames,
                includeAboutSection: null,
            }),
            (_runId: string, usernames: string[] | undefined) => ({
                usernames,
                includeAboutSection: 0,
            }),
            (_runId: string, usernames: string[] | undefined) => ({
                usernames,
                includeAboutSection: 'false',
            }),
            (_runId: string, usernames: string[] | undefined) => ({
                usernames,
                includeAboutSection: undefined,
            }),
            (_runId: string, usernames: string[] | undefined) => ({
                usernames,
                includeAboutSection: false,
                resultsLimit: 30,
            }),
        ]) {
            const store = memoryStore();
            const setup = dependencies({ sourceInputValue, store });
            await expect(runProfileRepairCanary(options(), setup.deps))
                .rejects.toThrow('SOURCE_INPUT_INVALID');
            expect(setup.actorStart).not.toHaveBeenCalled();
            expect(setup.getProfilesBatchOutcomes).not.toHaveBeenCalled();
            expect(store.load).not.toHaveBeenCalled();
            expect(store.reserve).not.toHaveBeenCalled();
            expect(store.terminalize).not.toHaveBeenCalled();
        }
    });

    it('rejects duplicate inputs, non-incomplete failures, and an incomplete union other than 15', async () => {
        const fixture = sourceFixture();
        const duplicatedInputs = new Map(fixture.inputs);
        duplicatedInputs.set('SourceRun00000001', ['candidate_0', 'candidate_3']);
        await expect(runProfileRepairCanary(
            options(),
            dependencies({ inputs: duplicatedInputs }).deps
        )).rejects.toThrow('SOURCE_INPUT_INVALID');

        const nonIncomplete = dependencies();
        nonIncomplete.deps.getProfilesBatchOutcomes = vi.fn(async (
            usernames: readonly string[],
            context: ProviderCallContext
        ) => usernames.map((username, index) => (
            context.resumeRunId === 'SourceRun00000000' && index === 0
                ? failedProfileAttempt({
                    requestedUsername: username,
                    source: 'apify',
                    error: new Error('SCRAPING_SCHEMA_ERROR: contaminated'),
                    requestCount: 1,
                    latencyMs: 1,
                    capturedAt: NOW,
                })
                : incomplete(username)
        )));
        await expect(runProfileRepairCanary(options(), nonIncomplete.deps))
            .rejects.toThrow('SOURCE_OUTCOME_INVALID');

        const onlyFourteen = new Map(fixture.inputs);
        onlyFourteen.set('SourceRun00000007', []);
        await expect(runProfileRepairCanary(
            options(),
            dependencies({ inputs: onlyFourteen }).deps
        )).rejects.toThrow(/SOURCE_INPUT_INVALID|SOURCE_OUTCOME_INVALID/);
    });

    it('writes only the sanitized report to stdout', async () => {
        const setup = dependencies();
        const write = vi.fn();
        setup.deps.writeStdout = write;
        await runProfileRepairCanaryCli([
            '--source-request-id', SOURCE_REQUEST_ID,
            '--critical-job-key', 'track:profiles:batch:7',
            '--credential-slot', SLOT,
        ], setup.deps);
        const stdout = write.mock.calls.join('');
        expect(JSON.parse(stdout)).toMatchObject({ mode: 'replay', requested_count: 15 });
        expect(stdout).not.toMatch(
            /candidate_|SourceRun|FreshRun|dataset|token|hash|fingerprint|https?:|operator@|provider.*message/i
        );
    });
});

describe('profile repair paid canary lifecycle', () => {
    it('reserves and checkpoints each of exactly two fixed starts before waiting', async () => {
        const events: string[] = [];
        const store = memoryStore([], events);
        const setup = dependencies({ store, events });

        const report = await runProfileRepairCanary(options(true), setup.deps);

        expect(report).toMatchObject({
            mode: 'paid_canary',
            requested_count: 15,
            total_actual_cost_usd: 0.08,
            session_maximum_exposure_usd: 0.10,
            cost_status: 'actual',
            gate_passed: true,
        });
        expect(report.runs).toHaveLength(2);
        expect(report.runs?.every(run => run.gate_passed)).toBe(true);
        expect(events).toEqual([
            'reserve:1', 'before:1', 'start:1', 'checkpoint:1', 'wait:1',
            'terminal:1', 'reconcile:1',
            'reserve:2', 'before:2', 'start:2', 'checkpoint:2', 'wait:2',
            'terminal:2', 'reconcile:2',
        ]);
        expect(store.reserve).toHaveBeenCalledTimes(2);
        expect(store.terminalize).toHaveBeenCalledTimes(2);
        expect(store.reconcileUsage).toHaveBeenCalledTimes(2);
        const freshContexts = setup.getProfilesBatchOutcomes.mock.calls
            .map(call => call[1])
            .filter(context => !context.resumeRunId);
        expect(freshContexts).toHaveLength(2);
        expect(freshContexts.every(context => (
            context.maxChargeUsd === 0.05
            && context.credentialSlot === SLOT
            && context.actorId === 'apify/instagram-profile-scraper'
        ))).toBe(true);
    });

    it('marks a pre-ID reservation ambiguous and blocks every fresh start', async () => {
        const existing = storedRun(1, 'starting');
        const store = memoryStore([existing]);
        const setup = dependencies({ store });

        const report = await runProfileRepairCanary(options(true), setup.deps);

        expect(report).toMatchObject({
            gate_passed: false,
            cost_status: 'unknown',
            runs: [{
                repetition: 1,
                lifecycle_status: 'ambiguous',
                cost_status: 'unknown',
            }],
        });
        expect(store.markAmbiguous).toHaveBeenCalledOnce();
        expect(store.reserve).not.toHaveBeenCalled();
        expect(setup.getProfilesBatchOutcomes).toHaveBeenCalledTimes(8);
    });

    it('resumes only a confirmed run id and never starts its replacement', async () => {
        const existing = storedRun(1, 'running');
        const store = memoryStore([existing]);
        const setup = dependencies({ store });

        await runProfileRepairCanary(options(true), setup.deps);

        const paidContexts = setup.getProfilesBatchOutcomes.mock.calls
            .map(call => call[1])
            .filter(context => !context.resumeRunId?.startsWith('SourceRun'));
        expect(paidContexts[0].resumeRunId).toBe(existing.runId);
        expect(setup.events.filter(event => event.startsWith('start:'))).toEqual(['start:2']);
        expect(store.checkpointStarted).toHaveBeenCalledTimes(1);
        expect(store.checkpointStarted).toHaveBeenCalledWith(
            expect.objectContaining({ repetition: 2 })
        );
    });

    it('measures a resumed run from its durable provider start timestamp', async () => {
        const resumedAt = Date.parse(NOW) - 120_000;
        const existing = storedRun(1, 'running', {
            runStartedAt: new Date(resumedAt).toISOString(),
        });
        const store = memoryStore([existing]);
        const setup = dependencies({
            store,
            now: () => Date.parse(NOW),
        });

        await runProfileRepairCanary(options(true), setup.deps);

        expect(store.terminalize).toHaveBeenCalledWith(expect.objectContaining({
            repetition: 1,
            latencyMs: 120_000,
        }));
    });

    it('keeps a checkpointed run resumable until a terminal status is observed', async () => {
        const store = memoryStore();
        const setup = dependencies({ store });
        const replay = setup.deps.getProfilesBatchOutcomes;
        setup.deps.getProfilesBatchOutcomes = vi.fn(async (
            usernames: readonly string[],
            context: ProviderCallContext,
            client
        ) => {
            if (context.resumeRunId?.startsWith('SourceRun')) {
                return replay(usernames, context, client);
            }
            await context.onBeforeRunStart?.({
                logicalProvider: 'apify',
                actorId: 'apify/instagram-profile-scraper',
                credentialSlot: SLOT,
                maxChargeUsd: 0.05,
            });
            const runId = 'FreshRun00000001';
            await context.onRunStarted?.(runId);
            await context.onCostRunStarted?.({
                logicalProvider: 'apify',
                actorId: 'apify/instagram-profile-scraper',
                credentialSlot: SLOT,
                maxChargeUsd: 0.05,
                runId,
            });
            throw new Error('SCRAPING_ERROR: terminal status was not observed');
        });

        const report = await runProfileRepairCanary(options(true), setup.deps);

        expect(report).toMatchObject({
            gate_passed: false,
            cost_status: 'conservative',
            runs: [{
                repetition: 1,
                lifecycle_status: 'not_started',
                cost_status: 'conservative',
            }],
        });
        expect(store.rows.get(1)).toMatchObject({ state: 'running' });
        expect(store.terminalize).not.toHaveBeenCalled();
        expect(store.reserve).toHaveBeenCalledTimes(1);
    });

    it('terminalizes a provider error only after the terminal callback', async () => {
        const store = memoryStore();
        const setup = dependencies({ store });
        const replay = setup.deps.getProfilesBatchOutcomes;
        setup.deps.getProfilesBatchOutcomes = vi.fn(async (
            usernames: readonly string[],
            context: ProviderCallContext,
            client
        ) => {
            if (context.resumeRunId?.startsWith('SourceRun')) {
                return replay(usernames, context, client);
            }
            await context.onBeforeRunStart?.({
                logicalProvider: 'apify',
                actorId: 'apify/instagram-profile-scraper',
                credentialSlot: SLOT,
                maxChargeUsd: 0.05,
            });
            const runId = 'FreshRun00000001';
            await context.onRunStarted?.(runId);
            await context.onCostRunStarted?.({
                logicalProvider: 'apify',
                actorId: 'apify/instagram-profile-scraper',
                credentialSlot: SLOT,
                maxChargeUsd: 0.05,
                runId,
            });
            await context.onCostRunFinished?.({
                logicalProvider: 'apify',
                actorId: 'apify/instagram-profile-scraper',
                credentialSlot: SLOT,
                maxChargeUsd: 0.05,
                runId,
                status: 'failed',
                usageTotalUsd: null,
            });
            throw new Error('SCRAPING_ERROR: terminal provider failure');
        });

        const report = await runProfileRepairCanary(options(true), setup.deps);

        expect(report.runs?.[0]).toMatchObject({
            lifecycle_status: 'failed',
            other_failure_count: 15,
        });
        expect(store.terminalize).toHaveBeenCalledOnce();
    });

    it('blocks repetition two after a failed result gate', async () => {
        const store = memoryStore();
        const setup = dependencies({
            store,
            freshOutcomes: usernames => usernames.map((username, index) => index < 13
                ? success(username)
                : incomplete(username)),
        });

        const report = await runProfileRepairCanary(options(true), setup.deps);

        expect(report).toMatchObject({ gate_passed: false });
        expect(report.runs).toHaveLength(1);
        expect(report.runs?.[0]).toMatchObject({
            lifecycle_status: 'failed',
            success_count: 13,
            incomplete_count: 2,
            actual_cost_usd: 0.04,
            cost_status: 'actual',
        });
        expect(report).toMatchObject({ total_actual_cost_usd: 0.04 });
        expect(store.reserve).toHaveBeenCalledTimes(1);
    });

    it('waits for the terminal accounting snapshot to be stable before accepting actual cost', async () => {
        let now = Date.parse(NOW);
        const sleeps: number[] = [];
        const store = memoryStore();
        const setup = dependencies({
            store,
            accounting: () => ({
                status: 'SUCCEEDED',
                usageTotalUsd: 0.04,
                finishedAt: NOW,
            }),
            now: () => now,
            sleep: async ms => {
                sleeps.push(ms);
                now += ms;
            },
        });

        await runProfileRepairCanary(options(true), setup.deps);

        expect(sleeps.reduce((total, value) => total + value, 0))
            .toBeGreaterThanOrEqual(30_000);
        expect(sleeps.reduce((total, value) => total + value, 0))
            .toBeLessThanOrEqual(180_000);
        expect(store.reconcileUsage).toHaveBeenCalledTimes(2);
    });

    it('limits accounting reconciliation to 180 seconds and leaves cost conservative', async () => {
        let now = Date.parse(NOW);
        const sleeps: number[] = [];
        const store = memoryStore();
        const setup = dependencies({
            store,
            accounting: () => ({ status: 'SUCCEEDED' }),
            now: () => now,
            sleep: async ms => {
                sleeps.push(ms);
                now += ms;
            },
        });

        const report = await runProfileRepairCanary(options(true), setup.deps);

        expect(report).toMatchObject({
            gate_passed: false,
            cost_status: 'conservative',
            total_actual_cost_usd: null,
        });
        expect(report.runs).toHaveLength(1);
        expect(report.runs?.[0]).toMatchObject({
            cost_status: 'conservative',
            actual_cost_usd: null,
        });
        expect(sleeps.reduce((total, value) => total + value, 0)).toBeLessThanOrEqual(180_000);
        expect(store.reserve).toHaveBeenCalledTimes(1);
        expect(store.reconcileUsage).not.toHaveBeenCalled();
    });

    it('aborts a never-settling accounting GET at 180 seconds and blocks repetition two', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(Date.parse(NOW));
        try {
            let aborted = false;
            const store = memoryStore();
            const setup = dependencies({
                store,
                now: () => Date.now(),
                sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
                accountingGet: async (_runId, { signal }) => new Promise((_, reject) => {
                    signal.addEventListener('abort', () => {
                        aborted = true;
                        reject(new Error('accounting request aborted'));
                    }, { once: true });
                }),
            });
            const reportPromise = runProfileRepairCanary(options(true), setup.deps);
            const bounded = Promise.race([
                reportPromise.then(report => ({ kind: 'report' as const, report })),
                new Promise<{ kind: 'timeout' }>(resolve => {
                    setTimeout(() => resolve({ kind: 'timeout' }), 180_001);
                }),
            ]);

            await vi.advanceTimersByTimeAsync(180_001);
            const result = await bounded;

            expect(result.kind).toBe('report');
            if (result.kind !== 'report') throw new Error('canary exceeded its accounting deadline');
            expect(result.report).toMatchObject({
                gate_passed: false,
                cost_status: 'conservative',
                total_actual_cost_usd: null,
            });
            expect(result.report.runs).toHaveLength(1);
            expect(result.report.runs?.[0]).toMatchObject({
                repetition: 1,
                actual_cost_usd: null,
                cost_status: 'conservative',
            });
            expect(aborted).toBe(true);
            expect(setup.accountingGet).toHaveBeenCalledTimes(1);
            expect(store.reserve).toHaveBeenCalledTimes(1);
            expect(store.reconcileUsage).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it('cancels a non-success accounting response body without exposing its token', async () => {
        const cancel = vi.fn(async () => undefined);
        const request = vi.fn(async () => ({
            ok: false,
            body: { cancel },
        } as unknown as Response));
        const signal = new AbortController().signal;

        await expect(fetchProfileRepairCanaryAccountingSnapshot(
            'FreshRun00000001',
            { credentialSlot: SLOT, signal },
            { APIFY_TERTIARY_API_TOKEN: 'test-token' },
            request as unknown as typeof fetch
        )).resolves.toBeUndefined();

        expect(cancel).toHaveBeenCalledOnce();
        expect(request).toHaveBeenCalledWith(
            'https://api.apify.com/v2/actor-runs/FreshRun00000001',
            expect.objectContaining({
                method: 'GET',
                redirect: 'error',
                signal,
            })
        );
    });
});
