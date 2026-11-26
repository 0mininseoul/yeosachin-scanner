import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { sharedStandardStopEvidence } from './standard-shared-measurements';
import { SharedResolverObservation } from './standard-shared-resolver-observation';

const usage = { promptTokenCount: 24, candidatesTokenCount: 12, thoughtsTokenCount: 0, totalTokenCount: 36 };
const aborted = () => Object.assign(new Error(), { name: 'AbortError' });
function ledger(operation: string, charge: 'unknown' | 'known' | 'cancelled') {
    return { key: 'synthetic/' + operation + '/1', status: 'cutoff', holds: 1,
        unknown: Number(charge === 'unknown'), known: Number(charge === 'known'), cancelled: Number(charge === 'cancelled') };
}

it('counts exact cutoff receipts across overlapping SDK calls without exporting their identities', async () => {
    const observation = new SharedResolverObservation();
    const before = new AbortController(), during = new AbortController(), late = new AbortController(), received = new AbortController();
    await Promise.all([
        observation.sdk(before.signal, async () => {
            observation.bindReservation('synthetic', 'one', 1);
            before.abort();
            throw aborted();
        }).catch(() => undefined),
        observation.sdk(during.signal, async () => {
            observation.bindReservation('synthetic', 'two', 1);
            observation.wire();
            await Promise.resolve();
            during.abort();
            const error = aborted();
            observation.waitRejected(error);
            throw error;
        }).catch(() => undefined),
        observation.sdk(late.signal, async () => {
            observation.bindReservation('synthetic', 'three', 1);
            observation.wire();
            late.abort();
            return observation.response({ usageMetadata: usage });
        }),
        observation.sdk(received.signal, async () => {
            observation.bindReservation('synthetic', 'four', 1);
            observation.wire();
            return observation.response({ usageMetadata: usage });
        }).then(response => {
            expect(response.usageMetadata).toBe(usage);
            received.abort();
        }),
    ]);
    const report = observation.report([ledger('one', 'cancelled'), ledger('two', 'unknown'), ledger('three', 'unknown'), ledger('four', 'known')]);
    expect(report).toMatchObject({ durableAttempts: 4, wireSends: 3, cutoffs: 4, cutoffByCost: {
        cancelled: { abortedBeforeWire: 1 }, unknown: { abortedDuringResponseWait: 1, sdkReturnedAfterCutoffUsageUnread: 1 },
        known: { usageReadBeforeCutoffOrNoCutoff: 1 },
    }, events: { abort: 4, waitAborted: 1, sdkReturned: 2, sdkRejected: 2, usageRead: 1 } });
    expect(Object.entries(report.issues).filter(([, count]) => count !== 0)).toEqual([]);
    expect(JSON.stringify(report)).not.toContain('synthetic/');
});

it('flags missing attempts, duplicate sends and an unknown settlement after full usage was read', async () => {
    const observation = new SharedResolverObservation();
    const result = await observation.sdk(undefined, async () => {
        observation.bindReservation('synthetic', 'early', 1);
        observation.wire();
        observation.wire();
        return observation.response({ usageMetadata: usage });
    });
    expect(result.usageMetadata).toBe(usage);
    await observation.sdk(undefined, async () => {
        observation.bindReservation('synthetic', 'orphan', 1);
        observation.wire();
    });
    const report = observation.report([ledger('early', 'unknown'), ledger('missing', 'unknown')]);
    expect(report.issues).toMatchObject({ duplicateSends: 1, missingSdkTrace: 1, missingAttemptRow: 1, inconsistentSettlement: 1 });
});

it('separates generation, SDK return and usage read across cutoff and rejects a known charge for a late SDK response', async () => {
    const observation = new SharedResolverObservation();
    const between = new AbortController(), afterReturn = new AbortController(), early = new AbortController();
    const generatedOnTime = await observation.sdk(between.signal, async () => {
        observation.bindReservation('synthetic', 'late-return', 1);
        observation.wire();
        const reply = observation.response({ usageMetadata: usage });
        between.abort();
        return reply;
    });
    expect(generatedOnTime.usageMetadata).toBe(usage);
    const returnedOnTime = await observation.sdk(afterReturn.signal, async () => {
        observation.bindReservation('synthetic', 'late-read', 1);
        observation.wire();
        return observation.response({ usageMetadata: usage });
    });
    afterReturn.abort();
    expect(returnedOnTime.usageMetadata).toBe(usage);
    await observation.sdk(early.signal, async () => {
        observation.bindReservation('synthetic', 'malformed', 1);
        observation.wire();
        early.abort();
        return observation.response({ usageMetadata: { ...usage, totalTokenCount: 37 } });
    });
    const report = observation.report([ledger('late-return', 'known'), ledger('late-read', 'known'), ledger('malformed', 'unknown')]);
    expect(report.cutoffReceiptOrder).toEqual(expect.arrayContaining([
        { cost: 'known', generated: 'before', sdkReturned: 'after', usageRead: 'after', count: 1 },
        { cost: 'known', generated: 'before', sdkReturned: 'before', usageRead: 'after', count: 1 },
        { cost: 'unknown', generated: 'after', sdkReturned: 'after', usageRead: 'notObserved', count: 1 },
    ]));
    expect(report.issues).toMatchObject({ inconsistentSettlement: 1, lateKnownSettlement: 1, invalidFixtureUsage: 1, invalidResponseOrder: 0 });
});

