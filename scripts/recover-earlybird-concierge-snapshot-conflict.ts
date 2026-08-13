import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { preflightTargetInputHash } from '@/lib/services/analysis/preflight-identity';

const uuidSchema = z.string().uuid().transform(value => value.toLowerCase());
const timestampSchema = z.string().datetime({ offset: true });
const rpcRowSchema = z.object({
    applied: z.boolean(),
    fulfillment_status: z.enum([
        'retryable_failure',
        'admission_pending',
        'analysis_in_progress',
        'completed',
    ]),
}).strict();
const rpcRowsSchema = z.array(rpcRowSchema).length(1);
const recoveryInputSchema = z.object({
    orderId: uuidSchema,
    preflightId: uuidSchema,
    expectedManualReviewAt: timestampSchema,
    expectedAdmissionRefreshedAt: timestampSchema,
}).strict();
const recoveryResultSchema = z.object({
    applied: z.boolean(),
    fulfillmentStatus: z.enum([
        'retryable_failure',
        'admission_pending',
        'analysis_in_progress',
        'completed',
    ]),
}).strict();
const targetInstagramIdSchema = z.string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9._]{1,30}$/);
const outputSchema = z.object({
    applied: z.boolean(),
    status: z.enum([
        'retryable_failure',
        'admission_pending',
        'analysis_in_progress',
        'completed',
    ]),
}).strict();

export type ConciergeSnapshotConflictRecoveryInput = z.infer<
    typeof recoveryInputSchema
>;

export interface ConciergeSnapshotConflictRecoveryDependencies {
    recover(input: ConciergeSnapshotConflictRecoveryInput): Promise<unknown>;
    writeStdout(value: string): void;
}

export interface ConciergeSnapshotConflictRecoveryServiceDependencies {
    loadTargetInstagramId(preflightId: string): Promise<unknown>;
    callRecoveryRpc(input: ConciergeSnapshotConflictRecoveryInput & {
        serverTargetInputHash: string;
    }): Promise<unknown>;
    env: Record<string, string | undefined>;
}

export function parseConciergeSnapshotConflictRecoveryArgs(
    args: readonly string[],
): ConciergeSnapshotConflictRecoveryInput {
    const values = new Map<string, string>();
    let confirmed = false;
    for (let index = 0; index < args.length; index += 1) {
        const option = args[index];
        if (option === '--confirm-exact-20260812-1807-basic-snapshot-conflict') {
            if (confirmed) throw new Error('incident confirmation must be provided exactly once');
            confirmed = true;
            continue;
        }
        if (![
            '--order-id',
            '--preflight-id',
            '--expected-manual-review-at',
            '--expected-admission-refreshed-at',
        ].includes(option)) {
            throw new Error(`unknown argument: ${option}`);
        }
        if (values.has(option)) throw new Error(`${option} must be provided exactly once`);
        const value = args[index + 1];
        if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
        values.set(option, value);
        index += 1;
    }
    if (!confirmed || values.size !== 4) {
        throw new Error('all exact recovery arguments and confirmation are required');
    }
    return recoveryInputSchema.parse({
        orderId: values.get('--order-id'),
        preflightId: values.get('--preflight-id'),
        expectedManualReviewAt: values.get('--expected-manual-review-at'),
        expectedAdmissionRefreshedAt: values.get('--expected-admission-refreshed-at'),
    });
}

function defaultServiceDependencies(): ConciergeSnapshotConflictRecoveryServiceDependencies {
    return {
        async loadTargetInstagramId(preflightId) {
            const { data, error } = await supabaseAdmin
                .from('analysis_preflights')
                .select('target_instagram_id')
                .eq('id', preflightId)
                .maybeSingle();
            if (error || !data) {
                throw new Error('CONCIERGE_SNAPSHOT_RECOVERY_TARGET_READ_FAILED');
            }
            return data.target_instagram_id;
        },
        async callRecoveryRpc(input) {
            const { data, error } = await supabaseAdmin.rpc(
                'recover_earlybird_concierge_snapshot_conflict',
                {
                    p_order_id: input.orderId,
                    p_expected_preflight_id: input.preflightId,
                    p_expected_manual_review_at: input.expectedManualReviewAt,
                    p_expected_admission_refreshed_at: input.expectedAdmissionRefreshedAt,
                    p_server_target_input_hash: input.serverTargetInputHash,
                },
            );
            if (error) throw new Error('CONCIERGE_SNAPSHOT_RECOVERY_RPC_FAILED');
            return data;
        },
        env: process.env,
    };
}

export async function recoverWithServiceRole(
    input: ConciergeSnapshotConflictRecoveryInput,
    dependencies: ConciergeSnapshotConflictRecoveryServiceDependencies =
        defaultServiceDependencies(),
) {
    const targetInstagramId = targetInstagramIdSchema.parse(
        await dependencies.loadTargetInstagramId(input.preflightId),
    );
    const serverTargetInputHash = preflightTargetInputHash(
        targetInstagramId,
        dependencies.env,
    );
    const data = await dependencies.callRecoveryRpc({
        ...input,
        serverTargetInputHash,
    });
    const row = rpcRowsSchema.parse(data)[0];
    return recoveryResultSchema.parse({
        applied: row.applied,
        fulfillmentStatus: row.fulfillment_status,
    });
}

function defaultDependencies(): ConciergeSnapshotConflictRecoveryDependencies {
    return {
        recover: recoverWithServiceRole,
        writeStdout: value => process.stdout.write(value),
    };
}

export async function runConciergeSnapshotConflictRecovery(
    args: readonly string[],
    dependencies: ConciergeSnapshotConflictRecoveryDependencies = defaultDependencies(),
) {
    const input = parseConciergeSnapshotConflictRecoveryArgs(args);
    const recovered = recoveryResultSchema.parse(await dependencies.recover(input));
    const output = outputSchema.parse({
        applied: recovered.applied,
        status: recovered.fulfillmentStatus,
    });
    dependencies.writeStdout(`${JSON.stringify(output)}\n`);
    return Object.freeze(output);
}

function isDirectExecution(): boolean {
    const entry = process.argv[1];
    return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
    runConciergeSnapshotConflictRecovery(process.argv.slice(2)).catch(() => {
        process.stderr.write('{"status":"failed","errorCode":"CONCIERGE_SNAPSHOT_RECOVERY_FAILED"}\n');
        process.exitCode = 1;
    });
}
