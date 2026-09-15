import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    createStorageSourceVerifier,
    storageSourceContext,
    verifyStorageSourceArchive,
    type StorageSourceBinaryRequest,
    type StorageSourceBinaryResponse,
    type StorageSourceBinaryTransport,
    type StorageSourceReferenceInput,
} from '../../../../scripts/capacity-identity-epoch/storage-source';

type ZipEntry = Readonly<{ name: string; data?: string; mode?: number }>;

let repoCwd = '';
let reviewedSha = '';

function git(...args: string[]): Buffer {
    return execFileSync('git', args, {
        cwd: repoCwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
    });
}

function makeZip(entries: readonly ZipEntry[]): Buffer {
    const script = [
        'import io, json, sys, zipfile',
        'items = json.load(sys.stdin)',
        'out = io.BytesIO()',
        'with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as archive:',
        '    for item in items:',
        '        info = zipfile.ZipInfo(item["name"])',
        '        info.compress_type = zipfile.ZIP_DEFLATED',
        '        if "mode" in item:',
        '            info.external_attr = int(item["mode"]) << 16',
        '        archive.writestr(info, item.get("data", "").encode())',
        'sys.stdout.buffer.write(out.getvalue())',
    ].join('\n');
    return execFileSync('python3', ['-c', script], {
        input: JSON.stringify(entries),
        shell: false,
        stdio: ['pipe', 'pipe', 'ignore'],
        maxBuffer: 4 * 1024 * 1024,
    });
}

function source(): StorageSourceReferenceInput {
    return { bucket: 'fixture-bucket', object: 'source.zip', generation: 42 };
}

function legacyArchive(): Buffer {
    return makeZip([
        { name: 'tracked.txt', data: 'tracked\n' },
        { name: 'nested/file.txt', data: 'nested\n' },
    ]);
}

class FixtureStorageTransport implements StorageSourceBinaryTransport {
    readonly requests: StorageSourceBinaryRequest[] = [];
    generation = '42';
    constructor(private readonly body: Uint8Array) {}
    async request(request: StorageSourceBinaryRequest): Promise<StorageSourceBinaryResponse> {
        this.requests.push(request);
        return {
            status: 200,
            headers: { 'x-goog-generation': this.generation },
            body: this.body,
            url: request.url,
        };
    }
}

beforeAll(() => {
    repoCwd = mkdtempSync(join(tmpdir(), 'capacity-storage-source-'));
    mkdirSync(join(repoCwd, 'nested'));
    writeFileSync(join(repoCwd, '.gitignore'), '.env.local\n');
    writeFileSync(join(repoCwd, 'tracked.txt'), 'tracked\n');
    writeFileSync(join(repoCwd, 'nested', 'file.txt'), 'nested\n');
    git('init', '-q');
    git('config', 'user.email', 'fixture@example.invalid');
    git('config', 'user.name', 'fixture');
    git('add', '.gitignore', 'tracked.txt', 'nested/file.txt');
    git('commit', '-qm', 'fixture');
    reviewedSha = git('rev-parse', 'HEAD').toString('utf8').trim();
});

afterAll(() => {
    if (repoCwd) rmSync(repoCwd, { recursive: true, force: true });
});

describe('generation-pinned storage source Git proof', () => {
    it('accepts the documented root .gitignore omission and returns only safe proof', () => {
        const archive = legacyArchive();
        const proof = verifyStorageSourceArchive({
            repoCwd,
            reviewedSha,
            source: source(),
            archive,
        });
        expect(proof).toEqual({
            reviewedSha,
            archiveSha256: createHash('sha256').update(archive).digest('hex'),
            sourceContext: 'fixture-bucket/source.zip#42',
            sourceBucket: 'fixture-bucket',
            sourceObject: 'source.zip',
            sourceGeneration: '42',
        });
    });

    it('rejects non-metadata omissions, extra files, and blob mismatches', () => {
        const mismatch = makeZip([
            { name: 'tracked.txt', data: 'tampered\n' },
            { name: 'nested/file.txt', data: 'nested\n' },
        ]);
        expect(verifyStorageSourceArchive({ repoCwd, reviewedSha, source: source(), archive: mismatch })).toBeNull();

        const extra = makeZip([
            { name: 'tracked.txt', data: 'tracked\n' },
            { name: 'nested/file.txt', data: 'nested\n' },
            { name: 'extra.txt', data: 'extra\n' },
        ]);
        expect(verifyStorageSourceArchive({ repoCwd, reviewedSha, source: source(), archive: extra })).toBeNull();

        const missing = makeZip([{ name: 'tracked.txt', data: 'tracked\n' }]);
        expect(verifyStorageSourceArchive({ repoCwd, reviewedSha, source: source(), archive: missing })).toBeNull();
        expect(verifyStorageSourceArchive({
            repoCwd, reviewedSha, source: source(), archive: legacyArchive(),
            allowLegacyGitignoreOmission: false,
        })).toBeNull();
    });

    it('fails closed for traversal, duplicate, symlink, and bounded archive violations', () => {
        const unsafeArchives = [
            makeZip([
                { name: 'tracked.txt', data: 'tracked\n' },
                { name: 'nested/file.txt', data: 'nested\n' },
                { name: '../escape', data: 'escape\n' },
            ]),
            makeZip([
                { name: 'tracked.txt', data: 'tracked\n' },
                { name: 'tracked.txt', data: 'tracked\n' },
                { name: 'nested/file.txt', data: 'nested\n' },
            ]),
            makeZip([
                { name: 'tracked.txt', data: 'tracked\n' },
                { name: 'nested/file.txt', data: 'nested\n' },
                { name: 'link', data: 'tracked.txt', mode: 0o120777 },
            ]),
        ];
        for (const archive of unsafeArchives) {
            expect(() => verifyStorageSourceArchive({ repoCwd, reviewedSha, source: source(), archive }))
                .toThrowError('EVIDENCE_UNAVAILABLE');
        }
        expect(() => verifyStorageSourceArchive({
            repoCwd, reviewedSha, source: source(), archive: legacyArchive(), maxEntries: 1,
        })).toThrowError('EVIDENCE_UNAVAILABLE');
        expect(() => verifyStorageSourceArchive({
            repoCwd, reviewedSha, source: source(), archive: legacyArchive(), maxDecompressedBytes: 1,
        })).toThrowError('EVIDENCE_UNAVAILABLE');
    });

    it('reads the exact GCS object generation through an in-memory token closure', async () => {
        const transport = new FixtureStorageTransport(legacyArchive());
        const verifier = createStorageSourceVerifier({
            repoCwd,
            tokenProvider: async () => 'fixture-token',
            transport,
        });
        const proof = await verifier({ source: source(), reviewedSha });
        expect(proof?.sourceContext).toBe(storageSourceContext(source()));
        expect(proof?.reviewedSha).toBe(reviewedSha);
        expect(transport.requests).toHaveLength(1);
        const request = transport.requests[0]!;
        const url = new URL(request.url);
        expect(url.hostname).toBe('storage.googleapis.com');
        expect(url.pathname).toBe('/download/storage/v1/b/fixture-bucket/o/source.zip');
        expect(url.searchParams.get('alt')).toBe('media');
        expect(url.searchParams.get('generation')).toBe('42');
        expect(request.headers.authorization).toBe('Bearer fixture-token');

        transport.generation = '43';
        await expect(verifier({ source: source(), reviewedSha })).rejects.toMatchObject({ code: 'ADAPTER_RESPONSE_INVALID' });
    });
});
