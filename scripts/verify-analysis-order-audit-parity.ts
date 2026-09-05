import { pathToFileURL } from 'node:url';
import { supabaseAdmin } from '../lib/supabase/admin';
import {
    assertPiiSafeConsolidationOutput,
    buildOrderAuditParityAggregate,
    buildOrderAuditParityReport,
    readOrderAuditParitySnapshot,
    type OrderAuditParityAggregate,
    type OrderAuditParityRpcClient,
} from '../lib/services/analysis/order-audit-consolidation';

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_REQUESTS = 20;
const DESTRUCTIVE_OPTIONS = new Set([
    '--execute', '--apply', '--drop', '--truncate', '--rename', '--delete', '--mutate',
]);

export type OrderAuditParityCliOptions = Readonly<{
    requestIds: readonly string[];
    shadowRead: boolean;
    includeArchiveManifest: boolean;
}>;

export function parseOrderAuditParityCliArgs(
    args: readonly string[],
): OrderAuditParityCliOptions {
    const requestIds: string[] = [];
    let shadowRead = false;
    let includeArchiveManifest = false;

    for (let index = 0; index < args.length; index += 1) {
        const option = args[index];
        if (DESTRUCTIVE_OPTIONS.has(option)) {
            throw new Error('destructive mode is not supported');
        }
        if (option === '--shadow-read') {
            if (shadowRead) throw new Error('--shadow-read must appear exactly once');
            shadowRead = true;
            continue;
        }
        if (option === '--archive-manifest') {
            if (includeArchiveManifest) {
                throw new Error('--archive-manifest must appear exactly once');
            }
            includeArchiveManifest = true;
            continue;
        }

        let requestId: string | undefined;
        if (option.startsWith('--request-id=')) {
            requestId = option.slice('--request-id='.length);
        } else if (option === '--request-id') {
            const value = args[index + 1];
            if (!value || value.startsWith('--')) {
                throw new Error('--request-id requires a UUID');
            }
            requestId = value;
            index += 1;
        } else {
            throw new Error('unknown argument');
        }

        if (!requestId || !UUID_PATTERN.test(requestId)) {
            throw new Error('--request-id must be a UUID');
        }
        if (requestIds.includes(requestId)) {
            throw new Error('--request-id must be unique');
        }
        requestIds.push(requestId);
        if (requestIds.length > MAX_REQUESTS) {
            throw new Error('at most 20 request IDs are allowed');
        }
    }

    if (requestIds.length === 0) throw new Error('at least one --request-id is required');
    return {
        requestIds,
        shadowRead,
        includeArchiveManifest,
    };
}

export interface OrderAuditParityCliDependencies {
    readSnapshot(requestId: string): Promise<Awaited<ReturnType<typeof readOrderAuditParitySnapshot>>>;
    writeStdout(value: string): void;
}

function defaultDependencies(): OrderAuditParityCliDependencies {
    return {
        readSnapshot: requestId => readOrderAuditParitySnapshot(
            supabaseAdmin as unknown as OrderAuditParityRpcClient,
            requestId,
        ),
        writeStdout: value => process.stdout.write(value),
    };
}

function outputAggregate(
    aggregate: OrderAuditParityAggregate,
    includeArchiveManifest: boolean,
): Record<string, unknown> {
    if (includeArchiveManifest) return aggregate;
    const { archive: _archive, ...withoutArchive } = aggregate;
    return withoutArchive;
}

export async function runOrderAuditParityCli(
    args: readonly string[],
    dependencies: OrderAuditParityCliDependencies = defaultDependencies(),
): Promise<{ exitCode: 0 | 1; aggregate: OrderAuditParityAggregate }> {
    const options = parseOrderAuditParityCliArgs(args);
    const snapshots = await Promise.all(
        options.requestIds.map(requestId => dependencies.readSnapshot(requestId)),
    );
    const reports = snapshots.map(snapshot => buildOrderAuditParityReport(snapshot));
    const aggregate = buildOrderAuditParityAggregate(
        reports,
        options.shadowRead ? 'shadow-read' : 'parity',
    );
    const output = outputAggregate(aggregate, options.includeArchiveManifest);
    assertPiiSafeConsolidationOutput(output);
    dependencies.writeStdout(`${JSON.stringify(output, null, 2)}\n`);
    return {
        exitCode: aggregate.readiness.status === 'ready-for-separate-approval' ? 0 : 1,
        aggregate,
    };
}

function isDirectExecution(): boolean {
    const entry = process.argv[1];
    return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
    runOrderAuditParityCli(process.argv.slice(2))
        .then(result => {
            process.exitCode = result.exitCode;
        })
        .catch(() => {
            process.stderr.write(`${JSON.stringify({
                status: 'failed',
                errorCode: 'ANALYSIS_ORDER_AUDIT_PARITY_FAILED',
            })}\n`);
            process.exitCode = 1;
        });
}
