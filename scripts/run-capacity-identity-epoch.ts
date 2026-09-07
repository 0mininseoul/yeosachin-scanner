/**
 * Safe operator entrypoint for the coordinated capacity identity epoch.
 *
 * No dotenv loading, fixture mode, arbitrary URL, or boolean bypass is
 * supported. The packet and live bootstrap are both private inherited
 * descriptors; bootstrap binds their protected resource scope before any
 * authenticated adapter is constructed. `apply --through VERIFIED` stops at
 * VERIFIED and is separate from the coordinator's proof-bound activation API.
 */
import { canonicalDigest, EpochError, epochFail } from './capacity-identity-epoch/contracts';
import { loadProtectedPacketAsync } from './capacity-identity-epoch/packet';
import { buildLiveBootstrap, loadProtectedLiveBootstrap } from './capacity-identity-epoch/bootstrap';

type Command = 'check' | 'apply';

function fail(code: 'ADAPTER_REQUEST_INVALID' | 'PROTECTED_INPUT_UNAVAILABLE' | 'ACTIVATION_AUTH_REQUIRED' | 'CAPABILITY_BINDING_MISMATCH'): never {
    epochFail(code);
}

function usage(): void {
    process.stdout.write('usage: run-capacity-identity-epoch.ts [check|apply] --packet-fd FD --bootstrap-fd FD [--through VERIFIED]\n');
}

function parseFd(value: string | undefined): number {
    if (value === undefined || !/^\d{1,9}$/.test(value)) fail('ADAPTER_REQUEST_INVALID');
    const fd = Number(value);
    if (!Number.isSafeInteger(fd)) fail('ADAPTER_REQUEST_INVALID');
    return fd;
}

function parseArguments(argv: readonly string[]): Readonly<{ command: Command; packetFd?: number; bootstrapFd?: number; through?: string; help: boolean }> {
    let command: Command = 'check';
    let packetFd: number | undefined;
    let bootstrapFd: number | undefined;
    let through: string | undefined;
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--help' || arg === '-h') return { command, packetFd, bootstrapFd, through, help: true };
        if ((arg === 'check' || arg === 'apply') && index === 0) {
            command = arg;
            continue;
        }
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
        if (arg === '--through') {
            if (through !== undefined || index + 1 >= argv.length) fail('ADAPTER_REQUEST_INVALID');
            through = argv[++index];
            continue;
        }
        fail('ADAPTER_REQUEST_INVALID');
    }
    return { command, packetFd, bootstrapFd, through, help: false };
}

async function run(): Promise<void> {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
        usage();
        return;
    }
    if (options.packetFd === undefined || options.bootstrapFd === undefined) fail('PROTECTED_INPUT_UNAVAILABLE');
    const packet = await loadProtectedPacketAsync({ fd: options.packetFd });
    const bootstrapDescriptor = await loadProtectedLiveBootstrap(options.bootstrapFd);
    const live = buildLiveBootstrap(packet, bootstrapDescriptor);
    if (options.command === 'check') {
        if (options.through !== undefined && options.through !== 'VERIFIED') fail('ADAPTER_REQUEST_INVALID');
        // Adapter construction and packet/resource binding are part of the
        // read-only preflight. No journal header/lock or provider request is
        // written by this command. Missing independent source/ledger/probe
        // channels are a fixed, non-success outcome.
        if (live.missingEvidence.length > 0) fail('PROTECTED_INPUT_UNAVAILABLE');
        process.stdout.write(`CHECK_OK packetDigest=${canonicalDigest(packet)}\n`);
        return;
    }
    if (options.through !== 'VERIFIED') fail('ADAPTER_REQUEST_INVALID');
    if (live.missingEvidence.length > 0) fail('PROTECTED_INPUT_UNAVAILABLE');
    // This path is deliberately closed until the reviewed evidence channels
    // are supplied to the bootstrap descriptor. When supplied, the concrete
    // coordinator runs through VERIFIED; it never calls activation.
    await live.coordinator.runThroughVerified();
}

void run().catch((error: unknown) => {
    if (error instanceof EpochError) {
        process.stderr.write(`${error.code}\n`);
        process.exitCode = 2;
    } else {
        process.stderr.write('ADAPTER_REQUEST_INVALID\n');
        process.exitCode = 2;
    }
});
