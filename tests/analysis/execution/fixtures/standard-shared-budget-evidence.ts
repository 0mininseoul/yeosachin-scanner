const scopes = ['run', 'order', 'day'] as const;
type Scope = typeof scopes[number];
const amounts = ['limitUsd', 'settledUsd', 'staleReservedUsd', 'freshReservedUsd', 'requestedUsd'] as const;
type BudgetDetail = Record<typeof amounts[number], number> & { scope: Scope };
type RpcError = { code?: string; message?: string; hint?: string; details?: string };
const pendingHint = 'VERTEX_AI_BUDGET_CAPACITY_PENDING';

function budgetScope(error?: RpcError | null): Scope | null {
    if (error?.code !== 'P0001') return null;
    return scopes.find(scope => error.message?.startsWith('VERTEX_AI_BUDGET_EXCEEDED:' + scope + ':')) ?? null;
}

// PostgreSQL may include original keys in MESSAGE or unrelated error DETAIL.
// Only the rejected scope and a fixed schema of nonnegative monetary totals reach receipts.
function detail(value: unknown, scope: Scope): BudgetDetail | null {
    if (typeof value !== 'string' || value.length > 1024) return null;
    try {
        const row = JSON.parse(value);
        if (!row || row.scope !== scope) return null;
        const result = { scope } as BudgetDetail;
        for (const name of amounts) {
            const raw = row[name];
            const n = typeof raw === 'string' && /^\d{1,15}(\.\d{1,12})?$/.test(raw) ? Number(raw) : raw;
            if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
            result[name] = n;
        }
        return result;
    } catch { return null; }
}

export function safeStandardBudgetRpcFields(name: string, error: RpcError & { detail?: string }) {
    const scope = name === 'reserve_vertex_ai_budget' ? budgetScope(error) : null;
    if (!scope) return {};
    const safe = detail(error.detail, scope);
    return { ...(error.hint === pendingHint ? { hint: pendingHint } : {}),
        ...(safe ? { details: JSON.stringify(safe) } : {}) };
}

type Kind = 'budget_denied' | 'scheduler_policy_mismatch' | 'job_fence_mismatch' | 'terminal_takeover_blocked'
    | 'terminal_worker_response' | 'job_capacity_continuation';
type Incident = {
    kind: Kind; sequence: number; elapsedMs: number;
    budget?: { scope: Scope; capacityPending: boolean; transactionTotals: BudgetDetail | null };
};
type Context = { owner?: string; delivery?: object };
type Recorded = { event: Incident; context: Context };

// The first occurrence of each type survives truncation. Keep keys only in RAM
// for same-owner and same-delivery comparisons, and never serialize them.
export class StandardSharedBudgetEvidence {
    private readonly start = performance.now();
    private sequence = 0;
    private readonly first = new Map<Kind, Recorded>();
    private readonly firstAfterDenial = new Map<Kind, Recorded>();
    private readonly events: Recorded[] = [];
    private readonly totals = new Map<Kind, number>();

    private record(kind: Kind, context: Context, budget?: Incident['budget']) {
        const entry = { event: { kind, sequence: ++this.sequence, elapsedMs: Math.round(performance.now() - this.start), ...(budget ? { budget } : {}) }, context };
        if (this.first.has('budget_denied') && !this.firstAfterDenial.has(kind)) this.firstAfterDenial.set(kind, entry);
        if (!this.first.has(kind)) this.first.set(kind, entry);
        if (this.events.length < 32) this.events.push(entry);
        this.totals.set(kind, (this.totals.get(kind) ?? 0) + 1);
    }

    rpc(name: string, args: Record<string, unknown>, error: RpcError | null, context: Context) {
        if (!error) {
            if (name === 'continue_analysis_v2_scheduler_job' && args.p_error_code === 'ANALYSIS_V2_AI_CAPACITY_PENDING')
                this.record('job_capacity_continuation', context);
            return;
        }
        const scope = name === 'reserve_vertex_ai_budget' ? budgetScope(error) : null;
        if (scope) this.record('budget_denied', context, {
            scope, capacityPending: error.hint === pendingHint, transactionTotals: detail(error.details, scope),
        });
        else if (error.message === 'ANALYSIS_V2_SCHEDULER_OPERATION_POLICY_MISMATCH') this.record('scheduler_policy_mismatch', context);
        else if (error.message === 'ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH') this.record('job_fence_mismatch', context);
        else if (error.message === 'ANALYSIS_V2_TERMINAL_FAILURE_TAKEOVER_NOT_READY') this.record('terminal_takeover_blocked', context);
    }

    terminalWorkerResponse(context: Context) { this.record('terminal_worker_response', context); }

    receipt() {
        const budget = this.first.get('budget_denied');
        const safe = ({ event, context }: Recorded) => ({ ...event,
            sameOwnerAsFirstDenial: context.owner && budget?.context.owner ? context.owner === budget.context.owner : null,
            sameDeliveryAsFirstDenial: context.delivery && budget?.context.delivery ? context.delivery === budget.context.delivery : null,
        });
        return { clock: 'harness_monotonic_rpc_reply', counts: Object.fromEntries(this.totals),
            firstByKind: [...this.first.values()].map(safe), firstAfterDenialByKind: [...this.firstAfterDenial.values()].map(safe),
            events: this.events.map(safe), omittedEvents: this.sequence - this.events.length };
    }
}
