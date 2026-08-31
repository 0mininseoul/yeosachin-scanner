import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    getPreflightTasksConfig,
    enqueuePrecheckoutBliteTask,
    enqueuePreflightTask,
    lookupPrecheckoutBliteTask,
    lookupPreflightTask,
} from './preflight-tasks';
import {
    getAnalysisV2TasksConfig,
    enqueueAnalysisV2FreshAdmissionTask,
    lookupAnalysisV2FreshAdmissionTask,
} from './v2-tasks';
import {
    ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES,
    markAnalysisV2FreshAdmissionDispatched,
    type AnalysisV2FreshAdmissionRpcClient,
} from './fresh-plan-admission';
import { preflightStore, PREFLIGHT_DATABASE_NAMES } from './preflight';
import { getAnalysisWorkloadRole, type AnalysisWorkloadRole } from './workload-role';

const recoveryLimitSchema = z.number().int().min(1).max(64);
const uuidSchema = z.string().uuid().transform(value => value.toLowerCase());

const ordinaryRowSchema = z.object({
    preflight_id: uuidSchema,
    dispatch_generation: z.number().int().min(1).max(100),
    dispatch_token: uuidSchema,
}).strict();
const bliteRowSchema = ordinaryRowSchema;
const freshRowSchema = z.object({
    preflight_id: uuidSchema,
    user_id: uuidSchema,
    admission_generation: z.number().int().min(1).max(100),
    dispatch_generation: z.number().int().min(1).max(100),
    dispatch_token: uuidSchema,
}).strict();

export const CAPACITY_DISPATCH_RECOVERY_LIMIT = 64;

export interface AnalysisCapacityDispatchRecoverySummary {
    scanned: number;
    recovered: number;
    taskPresent: number;
    skipped: number;
    failed: number;
}

interface RpcClient extends AnalysisV2FreshAdmissionRpcClient {
    rpc(name: string, params?: Record<string, unknown>): Promise<{
        data: unknown;
        error: { message?: string; code?: string } | null;
    }>;
}

function rows<T>(data: unknown, schema: z.ZodType<T>, label: string): T[] {
    const parsed = z.array(schema).safeParse(data);
    if (!parsed.success) {
        throw new Error(`ANALYSIS_CAPACITY_DISPATCH_RECOVERY_ERROR: invalid ${label} rows.`);
    }
    return parsed.data;
}

async function listRows<T>(
    client: RpcClient,
    rpcName: string,
    schema: z.ZodType<T>,
    limit: number,
    label: string,
): Promise<T[]> {
    const { data, error } = await client.rpc(rpcName, { p_limit: limit });
    if (error) {
        throw new Error(`ANALYSIS_CAPACITY_DISPATCH_RECOVERY_ERROR: ${label} list failed.`);
    }
    return rows(data, schema, label);
}

/**
 * Replays only exact reserved/enqueuing dispatch fences.  Unknown create or mark responses leave
 * the row owned by the same generation/token for the next maintenance pass; no cleanup can turn
 * an ambiguous task into an idle row and no successor is created here.
 */
