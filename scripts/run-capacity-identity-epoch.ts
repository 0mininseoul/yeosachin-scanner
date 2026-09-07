/**
 * Safe operator entrypoint for the coordinated capacity identity epoch.
 *
 * This command intentionally has no dotenv loading and no fixture mode.  A
 * read-only check requires a protected inherited packet descriptor.  Apply is
 * an explicit, separately reviewed operation and refuses to construct a live
 * mutation path until protected adapter descriptors are supplied by the
 * operator integration.  In particular, no arbitrary URL, boolean bypass, or
 * serialized capability can authorize a run.
 */
import { fstatSync, readSync } from 'node:fs';
import { canonicalDigest, EpochError, epochFail, hasExactKeys, isObject } from './capacity-identity-epoch/contracts';
import { loadProtectedPacket } from './capacity-identity-epoch/packet';

const MAX_DESCRIPTOR_BYTES = 65_536;
const DIGEST = /^[0-9a-f]{64}$/;

type Command = 'check' | 'apply';

function fail(code: 'ADAPTER_REQUEST_INVALID' | 'PROTECTED_INPUT_UNAVAILABLE' | 'ACTIVATION_AUTH_REQUIRED'): never {
    epochFail(code);
}

function usage(): void {
    process.stdout.write('usage: run-capacity-identity-epoch.ts [check|apply] --packet-fd FD [--through VERIFIED]\n');
}

function readDescriptor(fd: number): unknown {
    if (!Number.isInteger(fd) || fd < 0) fail('PROTECTED_INPUT_UNAVAILABLE');
    let stat;
    try { stat = fstatSync(fd); } catch { fail('PROTECTED_INPUT_UNAVAILABLE'); }
    if ((!stat.isFile() && !stat.isFIFO())
        || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
        || (stat.mode & 0o077) !== 0) fail('PROTECTED_INPUT_UNAVAILABLE');
    const chunks: Buffer[] = [];
    let total = 0;
    try {
        while (true) {
            const buffer = Buffer.allocUnsafe(Math.min(16_384, MAX_DESCRIPTOR_BYTES + 1 - total));
            const count = readSync(fd, buffer, 0, buffer.length, null);
            if (count === 0) break;
            total += count;
            if (total > MAX_DESCRIPTOR_BYTES) fail('PROTECTED_INPUT_UNAVAILABLE');
            chunks.push(buffer.subarray(0, count));
        }
    } catch (error) {
        if (error instanceof EpochError) throw error;
        fail('PROTECTED_INPUT_UNAVAILABLE');
    }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('PROTECTED_INPUT_UNAVAILABLE'); }
    return value;
}

function parseFd(value: string | undefined): number {
    if (value === undefined || !/^\d{1,9}$/.test(value)) fail('ADAPTER_REQUEST_INVALID');
    const fd = Number(value);
    if (!Number.isSafeInteger(fd)) fail('ADAPTER_REQUEST_INVALID');
    return fd;
}

function parseArguments(argv: readonly string[]): Readonly<{ command: Command; packetFd?: number; through?: string; capabilityFd?: number; help: boolean }> {
    let command: Command = 'check';
    let packetFd: number | undefined;
    let capabilityFd: number | undefined;
    let through: string | undefined;
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--help' || arg === '-h') return { command, packetFd, capabilityFd, through, help: true };
        if ((arg === 'check' || arg === 'apply') && index === 0) {
            command = arg;
            continue;
        }
        if (arg === '--packet-fd') {
            if (packetFd !== undefined) fail('ADAPTER_REQUEST_INVALID');
            packetFd = parseFd(argv[++index]);
            continue;
        }
        if (arg === '--capability-fd') {
            if (capabilityFd !== undefined) fail('ADAPTER_REQUEST_INVALID');
            capabilityFd = parseFd(argv[++index]);
            continue;
        }
        if (arg === '--through') {
            if (through !== undefined || index + 1 >= argv.length) fail('ADAPTER_REQUEST_INVALID');
            through = argv[++index];
            continue;
        }
        fail('ADAPTER_REQUEST_INVALID');
    }
    return { command, packetFd, capabilityFd, through, help: false };
}

function run(): void {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
        usage();
        return;
    }
    if (options.packetFd === undefined) fail('PROTECTED_INPUT_UNAVAILABLE');
    const packet = loadProtectedPacket({ fd: options.packetFd });
    const packetDigest = canonicalDigest(packet);
    if (options.command === 'check') {
        if (options.through !== undefined && options.through !== 'VERIFIED') fail('ADAPTER_REQUEST_INVALID');
        process.stdout.write(`CHECK_OK packetDigest=${packetDigest}\n`);
        return;
    }
    if (options.through !== 'VERIFIED' || options.capabilityFd === undefined) fail('ACTIVATION_AUTH_REQUIRED');
    // A serialized capability is never accepted as authorization.  Reading a
    // descriptor here only proves that the protected operator channel exists;
    // the in-process opaque capability must still be issued by a validated
    // coordinator bootstrap.  Live adapters are intentionally not built by
    // this initial provider-free command without their reviewed descriptors.
    const descriptor = readDescriptor(options.capabilityFd);
    if (!isObject(descriptor) || !hasExactKeys(descriptor, ['ownerDigest'])
        || typeof descriptor.ownerDigest !== 'string' || !DIGEST.test(descriptor.ownerDigest)) fail('ACTIVATION_AUTH_REQUIRED');
    fail('PROTECTED_INPUT_UNAVAILABLE');
}

try {
    run();
} catch (error) {
    if (error instanceof EpochError) {
        process.stderr.write(`${error.code}\n`);
        process.exitCode = 2;
    } else {
        process.stderr.write('ADAPTER_REQUEST_INVALID\n');
        process.exitCode = 2;
    }
}

