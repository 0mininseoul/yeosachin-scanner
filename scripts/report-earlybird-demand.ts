import { pathToFileURL } from 'node:url';
import {
    earlybirdDemandSummarySchema,
    loadEarlybirdDemandSummary,
    parseEarlybirdDemandRange,
    type EarlybirdDemandSummary,
} from '../lib/services/earlybird/demand-report';

export interface EarlybirdDemandCliDependencies {
    loadSummary(range: {
        startDate: string;
        endDateExclusive: string;
    }): Promise<EarlybirdDemandSummary>;
    writeStdout(value: string): void;
}

export type EarlybirdDemandCliResult = Readonly<{
    summary: EarlybirdDemandSummary;
    exitCode: 0 | 1;
}>;

export function parseEarlybirdDemandCliArgs(args: readonly string[]) {
    const values = new Map<string, string>();
    const allowed = new Set(['--start', '--end']);
    for (let index = 0; index < args.length; index += 1) {
        const option = args[index];
        if (!allowed.has(option)) {
            throw new Error(`unknown argument: ${option}`);
        }
        if (values.has(option)) {
            throw new Error(`${option} must be provided exactly once`);
        }
        const value = args[index + 1];
        if (!value || value.startsWith('--')) {
            throw new Error(`${option} requires a value`);
        }
        values.set(option, value);
        index += 1;
    }
    if (!values.has('--start') || !values.has('--end')) {
        throw new Error('--start and --end are required');
    }
    return parseEarlybirdDemandRange({
        startDate: values.get('--start'),
        endDateExclusive: values.get('--end'),
    });
}

function defaultDependencies(): EarlybirdDemandCliDependencies {
    return {
        loadSummary: range => loadEarlybirdDemandSummary(range),
        writeStdout: value => process.stdout.write(value),
    };
}

export async function runEarlybirdDemandReportCli(
    args: readonly string[],
    dependencies: EarlybirdDemandCliDependencies = defaultDependencies()
): Promise<EarlybirdDemandCliResult> {
    const range = parseEarlybirdDemandCliArgs(args);
    const loaded = await dependencies.loadSummary(range);
    const summary = earlybirdDemandSummarySchema.parse(loaded);
    dependencies.writeStdout(`${JSON.stringify(summary, null, 2)}\n`);
    return Object.freeze({
        summary,
        exitCode: summary.unconfirmedPaidOrderCount > 0
            || summary.refundLiabilityCount > 0
            || summary.overdueFulfillmentCount > 0
            ? 1
            : 0,
    });
}

function isDirectExecution(): boolean {
    const entry = process.argv[1];
    return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
    runEarlybirdDemandReportCli(process.argv.slice(2))
        .then(result => {
            process.exitCode = result.exitCode;
        })
        .catch(() => {
            process.stderr.write(`${JSON.stringify({
                status: 'failed',
                errorCode: 'EARLYBIRD_DEMAND_REPORT_FAILED',
            })}\n`);
            process.exitCode = 1;
        });
}