it('preserves SDK evidence and exact unknown estimates even when unrelated failure diagnostics cannot be queried', async () => {
    const db = await PGlite.create();
    const observation = new SharedResolverObservation();
    try {
        // This intentionally incomplete database reproduces a failure before all diagnostic
        // surfaces exist. Keep different pending, known and non-resolver amounts in the control.
        await db.exec(`
            CREATE TABLE vertex_ai_budget_reservations (run_id text, operation_key text, attempt int, state text,
                usage_unknown boolean, actual_cost_usd numeric, estimated_cost_usd numeric);
            INSERT INTO vertex_ai_budget_reservations VALUES
                ('synthetic','gender-resolution:a',1,'settled',true,NULL,0.00001025),
                ('synthetic','gender-resolution:b',1,'settled',true,NULL,0.00001025),
                ('synthetic','feature:c',1,'settled',true,NULL,0.0000305),
                ('synthetic','gender-resolution:d',1,'reserved',true,NULL,1.0),
                ('synthetic','gender-resolution:e',1,'settled',false,0.001,2.0);
        `);
        await observation.sdk(undefined, async () => {
            observation.wire();
            return observation.response({ usageMetadata: usage });
        });
        const partial = await sharedStandardStopEvidence(db, observation);
        expect(partial.diagnosticsUnavailable).toEqual(['pipeline_summary', 'resolver_ledger']);
        expect(partial.resolverEvidence).toMatchObject({ coverage: 'sdk_only', sdkEntries: 1, wireSends: 1 });
        expect(partial.settledUnknownBudget).toEqual({ count: 3, estimatedMicros: 51, resolverCount: 2, resolverEstimatedMicros: 21 });

        await db.exec('CREATE TABLE analysis_v2_ai_attempts(request_id uuid, operation_key text, attempt int, status text, stage text, terminalized_at timestamptz, usage_complete boolean, estimated_cost_usd numeric, total_tokens int, prompt_tokens int, completion_tokens int, thinking_tokens int)');
        const joined = await sharedStandardStopEvidence(db, observation);
        expect(joined.diagnosticsUnavailable).toEqual(['pipeline_summary']);
        expect(joined.resolverEvidence).toMatchObject({ coverage: 'database_and_sdk', sdkEntries: 1 });

        await db.exec('DROP TABLE vertex_ai_budget_reservations');
        const missing = await sharedStandardStopEvidence(db, observation);
        expect(missing.diagnosticsUnavailable).toEqual(['pipeline_summary', 'resolver_ledger', 'unknown_budget']);
        expect(missing.settledUnknownBudget).toBeNull();
        expect(missing.resolverEvidence.coverage).toBe('sdk_only');
    } finally {
        observation.dispose();
        await db.close();
    }
});

it('counts only a unique uncosted cutoff rejected before wire for its own request', async () => {
    const observation = new SharedResolverObservation();
    const owner = 'synthetic';
    const rows = [];
    for (const operation of ['cancel', 'sent', 'unproven', 'duplicate-hold']) {
        const controller = new AbortController();
        await expect(observation.sdk(controller.signal, async () => {
            observation.bindReservation(owner, operation, 1);
            if (operation === 'sent') observation.wire();
            controller.abort('resolver_handler_deadline');
            throw aborted();
        })).rejects.toThrow();
        rows.push({ ...ledger(operation, 'cancelled'), requestId: owner, uncostedTerminal: operation !== 'unproven',
            holds: operation === 'duplicate-hold' ? 2 : 1 });
    }
    const evidence = observation.report(rows, ['other', owner]);
    expect(evidence.unsentCancelledByOwner).toEqual([0, 1]);
    expect(evidence.issues.inconsistentSettlement).toBeGreaterThan(0);
    expect(evidence.cutoffReasonsByCost['cancelled.resolver_handler_deadline']).toBeGreaterThan(0);
    observation.dispose();
});
