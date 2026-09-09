/**
 * Independent read-only post-VERIFIED verifier.
 *
 * The packet/bootstrap descriptors are owner-only inherited FDs. This entry
 * point never loads dotenv, accepts provider URLs, writes the journal, resumes
 * a queue/scheduler, or exposes protected adapter values.
 */
import { pathToFileURL } from 'node:url';
import { EpochError, epochFail } from './capacity-identity-epoch/contracts';
import { buildLiveBootstrap, loadProtectedLiveBootstrap } from './capacity-identity-epoch/bootstrap';
import { loadProtectedPacketAsync } from './capacity-identity-epoch/packet';

function fail(code: 'ADAPTER_REQUEST_INVALID' | 'PROTECTED_INPUT_UNAVAILABLE' | 'EVIDENCE_UNAVAILABLE'): never {
    epochFail(code);
}

function parseFd(value: string | undefined): number {
    if (value === undefined || !/^\d{1,9}$/.test(value)) fail('ADAPTER_REQUEST_INVALID');
    const fd = Number(value);
    if (!Number.isSafeInteger(fd)) fail('ADAPTER_REQUEST_INVALID');
    return fd;
}

function parseArguments(argv: readonly string[]): Readonly<{ packetFd?: number; bootstrapFd?: number; help: boolean }> {
    let packetFd: number | undefined;
    let bootstrapFd: number | undefined;
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--help' || arg === '-h') return { packetFd, bootstrapFd, help: true };
        if (arg === '--packet-fd') {
            if (packetFd !== undefined) fail('ADAPTER_REQUEST_INVALID');
            packetFd = parseFd(argv[++index]);
            continue;
        }
        if (arg === '--bootstrap-fd') {
            if (bootstrapFd !== undefined) fail('ADAPTER_REQUEST_INVALID');
            bootstrapFd = parseFd(argv[++index]);
            continue;
        }
        fail('ADAPTER_REQUEST_INVALID');
    }
    return { packetFd, bootstrapFd, help: false };
}

function usage(): void {
    process.stdout.write('usage: verify-capacity-identity-epoch.ts --packet-fd FD --bootstrap-fd FD\n');
}

export async function verifyCapacityIdentityEpoch(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
    const options = parseArguments(argv);
    if (options.help) {
        usage();
        return;
    }
    if (options.packetFd === undefined || options.bootstrapFd === undefined) fail('PROTECTED_INPUT_UNAVAILABLE');
    const packet = await loadProtectedPacketAsync({ fd: options.packetFd });
    const descriptor = await loadProtectedLiveBootstrap(options.bootstrapFd);
    const live = await buildLiveBootstrap(packet, descriptor, { resolveRetainedHeader: true });
    if (live.missingEvidence.length > 0) fail('EVIDENCE_UNAVAILABLE');
    await live.verifier.verify();
    // Fixed-code-only output: no packet/resource/identity/provider value.
    process.stdout.write('VERIFIED_OK\n');
}

const invokedScript = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedScript) {
    void verifyCapacityIdentityEpoch().catch((error: unknown) => {
        if (error instanceof EpochError) {
            process.stderr.write(`${error.code}\n`);
            process.exitCode = 2;
        } else {
            process.stderr.write('EVIDENCE_UNAVAILABLE\n');
            process.exitCode = 2;
        }
    });
}
