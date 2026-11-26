import { AsyncLocalStorage } from 'node:async_hooks';
import type { StandardConnection } from './standard-database';

const cutoffReasons = new Set(['resolver_handler_deadline', 'resolver_capacity_continuation',
    'resolver_deadline_continuation', 'resolver_required_error', 'resolver_batch_barrier']);

type Observation = 'wire' | 'abort' | 'waitAborted' | 'generated' | 'sdkReturned' | 'sdkRejected' | 'usageRead';
interface Trace {
    key?: string;
    signal?: AbortSignal;
    onAbort?: () => void;
    sends: number;
    fixedUsage: boolean;
    marks: Partial<Record<Observation, { sequence: number; ms: number }>>;
}
interface LedgerRow extends Record<string, unknown> {
    requestId?: string;
    uncostedTerminal?: boolean;
    key: string;
    status: string | null;
    holds: number;
    unknown: number;
    known: number;
    cancelled: number;
}
type CostState = 'unknown' | 'known' | 'cancelled' | 'missing' | 'other';

function costState(row: LedgerRow): CostState {
    if (!row.holds) return 'missing';
    if (row.unknown === 1 && row.holds === 1) return 'unknown';
    if (row.known === 1 && row.holds === 1) return 'known';
    if (row.cancelled === row.holds) return 'cancelled';
    return 'other';
}

function before(trace: Trace, first: Observation, second: Observation) {
    const a = trace.marks[first], b = trace.marks[second];
    return !!a && (!b || a.sequence < b.sequence);
}

function relativeToCutoff(trace: Trace, event: Observation) {
    if (!trace.marks[event]) return 'notObserved';
    if (!trace.marks.abort) return 'noCutoffObserved';
    return before(trace, event, 'abort') ? 'before' : 'after';
}

function receiptOrder(trace: Trace, cost: CostState) {
    return {
        cost,
        generated: relativeToCutoff(trace, 'generated'),
        sdkReturned: relativeToCutoff(trace, 'sdkReturned'),
        usageRead: relativeToCutoff(trace, 'usageRead'),
    };
}

function outcome(trace: Trace) {
    const marks = trace.marks;
    if (!trace.sends) {
        if (!marks.sdkRejected) return 'incompleteObservation';
        return before(trace, 'abort', 'sdkRejected') ? 'abortedBeforeWire' : 'rejectedBeforeWireWithoutObservedAbort';
    }
    if (marks.waitAborted && marks.sdkRejected && before(trace, 'abort', 'waitAborted')) return 'abortedDuringResponseWait';
    if (marks.sdkRejected) return 'sdkRejectedOther';
    if (!marks.sdkReturned || !marks.generated) return 'incompleteObservation';
    if (!trace.fixedUsage) return 'missingOrUnexpectedFixtureUsage';
    if (marks.usageRead) return before(trace, 'usageRead', 'abort') ? 'usageReadBeforeCutoffOrNoCutoff' : 'usageReadAfterCutoff';
    if (before(trace, 'abort', 'sdkReturned')) return 'sdkReturnedAfterCutoffUsageUnread';
    return marks.abort ? 'sdkReturnedBeforeCutoffUsageUnread' : 'sdkReturnedUsageUnreadWithoutCutoff';
}

// Only the shared fixture's SDK calls enter this scope. Identity stays in memory until SQL reconciliation.
export class SharedResolverObservation {
    private readonly context = new AsyncLocalStorage<Trace>();
    private readonly traces: Trace[] = [];
    private sequence = 0;

    private mark(trace: Trace, event: Observation) {
        trace.marks[event] ??= { sequence: ++this.sequence, ms: performance.now() };
    }

    sdk<T>(signal: AbortSignal | undefined, generate: () => Promise<T>): Promise<T> {
        const trace: Trace = { signal, sends: 0, fixedUsage: false, marks: {} };
        trace.onAbort = () => this.mark(trace, 'abort');
        if (signal?.aborted) trace.onAbort();
        else signal?.addEventListener('abort', trace.onAbort, { once: true });
        this.traces.push(trace);
        return this.context.run(trace, async () => {
            try {
                const response = await generate();
                this.mark(trace, 'sdkReturned');
                return response;
            } catch (error) {
                this.mark(trace, 'sdkRejected');
                throw error;
            }
        });
    }

    bindReservation(request: string, operation: string, attempt: number) {
        const trace = this.context.getStore();
        if (trace) trace.key = [request, operation, attempt].join('/');
    }

