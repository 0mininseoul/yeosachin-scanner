import { pathToFileURL } from 'node:url';
import {
    emptyPrivateSourceReceipt, parsePrivateSourceArgs, privateSourceErrorCode, verifyPrivateSources,
    type PrivateSourceDependencies, type PrivateSourceReceipt,
} from './supabase-private-source';

const HELP = 'verify --manifest <private metadata> --local-only\nverify --manifest <private metadata> --dry-run [--auth=root-env]\n';
export interface PrivateSourceCliDependencies extends PrivateSourceDependencies { writeStdout?: (value: string) => void; }

/** Returns and prints only a fixed safe DTO; raw child output and exceptions never cross this boundary. */
export async function runPrivateSourceCli(
    args: readonly string[], dependencies: PrivateSourceCliDependencies = {},
): Promise<{ exitCode: 0 | 1; receipt: PrivateSourceReceipt | null }> {
    const write = dependencies.writeStdout ?? ((value: string) => { process.stdout.write(value); });
    let receipt: PrivateSourceReceipt;
    try {
        const options = parsePrivateSourceArgs(args);
        if ('help' in options) { write(HELP); return { exitCode: 0, receipt: null }; }
        receipt = await verifyPrivateSources(options, dependencies);
    } catch (error) {
        receipt = emptyPrivateSourceReceipt(dependencies.now);
        receipt.errorCode = privateSourceErrorCode(error);
    }
    write(`${JSON.stringify(receipt)}\n`);
    return { exitCode: receipt.status === 'verified' ? 0 : 1, receipt };
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
    runPrivateSourceCli(process.argv.slice(2)).then(result => { process.exitCode = result.exitCode; }).catch(() => {
        // Output-sink failures also use a fixed enum, without the original exception or path.
        process.stderr.write('{"status":"failed","errorCode":"INTERNAL_FAILURE"}\n');
        process.exitCode = 1;
    });
}
