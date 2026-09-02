import { open, lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const MODE_MASK = 0o777;
const PRIVATE_READ_ONLY_MODES = new Set([0o400, 0o600]);

function isWithin(root: string, candidate: string): boolean {
    const relation = relative(root, candidate);
    return relation === '' || (!relation.startsWith('..') && relation !== '..' && !isAbsolute(relation));
}

export async function safeOutputPath(outputFile: string, repoRoot = process.cwd()): Promise<string> {
    if (!isAbsolute(outputFile)) throw new Error('--output-file must be an absolute path');
    const [realRepoRoot, realParent] = await Promise.all([
        realpath(repoRoot),
        realpath(dirname(outputFile)),
    ]);
    const resolvedOutput = resolve(realParent, outputFile.slice(outputFile.lastIndexOf('/') + 1));
    if (isWithin(realRepoRoot, resolvedOutput)) {
        throw new Error('--output-file must be outside the repository');
    }
    return resolvedOutput;
}

export async function readPrivateEvidenceReference(
    path: string,
    repoRoot = process.cwd()
): Promise<string> {
    if (!isAbsolute(path)) throw new Error('evidence reference must be an absolute path');
    const [realRepoRoot, realEvidencePath] = await Promise.all([
        realpath(repoRoot),
        realpath(path),
    ]);
    if (isWithin(realRepoRoot, realEvidencePath)) {
        throw new Error('evidence reference must be outside the repository');
    }
    const stats = await lstat(realEvidencePath);
    if (!stats.isFile()) throw new Error('evidence reference must be a regular file');
    if (!PRIVATE_READ_ONLY_MODES.has(stats.mode & MODE_MASK)) {
        throw new Error('evidence reference must have mode 0600 or 0400');
    }
    const handle = await open(realEvidencePath, 'r');
    try {
        const contents = await handle.readFile();
        if (contents.byteLength < 1 || contents.byteLength > 4_096) {
            throw new Error('evidence reference file must contain 1 to 4096 bytes');
        }
        const reference = contents.toString('utf8').trim();
        if (!reference) throw new Error('evidence reference file must not be blank');
        return reference;
    } finally {
        await handle.close();
    }
}

export async function writeExclusivePrivateOutput(path: string, content: string): Promise<void> {
    const handle = await open(path, 'wx', 0o600);
    try {
        await handle.chmod(0o600);
        await handle.writeFile(content, { encoding: 'utf8' });
    } finally {
        await handle.close();
    }
}