    wire() {
        const trace = this.context.getStore();
        if (trace) {
            trace.sends++;
            this.mark(trace, 'wire');
        }
    }

    waitRejected(error: unknown) {
        const trace = this.context.getStore();
        if (trace?.signal?.aborted && error instanceof Error && error.name === 'AbortError') this.mark(trace, 'waitAborted');
    }

    response<T extends { usageMetadata?: unknown }>(reply: T): T {
        const trace = this.context.getStore();
        if (!trace) return reply;
        this.mark(trace, 'generated');
        // The fixture always returns these four counts on a normal response. Observe the
        // caller's actual getter read separately from merely constructing an SDK response.
        const usage = reply.usageMetadata as Record<string, unknown> | undefined;
        trace.fixedUsage = usage?.promptTokenCount === 24 && usage.candidatesTokenCount === 12
            && usage.thoughtsTokenCount === 0 && usage.totalTokenCount === 36;
        Object.defineProperty(reply, 'usageMetadata', { enumerable: true, configurable: true, get: () => {
            this.mark(trace, 'usageRead');
            return usage;
        } });
        return reply;
    }

    sdkSnapshot() {
        const events: Record<Observation, number> = { wire: 0, abort: 0, waitAborted: 0, generated: 0, sdkReturned: 0, sdkRejected: 0, usageRead: 0 };
        let wireSends = 0;
        for (const trace of this.traces) {
            wireSends += trace.sends;
            for (const event of Object.keys(events) as Observation[]) {
                if (trace.marks[event]) events[event]++;
            }
        }
        return { sdkEntries: this.traces.length, wireSends, events };
    }

    dispose() {
        for (const trace of this.traces) {
            if (trace.onAbort) trace.signal?.removeEventListener('abort', trace.onAbort);
        }
    }

    report(rows: LedgerRow[], requestOrder: readonly string[] = []) {
        const unsentCancelledByOwner = requestOrder.map(() => 0);
        const indexed = new Map<string, Trace[]>();
        const issues = { duplicateSends: 0, duplicateBindings: 0, unboundSends: 0, missingSdkTrace: 0,
            missingAttemptRow: 0, unmatchedBudget: 0, inconsistentSettlement: 0, incompleteObservation: 0,
            invalidFixtureUsage: 0, invalidResponseOrder: 0, lateKnownSettlement: 0 };
        const cutoffByCost: Record<CostState, Record<string, number>> = { unknown: {}, known: {}, cancelled: {}, missing: {}, other: {} };
        const cutoffReasonsByCost: Record<string, number> = {};
        const orderGroups = new Map<string, ReturnType<typeof receiptOrder> & { count: number }>();
        let unboundWithoutSend = 0, durableAttempts = 0, cutoffs = 0, budgetOnlyCancelled = 0;
        const wireToAbortMs = { count: 0, total: 0, max: 0 };
        for (const trace of this.traces) {
            if (trace.marks.generated && !trace.fixedUsage) issues.invalidFixtureUsage++;
            if ((trace.marks.sdkReturned && !before(trace, 'generated', 'sdkReturned'))
                || (trace.marks.usageRead && !before(trace, 'sdkReturned', 'usageRead'))) issues.invalidResponseOrder++;
            issues.duplicateSends += Math.max(0, trace.sends - 1);
            if (!trace.key) {
                if (trace.sends) issues.unboundSends += trace.sends;
                else unboundWithoutSend++;
                continue;
            }
            const group = indexed.get(trace.key) ?? [];
            group.push(trace);
            indexed.set(trace.key, group);
        }
        for (const row of rows) {
            const group = indexed.get(row.key) ?? [];
            indexed.delete(row.key);
            const cost = costState(row);
            if (!row.status) {
                if (cost === 'cancelled') budgetOnlyCancelled++;
                else issues.unmatchedBudget++;
                issues.missingAttemptRow += group.length;
                continue;
            }
            durableAttempts++;
            const isCutoff = row.status === 'cutoff';
            if (isCutoff) cutoffs++;
            if (!group.length) issues.missingSdkTrace++;
            issues.duplicateBindings += Math.max(0, group.length - 1);
            const trace = group.length === 1 ? group[0] : undefined;
            const kind = trace ? outcome(trace) : 'unmatchedObservation';
            if (isCutoff) cutoffByCost[cost][kind] = (cutoffByCost[cost][kind] ?? 0) + 1;
            if (!trace) continue;
            if (isCutoff && row.holds === 1 && cost === 'cancelled' && row.uncostedTerminal
                && kind === 'abortedBeforeWire' && !trace.marks.generated && !trace.marks.usageRead) {
                const index = row.requestId ? requestOrder.indexOf(row.requestId) : -1;
                if (index >= 0) unsentCancelledByOwner[index]++;
            }
            if (isCutoff) {
                const supplied = trace.signal?.reason;
                const reason = typeof supplied === 'string' && cutoffReasons.has(supplied) ? supplied : 'unobserved';
                const cause = cost + '.' + reason;
                cutoffReasonsByCost[cause] = (cutoffReasonsByCost[cause] ?? 0) + 1;
                const order = receiptOrder(trace, cost);
                const key = JSON.stringify(order);
                const group = orderGroups.get(key);
                if (group) group.count++;
                else orderGroups.set(key, { ...order, count: 1 });
            }
            if (kind === 'incompleteObservation' || kind === 'sdkReturnedUsageUnreadWithoutCutoff') issues.incompleteObservation++;
            // Record a late or missing usage receipt as unknown. An unknown charge after
            // a complete on-time receipt, or any charge for an unsent call, is a discrepancy.
            const returnedBeforeCutoff = before(trace, 'sdkReturned', 'abort');
            const knownExpected = trace.fixedUsage && !!trace.marks.usageRead && returnedBeforeCutoff;
            if (cost === 'known' && trace.marks.sdkReturned && !returnedBeforeCutoff) issues.lateKnownSettlement++;
            if (cost === 'missing' || cost === 'other' || (trace.sends === 0) !== (cost === 'cancelled')
                || knownExpected !== (cost === 'known')) issues.inconsistentSettlement++;
            if (isCutoff && before(trace, 'wire', 'abort') && trace.marks.abort) {
                const ms = Math.round(trace.marks.abort.ms - trace.marks.wire!.ms);
                wireToAbortMs.count++;
                wireToAbortMs.total += ms;
                wireToAbortMs.max = Math.max(wireToAbortMs.max, ms);
            }
        }
        for (const group of indexed.values()) issues.missingAttemptRow += group.length;
        return { ...this.sdkSnapshot(), durableAttempts, unboundWithoutSend, budgetOnlyCancelled,
            cutoffs, cutoffByCost, cutoffReasonsByCost, unsentCancelledByOwner, cutoffReceiptOrder: [...orderGroups.values()], wireToAbortMs, issues };
    }
}

