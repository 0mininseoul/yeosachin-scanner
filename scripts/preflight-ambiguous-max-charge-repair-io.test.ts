import { chmod, lstat, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    readPrivateEvidenceReference,
    safeOutputPath,
    writeExclusivePrivateOutput,
} from './preflight-ambiguous-max-charge-repair-io';

const temporaryRoots: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) =>
        rm(root, { recursive: true, force: true })
    ));
});

async function fixture(): Promise<{ repoRoot: string; outsideRoot: string }> {
    const root = await mkdtemp(join(tmpdir(), 'identity-drift-repair-'));
    temporaryRoots.push(root);
    const repoRoot = join(root, 'repo');
    const outsideRoot = join(root, 'outside');
    await mkdir(repoRoot);
    await mkdir(outsideRoot);
    return { repoRoot, outsideRoot };
}

describe('identity-drift repair private output and evidence IO', () => {
    it('rejects an output path inside the repository and an existing output file', async () => {
        const { repoRoot, outsideRoot } = await fixture();
        await expect(safeOutputPath(join(repoRoot, 'candidate.sql'), repoRoot))
            .rejects.toThrow(/outside the repository/);

        const outputPath = join(outsideRoot, 'candidate.sql');
        await writeExclusivePrivateOutput(outputPath, 'generated');
        expect((await lstat(outputPath)).mode & 0o777).toBe(0o600);
        await writeFile(outputPath, 'existing', { mode: 0o600 });
        await expect(writeExclusivePrivateOutput(outputPath, 'replacement'))
            .rejects.toMatchObject({ code: 'EEXIST' });
        expect(await readFile(outputPath, 'utf8')).toBe('existing');
    });

    it('requires evidence to be a private regular file outside the repository', async () => {
        const { repoRoot, outsideRoot } = await fixture();
        const inRepo = join(repoRoot, 'evidence.txt');
        await writeFile(inRepo, 'secret', { mode: 0o600 });
        await expect(readPrivateEvidenceReference(inRepo, repoRoot))
            .rejects.toThrow(/outside the repository/);

        const insecure = join(outsideRoot, 'insecure.txt');
        await writeFile(insecure, 'secret', { mode: 0o644 });
        await expect(readPrivateEvidenceReference(insecure, repoRoot))
            .rejects.toThrow(/mode 0600 or 0400/);

        const safe = join(outsideRoot, 'safe.txt');
        await writeFile(safe, 'secret', { mode: 0o600 });
        await chmod(safe, 0o400);
        await expect(readPrivateEvidenceReference(safe, repoRoot)).resolves.toBe('secret');
    });
});