export async function recoverAnalysisCapacityDispatches(
    dependencies: {
        client?: RpcClient;
        limit?: number;
        preflightConfig?: NonNullable<ReturnType<typeof getPreflightTasksConfig>> | null;
        paidConfig?: NonNullable<ReturnType<typeof getAnalysisV2TasksConfig>> | null;
        lookupPreflight?: typeof lookupPreflightTask;
        lookupBlite?: typeof lookupPrecheckoutBliteTask;
        lookupFresh?: typeof lookupAnalysisV2FreshAdmissionTask;
        enqueuePreflight?: typeof enqueuePreflightTask;
        enqueueBlite?: typeof enqueuePrecheckoutBliteTask;
        enqueueFresh?: typeof enqueueAnalysisV2FreshAdmissionTask;
        workloadRole?: AnalysisWorkloadRole;
        env?: Record<string, string | undefined>;
        markPreflight?: (input: {
            preflightId: string;
            generation: number;
            reservationToken: string;
        }) => Promise<boolean | undefined>;
        markBlite?: (input: {
            preflightId: string;
            dispatchToken: string;
        }) => Promise<boolean | undefined>;
        markFresh?: (input: {
            preflightId: string;
            userId: string;
            generation: number;
            dispatchGeneration: number;
            dispatchToken: string;
        }) => Promise<'marked' | 'already_marked'>;
    } = {},
): Promise<AnalysisCapacityDispatchRecoverySummary> {
    const client = dependencies.client ?? (supabaseAdmin as unknown as RpcClient);
    const limit = dependencies.limit ?? CAPACITY_DISPATCH_RECOVERY_LIMIT;
    recoveryLimitSchema.parse(limit);
    // A maintenance invocation belongs to exactly one worker role.  It must never discover or
    // enqueue both queues: doing so would turn the recovery service into a cross-role IAM bridge.
    const workloadRole = dependencies.workloadRole
        ?? getAnalysisWorkloadRole(dependencies.env ?? process.env);
    const preflightConfig = workloadRole === 'preflight'
        ? (dependencies.preflightConfig === undefined
            ? getPreflightTasksConfig(dependencies.env ?? process.env)
            : dependencies.preflightConfig)
        : null;
    const paidConfig = workloadRole === 'paid'
        ? (dependencies.paidConfig === undefined
            ? getAnalysisV2TasksConfig(dependencies.env ?? process.env)
            : dependencies.paidConfig)
        : null;
    const summary: AnalysisCapacityDispatchRecoverySummary = {
        scanned: 0,
        recovered: 0,
        taskPresent: 0,
        skipped: 0,
        failed: 0,
    };

    if (preflightConfig) {
        const ordinary = await listRows(
            client,
            PREFLIGHT_DATABASE_NAMES.providerCapacityRecoveryListRpc,
            ordinaryRowSchema,
            limit,
            'ordinary preflight dispatch recovery',
        );
        summary.scanned += ordinary.length;
        for (const row of ordinary) {
            try {
                const lookup = dependencies.lookupPreflight ?? lookupPreflightTask;
                const enqueue = dependencies.enqueuePreflight ?? enqueuePreflightTask;
                let present = await lookup(row.preflight_id, row.dispatch_generation, {
                    config: preflightConfig,
                });
                if (present === 'not_found') {
                    try {
                        await enqueue(row.preflight_id, row.dispatch_generation, {
                            config: preflightConfig,
                            reservationToken: row.dispatch_token,
                        });
                    } catch (error) {
                        // Keep the exact reserved generation/token even for a terminal create
                        // refusal.  The legacy dispatch constraint disallows resetting a
                        // generation-bearing row to unreserved; a later maintenance pass retries
                        // the same deterministic identity after the cause is corrected.
                        if (await lookup(
                            row.preflight_id,
                            row.dispatch_generation,
                            { config: preflightConfig },
                        ) !== 'exists') {
                            summary.failed += 1;
                            continue;
                        }
                    }
                    present = 'exists';
                } else {
                    summary.taskPresent += 1;
                }
                if (present !== 'exists') throw new Error('task not confirmed');
                const mark = dependencies.markPreflight ?? (async (input: {
                    preflightId: string;
                    generation: number;
                    reservationToken: string;
                }) => preflightStore.markProviderCapacityDispatch?.(input));
                let marked: boolean | undefined;
                try {
                    marked = await mark({
                        preflightId: row.preflight_id,
                        generation: row.dispatch_generation,
                        reservationToken: row.dispatch_token,
                    });
                } catch (error) {
                    // mark may have committed before its response was lost.  Confirm the exact
                    // task and replay the same fenced mark, leaving the reservation untouched
                    // when lookup cannot prove that task identity.
                    if (await lookup(
                        row.preflight_id,
                        row.dispatch_generation,
                        { config: preflightConfig },
                    ) !== 'exists') throw error;
                    marked = await mark({
                        preflightId: row.preflight_id,
                        generation: row.dispatch_generation,
                        reservationToken: row.dispatch_token,
                    });
                }
                if (marked === true) {
                    summary.recovered += 1;
                } else {
                    summary.failed += 1;
                }
            } catch {
                summary.failed += 1;
            }
        }

        const blite = await listRows(
            client,
            PREFLIGHT_DATABASE_NAMES.bliteDispatchRecoveryListRpc,
            bliteRowSchema,
            limit,
            'B-lite dispatch recovery',
        );
        summary.scanned += blite.length;
        for (const row of blite) {
            try {
                const lookup = dependencies.lookupBlite ?? lookupPrecheckoutBliteTask;
                const enqueue = dependencies.enqueueBlite ?? enqueuePrecheckoutBliteTask;
                let present = await lookup(row.preflight_id, {
                    config: preflightConfig,
                    dispatchGeneration: row.dispatch_generation,
                });
                if (present === 'not_found') {
                    try {
                        await enqueue(row.preflight_id, {
                            config: preflightConfig,
                            dispatchGeneration: row.dispatch_generation,
                            dispatchToken: row.dispatch_token,
                        });
                    } catch (error) {
                        // Keep the exact enqueuing generation/token for every create failure.
                        // Even a typed terminal response can follow a committed deterministic
                        // task; an idle transition would strand accepted B-lite work.
                        if (await lookup(row.preflight_id, {
                            config: preflightConfig,
                            dispatchGeneration: row.dispatch_generation,
                        }) !== 'exists') {
                            summary.failed += 1;
                            continue;
                        }
                    }
                    present = 'exists';
                } else {
                    summary.taskPresent += 1;
                }
                if (present !== 'exists') throw new Error('task not confirmed');
                const mark = dependencies.markBlite ?? (async (input: {
                    preflightId: string;
                    dispatchGeneration: number;
                    dispatchToken: string;
                }) => preflightStore.markBliteDispatchEnqueued?.(input));
                let marked: boolean | undefined;
                try {
                    marked = await mark({
                        preflightId: row.preflight_id,
                        dispatchGeneration: row.dispatch_generation,
                        dispatchToken: row.dispatch_token,
                    });
                } catch (error) {
                    if (await lookup(row.preflight_id, {
                        config: preflightConfig,
                        dispatchGeneration: row.dispatch_generation,
                    }) !== 'exists') throw error;
                    marked = await mark({
                        preflightId: row.preflight_id,
                        dispatchGeneration: row.dispatch_generation,
                        dispatchToken: row.dispatch_token,
                    });
                }
                if (marked === true) {
                    summary.recovered += 1;
                } else {
                    summary.failed += 1;
                }
            } catch {
                summary.failed += 1;
            }
        }
    }

    if (paidConfig) {
        const fresh = await listRows(
            client,
            ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.dispatchRecoveryListRpc,
            freshRowSchema,
            limit,
            'fresh admission dispatch recovery',
        );
        summary.scanned += fresh.length;
        for (const row of fresh) {
            try {
                const lookup = dependencies.lookupFresh ?? lookupAnalysisV2FreshAdmissionTask;
                const enqueue = dependencies.enqueueFresh ?? enqueueAnalysisV2FreshAdmissionTask;
                let present = await lookup({
                    preflightId: row.preflight_id,
                    generation: row.admission_generation,
                    dispatchGeneration: row.dispatch_generation,
                }, { config: paidConfig });
                if (present === 'not_found') {
                    try {
                        await enqueue({
                            preflightId: row.preflight_id,
                            kind: 'fresh_admission',
                            workloadRole: 'paid',
                            generation: row.admission_generation,
                            dispatchGeneration: row.dispatch_generation,
                            dispatchToken: row.dispatch_token,
                        }, { config: paidConfig });
                    } catch (error) {
                        // Preserve every generation-bearing fence: task creation can commit
                        // before either terminal or transport responses are observed.
                        if (await lookup({
                            preflightId: row.preflight_id,
                            generation: row.admission_generation,
                            dispatchGeneration: row.dispatch_generation,
                        }, { config: paidConfig }) !== 'exists') {
                            summary.failed += 1;
                            continue;
                        }
                    }
                    present = 'exists';
                } else {
                    summary.taskPresent += 1;
                }
                if (present !== 'exists') throw new Error('task not confirmed');
                const mark = dependencies.markFresh ?? ((input: {
                    preflightId: string;
                    userId: string;
                    generation: number;
                    dispatchGeneration: number;
                    dispatchToken: string;
                }) => markAnalysisV2FreshAdmissionDispatched(client, input));
                let marked: 'marked' | 'already_marked';
                try {
                    marked = await mark({
                    preflightId: row.preflight_id,
                    userId: row.user_id,
                    generation: row.admission_generation,
                    dispatchGeneration: row.dispatch_generation,
                    dispatchToken: row.dispatch_token,
                    });
                } catch (error) {
                    if (await lookup({
                        preflightId: row.preflight_id,
                        generation: row.admission_generation,
                        dispatchGeneration: row.dispatch_generation,
                    }, { config: paidConfig }) !== 'exists') throw error;
                    marked = await mark({
                        preflightId: row.preflight_id,
                        userId: row.user_id,
                        generation: row.admission_generation,
                        dispatchGeneration: row.dispatch_generation,
                        dispatchToken: row.dispatch_token,
                    });
                }
                if (marked === 'marked' || marked === 'already_marked') {
                    summary.recovered += 1;
                } else {
                    summary.failed += 1;
                }
            } catch {
                summary.failed += 1;
            }
        }
    }
    summary.skipped = (preflightConfig ? 0 : 1) + (paidConfig ? 0 : 1);
    return summary;
}