export async function readSharedResolverLedger(db: StandardConnection, requests: string[] | null): Promise<LedgerRow[]> {
    const { rows } = await db.query<LedgerRow>(`
        WITH attempts AS (
            SELECT request_id::text AS run, operation_key, attempt, status,
                (terminalized_at IS NOT NULL AND usage_complete IS FALSE AND estimated_cost_usd IS NULL
                    AND total_tokens IS NULL AND prompt_tokens IS NULL AND completion_tokens IS NULL AND thinking_tokens IS NULL) AS uncosted
            FROM analysis_v2_ai_attempts
            WHERE ($1::uuid[] IS NULL OR request_id=ANY($1::uuid[])) AND stage='genderResolution'
        ), budget AS (
            SELECT run_id AS run, operation_key, attempt, count(*)::int AS holds,
                count(*) FILTER (WHERE state='settled' AND usage_unknown AND actual_cost_usd IS NULL)::int AS unknown,
                count(*) FILTER (WHERE state='settled' AND NOT usage_unknown AND actual_cost_usd>0)::int AS known,
                count(*) FILTER (WHERE state='cancelled' AND actual_cost_usd IS NULL)::int AS cancelled
            FROM vertex_ai_budget_reservations WHERE ($1::uuid[] IS NULL OR run_id=ANY($1::uuid[]::text[])) AND operation_key LIKE 'gender-resolution:%'
            GROUP BY run_id,operation_key,attempt
        )
        SELECT concat_ws('/',run,operation_key,attempt) AS key,run AS "requestId",a.status, a.uncosted AS "uncostedTerminal",
            coalesce(b.holds,0)::int AS holds, coalesce(b.unknown,0)::int AS unknown,
            coalesce(b.known,0)::int AS known, coalesce(b.cancelled,0)::int AS cancelled
        FROM attempts a FULL JOIN budget b USING (run,operation_key,attempt)
    `, [requests]);
    return rows;
}
