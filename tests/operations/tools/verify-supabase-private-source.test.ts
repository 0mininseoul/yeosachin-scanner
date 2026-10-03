import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    parsePrivateSourceArgs,
    parsePrivateSourceManifest,
    isSafeSupabaseExecutableDirectory,
    isSafePrivateSourceAncestorDirectory,
    PrivateSourceError,
    type PrivateSourceChildRequest,
    type PrivateSourceDependencies,
    type PrivateSourceManifest,
} from '../../../scripts/supabase-private-source';
import { runPrivateSourceCli } from '../../../scripts/verify-supabase-private-source';

const REF = 'abcdefghijklmnopqrst';
const TOKEN = 'FAKE_TEST_TOKEN_ONLY';
const HASH = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const QUERY_HELP = '--linked --project-ref string --workdir string --output [json] --agent [auto|yes|no] --profile string';
const PUSH_HELP = '--linked --project-ref string --workdir string --dry-run --skip-vault --profile string';

describe('private migration source verifier (fake fixtures and children only)', () => {
    let base: string;
    let root: string;
    let secure: string;
    let manifestPath: string;
    let cliPath: string;
    let manifest: PrivateSourceManifest;
    let calls: PrivateSourceChildRequest[];
    let output: string[];
    let dependencies: PrivateSourceDependencies;
    let behavior: ((request: PrivateSourceChildRequest) => void | Promise<void>) | undefined;
    let queryOverride: string | undefined;
    let dryOverride: { stdout: string; stderr: string; exitCode: number } | undefined;

    function git(args: string[]): string {
        return execFileSync('/usr/bin/git', ['-C', root, ...args], {
            encoding: 'utf8', timeout: 5_000, maxBuffer: 128 * 1024,
            env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } as unknown as NodeJS.ProcessEnv,
            stdio: ['ignore', 'pipe', 'ignore'], shell: false,
        }).trim();
    }

    function saveManifest(raw = JSON.stringify(manifest)): void {
        writeFileSync(manifestPath, raw, { mode: 0o600 });
    }

    function rows(): object[] {
        const excluded = new Set(manifest.excludedLocalSources.map(source => source.version));
        return [
            ...manifest.localSources.filter(source => !excluded.has(source.version)).map(source => ({
                version: source.version, statement_count: null, canonical_length: null, canonical_md5: null,
            })),
            ...manifest.privateSources.map(source => ({ version: source.version, statement_count: source.statementCount,
                canonical_length: source.canonicalLength, canonical_md5: source.canonicalMd5 })),
        ].sort((a, b) => a.version.localeCompare(b.version));
    }

    async function run(mode: '--local-only' | '--dry-run' = '--local-only', auth = false) {
        return runPrivateSourceCli(['verify', '--manifest', manifestPath, mode, ...(auth ? ['--auth=root-env'] : [])], {
            ...dependencies, writeStdout: value => output.push(value),
        });
    }

    function assertSafeFailure(result: Awaited<ReturnType<typeof runPrivateSourceCli>>, errorCode?: string): void {
        expect(result.exitCode).toBe(1);
        expect(result.receipt?.status).toBe('failed');
        if (errorCode) expect(result.receipt?.errorCode).toBe(errorCode);
        const emitted = output.join('');
        for (const secret of [base, root, secure, REF, TOKEN, 'SELECT 1', 'FAKE_RAW_SECRET']) expect(emitted).not.toContain(secret);
        expect(calls.filter(call => call.args.includes('push') && !call.args.includes('--help')).every(call => call.args.includes('--dry-run'))).toBe(true);
        expect(calls.flatMap(call => [...call.args])).not.toEqual(expect.arrayContaining(['--include-all', '--include-roles', '--include-seed', 'repair', 'reset', 'apply']));
    }

    beforeEach(() => {
        base = mkdtempSync(join(realpathSync(tmpdir()), 'private-source-test-'));
        chmodSync(base, 0o700);
        root = join(base, 'root');
        secure = join(base, 'private');
        mkdirSync(root, { mode: 0o700 });
        mkdirSync(secure, { mode: 0o700 });
        mkdirSync(join(root, 'supabase'), { mode: 0o700 });
        mkdirSync(join(root, 'supabase', 'migrations'), { mode: 0o700 });
        mkdirSync(join(root, 'supabase', '.temp'), { mode: 0o700 });
        const localSources = Array.from({ length: 8 }, (_, i) => {
            const version = `2026010100000${i + 1}`;
            const filename = `${version}_fixture.sql`;
            const content = `SELECT ${i + 1};\n`;
            writeFileSync(join(root, 'supabase', 'migrations', filename), content, { mode: 0o644 });
            return { version, filename, bytes: Buffer.byteLength(content), sha256: HASH(content) };
        });
        git(['init', '-b', 'main']);
        git(['add', 'supabase/migrations']);
        git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
        const privateSources = Array.from({ length: 6 }, (_, i) => {
            const version = `2026020100000${i + 1}`;
            const filename = `${version}_private.sql`;
            const path = join(secure, filename);
            const content = `SELECT ${i + 101};\n`;
            writeFileSync(path, content, { mode: 0o600 });
            return { version, filename, path, bytes: Buffer.byteLength(content), sha256: HASH(content),
                statementCount: 1, canonicalLength: 11, canonicalMd5: createHash('md5').update(`fixture-${i}`).digest('hex') };
        });
        manifest = { schemaVersion: 1, attestationBaseGitSha: git(['rev-parse', 'HEAD']), localSources,
            excludedLocalSources: localSources.slice(0, 6), privateSources };
        manifestPath = join(secure, 'manifest.json');
        saveManifest();
        writeFileSync(join(root, 'supabase', '.temp', 'project-ref'), `${REF}\n`, { mode: 0o644 });
        writeFileSync(join(root, 'supabase', '.temp', 'pooler-url'), `postgresql://postgres.${REF}@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres\n`, { mode: 0o644 });
        writeFileSync(join(root, '.env.local'), `NEXT_PUBLIC_SUPABASE_URL=https://${REF}.supabase.co\nSUPABASE_ACCESS_TOKEN=${TOKEN}\nIGNORED_TEST_SECRET=FAKE_RAW_SECRET\n`, { mode: 0o600 });
        cliPath = join(base, 'fake-supabase');
        writeFileSync(cliPath, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
        calls = []; output = []; behavior = undefined; queryOverride = undefined; dryOverride = undefined;
        dependencies = {
            cwd: root, homeDir: base, tempDir: base, cliPath, resolveRoot: () => root,
            now: () => new Date('2026-10-04T00:00:00.000Z'),
            runChild: async request => {
                calls.push(request);
                await behavior?.(request);
                if (request.args[0] === '--version') return { stdout: '2.114.0\n', stderr: '', exitCode: 0 };
                if (request.args.includes('--help')) return { stdout: request.args.includes('query') ? QUERY_HELP : PUSH_HELP, stderr: '', exitCode: 0 };
                if (request.args.includes('query')) return { stdout: queryOverride ?? JSON.stringify(rows()), stderr: 'Initialising login role...\nConnecting to remote database...\n', exitCode: 0 };
                return dryOverride ?? { stdout: 'Remote database is up to date.\n', stderr: 'DRY RUN: migrations will *not* be pushed to the database.\n', exitCode: 0 };
            },
        };
    });

    afterEach(() => {
        vi.useRealTimers();
        rmSync(base, { force: true, recursive: true });
    });

    it('accepts exactly the two verification modes and static help', () => {
        expect(parsePrivateSourceArgs(['verify', '--manifest', manifestPath, '--local-only'])).toMatchObject({ mode: 'local-only', auth: 'keychain' });
        expect(parsePrivateSourceArgs(['verify', '--manifest', manifestPath, '--dry-run', '--auth=root-env'])).toMatchObject({ mode: 'dry-run', auth: 'root-env' });
        expect(parsePrivateSourceArgs(['--help'])).toEqual({ help: true });
    });

    it.each([
        ['apply'], ['verify', '--apply'], ['verify', '--manifest', 'a', '--local-only', '--dry-run'],
        ['verify', '--manifest', 'a', '--local-only', '--auth=root-env'], ['verify', '--manifest', 'a', '--dry-run', '--auth=ambient'],
        ['verify', '--manifest', 'a', '--dry-run', '--dry-run'], ['verify', '--manifest', 'a', '--manifest', 'b', '--dry-run'],
        ['verify', '--manifest', 'a', '--dry-run', '--auth=root-env', '--auth=root-env'],
        ['verify', '--manifest', 'a', '--dry-run', '--include-all'], ['--help', 'verify'], [],
    ].map(args => ({ args })))('rejects invalid or duplicate arguments with a fixed code: $args', ({ args }) => {
        expect(() => parsePrivateSourceArgs(args)).toThrow('INVALID_ARGUMENTS');
    });

    it('help and invalid arguments read no fixtures or children', async () => {
        const resolveRoot = vi.fn(() => { throw new Error('FAKE_RAW_SECRET'); });
        const deps = { ...dependencies, resolveRoot, writeStdout: (value: string) => output.push(value) };
        expect((await runPrivateSourceCli(['--help'], deps)).exitCode).toBe(0);
        expect((await runPrivateSourceCli(['verify', '--apply'], deps)).receipt?.errorCode).toBe('INVALID_ARGUMENTS');
        expect(resolveRoot).not.toHaveBeenCalled(); expect(calls).toHaveLength(0);
    });

    it('checks the full actual local source set without hardcoding 392 and invokes zero Supabase children', async () => {
        const result = await run();
        expect(result.exitCode).toBe(0);
        expect(result.receipt).toMatchObject({ status: 'verified', localCount: 8, privateCount: 6, hashesMatch: true,
            originalsUnchanged: true, cleanupSucceeded: true, remoteCount: null, plannedMigrationCount: null });
        expect(calls).toHaveLength(0);
        expect(readdirSync(base).sort()).toEqual(['fake-supabase', 'private', 'root']);
    });

    it.each(['top', 'local', 'private', 'excluded'])('rejects unknown manifest fields at every boundary: %s', where => {
        const value = JSON.parse(JSON.stringify(manifest));
        const target = where === 'top' ? value : where === 'local' ? value.localSources[0] : where === 'private' ? value.privateSources[0] : value.excludedLocalSources[0];
        target.extra = 'FAKE_RAW_SECRET';
        expect(() => parsePrivateSourceManifest(JSON.stringify(value))).toThrow('MANIFEST_INVALID');
    });

    it('rejects duplicate decoded JSON keys', () => {
        const raw = JSON.stringify(manifest).replace('"schemaVersion":1', '"schemaVersion":1,"schema\\u0056ersion":1');
        expect(() => parsePrivateSourceManifest(raw)).toThrow('MANIFEST_INVALID');
    });

    it.each(['001', '010'])('preserves allowed legacy local identities: %s', version => {
        const value = JSON.parse(JSON.stringify(manifest));
        value.localSources[7].version = version;
        value.localSources[7].filename = `${version}_fixture.sql`;
        expect(parsePrivateSourceManifest(JSON.stringify(value)).localSources[7].version).toBe(version);
    });

    it.each(['000', '011', '0014'])('rejects other short migration identities: %s', version => {
        const value = JSON.parse(JSON.stringify(manifest));
        value.localSources[7].version = version;
        value.localSources[7].filename = `${version}_fixture.sql`;
        expect(() => parsePrivateSourceManifest(JSON.stringify(value))).toThrow('MANIFEST_INVALID');
    });

    it('checks legacy 001/010 against the base tree and remote versions without renaming sources', async () => {
        for (const [index, version] of [[6, '001'], [7, '010']] as const) {
            const source = manifest.localSources[index];
            const filename = `${version}_fixture.sql`;
            renameSync(join(root, 'supabase', 'migrations', source.filename), join(root, 'supabase', 'migrations', filename));
            manifest.localSources[index] = { ...source, version, filename };
        }
        git(['add', 'supabase/migrations']);
        git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'legacy fixture']);
        manifest.attestationBaseGitSha = git(['rev-parse', 'HEAD']); saveManifest();
        expect((await run('--dry-run')).exitCode).toBe(0);
        expect(readdirSync(join(root, 'supabase', 'migrations'))).toEqual(expect.arrayContaining(['001_fixture.sql', '010_fixture.sql']));
    });

    it.each(['localVersion', 'privateVersion', 'privatePath', 'excludedMismatch', 'count', 'filename', 'bytes', 'hash', 'relativePath', 'escapePath', 'statementCount'])('rejects invalid manifest identities and attestations: %s', condition => {
        const value = JSON.parse(JSON.stringify(manifest));
        if (condition === 'localVersion') value.localSources.push(value.localSources[0]);
        if (condition === 'privateVersion') value.privateSources[1] = { ...value.privateSources[1], version: value.privateSources[0].version, filename: value.privateSources[0].filename };
        if (condition === 'privatePath') value.privateSources[1].path = value.privateSources[0].path;
        if (condition === 'excludedMismatch') value.excludedLocalSources[0].sha256 = '0'.repeat(64);
        if (condition === 'count') value.privateSources.pop();
        if (condition === 'filename') value.localSources[0].filename = '../escape.sql';
        if (condition === 'bytes') value.privateSources[0].bytes = Number.MAX_SAFE_INTEGER + 1;
        if (condition === 'hash') value.localSources[0].sha256 = 'A'.repeat(64);
        if (condition === 'relativePath') value.privateSources[0].path = 'relative.sql';
        if (condition === 'escapePath') value.privateSources[0].path = secure + '/../private/' + value.privateSources[0].filename;
        if (condition === 'statementCount') value.privateSources[0].statementCount = 0;
        expect(() => parsePrivateSourceManifest(JSON.stringify(value))).toThrow('MANIFEST_INVALID');
    });

    it.each(['manifestFile', 'manifestParent', 'privateFile', 'privateParent', 'localFile', 'ancestor'])('fails before children on unsafe modes: %s', target => {
        if (target === 'manifestFile') chmodSync(manifestPath, 0o644);
        if (target === 'manifestParent' || target === 'privateParent') chmodSync(secure, 0o755);
        if (target === 'privateFile') chmodSync(manifest.privateSources[0].path, 0o644);
        if (target === 'localFile') chmodSync(join(root, 'supabase', 'migrations', manifest.localSources[0].filename), 0o666);
        if (target === 'ancestor') chmodSync(base, 0o777);
        return run().then(result => { assertSafeFailure(result, 'PATH_UNSAFE'); expect(calls).toHaveLength(0); });
    });

    it('allows only exact root-owned standard sticky temporary source ancestors', () => {
        const stat = { uid: 0, mode: 0o41777, directory: true, symlink: false };
        for (const path of ['/tmp', '/private/tmp']) expect(isSafePrivateSourceAncestorDirectory(path, stat, 501)).toBe(true);
        for (const [path, change] of [
            ['/tmp/other', {}], ['/private/tmp/other', {}], ['/arbitrary', {}], ['/opt/homebrew/Cellar', {}],
            ['/tmp', { uid: 501 }], ['/tmp', { uid: 502 }], ['/tmp', { mode: 0o1775 }],
            ['/tmp', { mode: 0o3777 }], ['/tmp', { mode: 0o777 }],
            ['/tmp', { directory: false }], ['/tmp', { symlink: true }],
        ] as const) expect(isSafePrivateSourceAncestorDirectory(path, { ...stat, ...change }, 501)).toBe(false);
        expect(isSafePrivateSourceAncestorDirectory('/ordinary', { ...stat, uid: 501, mode: 0o755 }, 501)).toBe(true);
        expect(isSafePrivateSourceAncestorDirectory('/ordinary', { ...stat, uid: 502, mode: 0o755 }, 501)).toBe(false);
    });

    it.each(['manifest', 'private', 'local', 'ancestor'])('rejects symlinks in source boundaries: %s', target => {
        if (target === 'ancestor') {
            renameSync(secure, `${secure}-real`); symlinkSync(`${secure}-real`, secure);
        } else {
            const path = target === 'manifest' ? manifestPath : target === 'private' ? manifest.privateSources[0].path : join(root, 'supabase', 'migrations', manifest.localSources[0].filename);
            const moved = target === 'local' ? join(base, 'moved-local.sql') : `${path}.real`;
            renameSync(path, moved); symlinkSync(moved, path);
        }
        return run().then(result => { assertSafeFailure(result, 'PATH_UNSAFE'); expect(calls).toHaveLength(0); });
    });

    it('rejects private SQL and manifest inside the repository', async () => {
        const internal = join(root, manifest.privateSources[0].filename);
        writeFileSync(internal, readFileSync(manifest.privateSources[0].path), { mode: 0o600 });
        manifest.privateSources[0].path = internal; saveManifest();
        assertSafeFailure(await run(), 'PATH_UNSAFE'); expect(calls).toHaveLength(0);
        const internalManifest = join(root, 'manifest.json');
        writeFileSync(internalManifest, JSON.stringify(manifest), { mode: 0o600 });
        const result = await runPrivateSourceCli(['verify', '--manifest', internalManifest, '--local-only'], { ...dependencies, writeStdout: value => output.push(value) });
        assertSafeFailure(result, 'PATH_UNSAFE');
    });

    it.each(['extra', 'missing', 'directory', 'sourceDrift', 'baseDrift', 'notAncestor'])('rejects local/source/base drift: %s', drift => {
        const source = manifest.localSources[0];
        if (drift === 'extra') writeFileSync(join(root, 'supabase', 'migrations', '20260102000000_extra.sql'), 'SELECT 1;\n');
        if (drift === 'missing') rmSync(join(root, 'supabase', 'migrations', source.filename));
        if (drift === 'directory') mkdirSync(join(root, 'supabase', 'migrations', 'nested'), { mode: 0o700 });
        if (drift === 'sourceDrift') writeFileSync(manifest.privateSources[0].path, 'SELECT 999;\n');
        if (drift === 'baseDrift') {
            const content = 'SELECT 777;\n'; writeFileSync(join(root, 'supabase', 'migrations', source.filename), content);
            manifest.localSources[0] = { ...source, bytes: Buffer.byteLength(content), sha256: HASH(content) };
            manifest.excludedLocalSources[0] = manifest.localSources[0]; saveManifest();
        }
        if (drift === 'notAncestor') { manifest.attestationBaseGitSha = 'f'.repeat(40); saveManifest(); }
        return run().then(result => { assertSafeFailure(result); expect(calls).toHaveLength(0); });
    });

    it('uses the canonical root seam rather than feature configuration', async () => {
        const feature = join(base, 'feature'); mkdirSync(feature, { mode: 0o700 });
        writeFileSync(join(feature, '.env.local'), 'SUPABASE_ACCESS_TOKEN=WRONG_FEATURE_TOKEN\n', { mode: 0o600 });
        dependencies.cwd = feature;
        const result = await run('--dry-run', true);
        expect(result.exitCode).toBe(0);
        expect(calls.every(call => call.env.SUPABASE_ACCESS_TOKEN === TOKEN)).toBe(true);
        expect(JSON.stringify(calls.map(call => call.args))).not.toContain(TOKEN);
        expect(output.join('')).not.toContain(TOKEN);
        expect(readFileSync(join(root, '.env.local'), 'utf8')).toContain(TOKEN);
    });

    it('reuses the real owner resolver from a fake linked feature checkout', async () => {
        const feature = join(base, 'feature');
        git(['worktree', 'add', '-b', 'codex/fixture', feature]);
        chmodSync(feature, 0o700);
        writeFileSync(join(feature, '.env.local'), 'SUPABASE_ACCESS_TOKEN=WRONG_FEATURE_TOKEN\n', { mode: 0o600 });
        dependencies.cwd = feature;
        delete dependencies.resolveRoot;
        const result = await run('--dry-run', true);
        expect(result.exitCode).toBe(0);
        expect(calls.every(call => call.cwd === call.env.TMPDIR && call.env.SUPABASE_ACCESS_TOKEN === TOKEN)).toBe(true);
    });

    it('rejects private sources inside any checkout of the same repository', async () => {
        const feature = join(base, 'feature');
        git(['worktree', 'add', '-b', 'codex/fixture', feature]);
        chmodSync(feature, 0o700);
        const source = manifest.privateSources[0];
        const internal = join(feature, source.filename);
        writeFileSync(internal, readFileSync(source.path), { mode: 0o600 });
        manifest.privateSources[0] = { ...source, path: internal }; saveManifest();
        assertSafeFailure(await run(), 'PATH_UNSAFE'); expect(calls).toHaveLength(0);
    });

    it('accepts safe root mode 755 with env mode 600 and preserves both modes', async () => {
        chmodSync(root, 0o755);
        const result = await run('--dry-run', true); expect(result.exitCode).toBe(0);
        expect(lstatSync(root).mode & 0o777).toBe(0o755);
        expect(lstatSync(join(root, '.env.local')).mode & 0o777).toBe(0o600);
    });

    it('creates a 6-for-6 symlink-only source set and copies only nonsecret metadata at mode 600', async () => {
        let workdir: string | undefined;
        behavior = request => {
            if (!request.args.includes('push') || request.args.includes('--help')) return;
            workdir = request.args[request.args.indexOf('--workdir') + 1];
            expect(lstatSync(workdir).mode & 0o777).toBe(0o700);
            const supabase = join(workdir, 'supabase');
            expect(readdirSync(supabase).sort()).toEqual(['.temp', 'migrations']);
            for (const directory of [join(supabase, '.temp'), join(supabase, 'migrations')]) expect(lstatSync(directory).mode & 0o777).toBe(0o700);
            const files = readdirSync(join(supabase, 'migrations'));
            expect(files).toHaveLength(8);
            expect(files.every(file => lstatSync(join(supabase, 'migrations', file)).isSymbolicLink())).toBe(true);
            expect(files).not.toEqual(expect.arrayContaining(manifest.excludedLocalSources.map(source => source.filename)));
            for (const file of ['project-ref', 'pooler-url']) expect(lstatSync(join(supabase, '.temp', file)).mode & 0o777).toBe(0o600);
            expect(readdirSync(workdir).sort()).toEqual(['cli-state', 'supabase']);
        };
        const result = await run('--dry-run');
        expect(result.exitCode).toBe(0);
        expect(result.receipt).toMatchObject({ remoteCount: 8, parityMatch: true, plannedMigrationCount: 0, originalsUnchanged: true, cleanupSucceeded: true });
        expect(calls).toHaveLength(5);
        expect(calls.filter(call => call.args.includes('push') && !call.args.includes('--help'))).toHaveLength(1);
        expect(calls.every(call => call.env.SUPABASE_ACCESS_TOKEN === undefined)).toBe(true);
        expect(calls.every(call => Object.keys(call.env).sort().join(',') === 'DO_NOT_TRACK,HOME,LANG,LC_ALL,PATH,SUPABASE_HOME,TMPDIR')).toBe(true);
        expect(() => lstatSync(workdir!)).toThrow();
        expect(lstatSync(join(root, 'supabase', '.temp', 'project-ref')).mode & 0o777).toBe(0o644);
        const query = calls.find(call => call.args.includes('query') && !call.args.includes('--help'))!;
        expect(query.args).toContain('--agent=no');
        expect(query.args).toContain('--profile=supabase');
        expect(calls.find(call => call.args.includes('push') && !call.args.includes('--help'))!.args).toContain('--profile=supabase');
        const sql = query.args.at(-1)!;
        expect(sql).toMatch(/^SELECT\b/);
        expect(sql).toContain('array_to_string(statements');
        expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|GRANT|CREATE|REPAIR)\b/i);
    });

    it('isolates each native CLI cwd and state while retaining the real owner HOME', async () => {
        behavior = request => {
            expect(request.cwd).toBe(request.env.TMPDIR);
            expect(request.env.HOME).toBe(base);
            expect(request.env.DO_NOT_TRACK).toBe('1');
            expect(request.env.SUPABASE_HOME).toBe(join(request.env.TMPDIR, 'cli-state'));
            const stat = lstatSync(request.env.SUPABASE_HOME);
            expect(stat.isDirectory() && !stat.isSymbolicLink()).toBe(true);
            expect(stat.uid).toBe(process.getuid!());
            expect(stat.mode & 0o7777).toBe(0o700);
            expect(readdirSync(request.env.SUPABASE_HOME)).toEqual([]);
        };
        expect((await run('--dry-run')).exitCode).toBe(0);
    });

    it.each([0o600, 0o644, 0o200])('allows one bounded denied-consent state file without interpreting its body or changing mode %i', async mode => {
        let statePath: string | undefined;
        behavior = request => {
            statePath = join(request.env.SUPABASE_HOME, 'telemetry.json');
            if (request.args[0] === '--version') writeFileSync(statePath, 'FAKE_OPAQUE_STATE_DO_NOT_INTERPRET', { mode });
            if (request.args.includes('push') && !request.args.includes('--help')) expect(lstatSync(statePath).mode & 0o777).toBe(mode);
        };
        const result = await run('--dry-run');
        expect(result.exitCode).toBe(0);
        expect(result.receipt).toMatchObject({ originalsUnchanged: true, cleanupSucceeded: true });
        expect(() => lstatSync(statePath!)).toThrow();
        expect(output.join('')).not.toContain('FAKE_OPAQUE_STATE_DO_NOT_INTERPRET');
    });

    it('accepts the exact one KiB telemetry metadata bound without reading its body', async () => {
        behavior = request => {
            if (request.args[0] === '--version') writeFileSync(join(request.env.SUPABASE_HOME, 'telemetry.json'), 'x'.repeat(1024), { mode: 0o600 });
        };
        expect((await run('--dry-run')).exitCode).toBe(0);
    });

    it.each(['token', 'profile', 'unknown', 'atomic', 'traces', 'multiple', 'oversize', 'mode', 'symlink', 'directory', 'stateMode', 'stateSymlink', 'stateReplace'])('rejects unexpected CLI state before the next child: %s', condition => {
        behavior = request => {
            if (request.args[0] !== '--version') return;
            const directory = request.env.SUPABASE_HOME;
            const state = join(directory, 'telemetry.json');
            if (condition === 'stateMode') { chmodSync(directory, 0o755); return; }
            if (condition === 'stateSymlink' || condition === 'stateReplace') {
                renameSync(directory, join(base, 'former-cli-state'));
                if (condition === 'stateSymlink') symlinkSync(secure, directory); else mkdirSync(directory, { mode: 0o700 });
                return;
            }
            if (condition === 'symlink') { symlinkSync(join(root, '.env.local'), state); return; }
            if (condition === 'directory') { mkdirSync(state, { mode: 0o700 }); return; }
            if (condition === 'traces') { mkdirSync(join(directory, 'traces'), { mode: 0o700 }); return; }
            const filename = condition === 'token' ? 'access-token' : condition === 'profile' ? 'profile'
                : condition === 'unknown' ? 'unknown.json' : condition === 'atomic' ? '.tmp.fixture' : 'telemetry.json';
            writeFileSync(join(directory, filename), condition === 'oversize' ? 'x'.repeat(1025) : 'FAKE_OPAQUE_STATE_DO_NOT_INTERPRET', { mode: 0o600 });
            if (condition === 'mode') chmodSync(state, 0o666);
            if (condition === 'multiple') writeFileSync(join(directory, 'profile'), 'fixture', { mode: 0o600 });
        };
        return run('--dry-run').then(result => {
            assertSafeFailure(result);
            expect(calls).toHaveLength(1);
            expect(result.receipt).toMatchObject({ originalsUnchanged: true, cleanupSucceeded: true, plannedMigrationCount: null });
            expect(output.join('')).not.toContain('FAKE_OPAQUE_STATE_DO_NOT_INTERPRET');
        });
    });

    it('checks isolated CLI state again after the final dry-run child', async () => {
        behavior = request => {
            if (request.args.includes('push') && !request.args.includes('--help')) writeFileSync(join(request.env.SUPABASE_HOME, 'access-token'), 'FAKE_RAW_SECRET', { mode: 0o600 });
        };
        const result = await run('--dry-run');
        assertSafeFailure(result, 'SOURCE_MISMATCH');
        expect(result.receipt).toMatchObject({ originalsUnchanged: true, cleanupSucceeded: true, plannedMigrationCount: null });
    });

    it.each([0o600, 0o644])('accepts only the bounded native linked-project cache and keeps its original mode %i', mode => {
        let cache: string | undefined;
        behavior = request => {
            if (request.args.includes('query') && !request.args.includes('--help')) {
                cache = join(request.env.TMPDIR, 'supabase', '.temp', 'linked-project.json');
                writeFileSync(cache, JSON.stringify({ ref: REF, name: 'FAKE_PROJECT_METADATA',
                    organization_id: 'organization_fixture', organization_slug: 'fixture-org' }), { mode });
            }
            if (request.args.includes('push') && !request.args.includes('--help')) {
                expect(lstatSync(cache!).mode & 0o777).toBe(mode);
                expect(request.args[request.args.indexOf('--project-ref') + 1]).toBe(REF);
            }
        };
        return run('--dry-run').then(result => {
            expect(result.exitCode).toBe(0);
            expect(result.receipt).toMatchObject({ parityMatch: true, plannedMigrationCount: 0, originalsUnchanged: true, cleanupSucceeded: true });
            expect(calls.filter(call => call.args.includes('push') && !call.args.includes('--help'))).toHaveLength(1);
            expect(() => lstatSync(cache!)).toThrow();
            for (const value of ['FAKE_PROJECT_METADATA', 'organization_fixture', 'fixture-org']) expect(output.join('')).not.toContain(value);
        });
    });

    it('accepts the official four-string cache contract with empty non-ref fields', async () => {
        behavior = request => {
            if (request.args.includes('query') && !request.args.includes('--help')) {
                writeFileSync(join(request.env.TMPDIR, 'supabase', '.temp', 'linked-project.json'),
                    JSON.stringify({ ref: REF, name: '', organization_id: '', organization_slug: '' }), { mode: 0o600 });
            }
        };
        expect((await run('--dry-run')).exitCode).toBe(0);
        expect(calls.filter(call => call.args.includes('push') && !call.args.includes('--help'))).toHaveLength(1);
    });

    it.each(['unknown', 'duplicate', 'ref', 'mode', 'symlink', 'extraFile', 'oversize', 'longField', 'control', 'c1Control', 'null', 'missing'])('rejects contaminated native linked-project metadata before push: %s', condition => {
        behavior = request => {
            if (!request.args.includes('query') || request.args.includes('--help')) return;
            const directory = join(request.env.TMPDIR, 'supabase', '.temp');
            const cache = join(directory, 'linked-project.json');
            const value: Record<string, unknown> = { ref: REF, name: 'FAKE_PROJECT_METADATA', organization_id: 'organization_fixture', organization_slug: 'fixture-org' };
            if (condition === 'unknown') value.token = 'FAKE_RAW_SECRET';
            if (condition === 'ref') value.ref = 'aaaaaaaaaaaaaaaaaaaa';
            if (condition === 'oversize') value.name = 'x'.repeat(5 * 1024);
            if (condition === 'longField') value.name = 'x'.repeat(257);
            if (condition === 'control') value.organization_slug = 'unsafe\nvalue';
            if (condition === 'c1Control') value.organization_slug = 'unsafe\u0085value';
            if (condition === 'null') value.organization_slug = null;
            if (condition === 'missing') delete value.organization_id;
            if (condition === 'symlink') { symlinkSync(join(root, '.env.local'), cache); return; }
            let raw = JSON.stringify(value);
            if (condition === 'duplicate') raw = raw.replace('"ref":', `"r\\u0065f":"${REF}","ref":`);
            writeFileSync(cache, raw, { mode: 0o600 });
            if (condition === 'mode') chmodSync(cache, 0o666);
            if (condition === 'extraFile') writeFileSync(join(directory, 'unexpected.json'), '{}', { mode: 0o600 });
        };
        return run('--dry-run').then(result => {
            assertSafeFailure(result);
            expect(result.receipt).toMatchObject({ parityMatch: true, originalsUnchanged: true, cleanupSucceeded: true });
            expect(calls.some(call => call.args.includes('push') && !call.args.includes('--help'))).toBe(false);
        });
    });

    it('rejects linked-project cache contamination created by the final dry-run child', async () => {
        behavior = request => {
            if (request.args.includes('push') && !request.args.includes('--help')) {
                writeFileSync(join(request.env.TMPDIR, 'supabase', '.temp', 'linked-project.json'),
                    JSON.stringify({ ref: REF, name: 'fixture', organization_id: 'fixture', organization_slug: 'fixture', secret: 'FAKE_RAW_SECRET' }), { mode: 0o600 });
            }
        };
        const result = await run('--dry-run'); assertSafeFailure(result, 'SOURCE_MISMATCH');
        expect(result.receipt).toMatchObject({ plannedMigrationCount: null, originalsUnchanged: true, cleanupSucceeded: true });
    });

    it.each(['ref', 'poolerPassword', 'poolerHost', 'poolerPort', 'poolerUser', 'origin', 'envMode', 'metadataMode', 'cliMode', 'cliSymlink'])('rejects invalid root identity, auth, or executable before any child: %s', condition => {
        if (condition === 'ref') writeFileSync(join(root, 'supabase', '.temp', 'project-ref'), 'INVALID_REF');
        if (condition === 'poolerPassword') writeFileSync(join(root, 'supabase', '.temp', 'pooler-url'), `postgresql://postgres.${REF}:password@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres`);
        if (condition === 'poolerHost') writeFileSync(join(root, 'supabase', '.temp', 'pooler-url'), `postgresql://postgres.${REF}@evil.invalid:5432/postgres`);
        if (condition === 'poolerPort') writeFileSync(join(root, 'supabase', '.temp', 'pooler-url'), `postgresql://postgres.${REF}@aws-0-ap-northeast-2.pooler.supabase.com:1234/postgres`);
        if (condition === 'poolerUser') writeFileSync(join(root, 'supabase', '.temp', 'pooler-url'), `postgresql://postgres.aaaaaaaaaaaaaaaaaaaa@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres`);
        if (condition === 'origin') writeFileSync(join(root, '.env.local'), 'NEXT_PUBLIC_SUPABASE_URL=https://aaaaaaaaaaaaaaaaaaaa.supabase.co\n', { mode: 0o600 });
        if (condition === 'envMode') chmodSync(join(root, '.env.local'), 0o644);
        if (condition === 'metadataMode') chmodSync(join(root, 'supabase', '.temp', 'pooler-url'), 0o666);
        if (condition === 'cliMode') chmodSync(cliPath, 0o777);
        if (condition === 'cliSymlink') { renameSync(cliPath, `${cliPath}.real`); chmodSync(`${cliPath}.real`, 0o777); symlinkSync(`${cliPath}.real`, cliPath); }
        return run('--dry-run').then(result => { assertSafeFailure(result); expect(calls).toHaveLength(0); });
    });

    it('allows only a verified safe executable symlink chain', async () => {
        renameSync(cliPath, `${cliPath}.real`); symlinkSync(`${cliPath}.real`, cliPath);
        const result = await run('--dry-run'); expect(result.exitCode).toBe(0);
        expect(calls.every(call => call.command === realpathSync(cliPath))).toBe(true);
    });

    it('allows only the exact Darwin Homebrew bin/Cellar administrator directory policy', () => {
        const stat = { uid: 501, gid: 80, mode: 0o40775, directory: true, symlink: false };
        for (const path of ['/opt/homebrew/bin', '/opt/homebrew/Cellar']) {
            expect(isSafeSupabaseExecutableDirectory(path, stat, 501, 'darwin')).toBe(true);
            expect(isSafeSupabaseExecutableDirectory(path, { ...stat, uid: 0 }, 501, 'darwin')).toBe(true);
            for (const [change, platform] of [
                [{}, 'linux'], [{ gid: 81 }, 'darwin'], [{ mode: 0o777 }, 'darwin'],
                [{ mode: 0o2775 }, 'darwin'], [{ uid: 0, mode: 0o1777 }, 'darwin'],
                [{ uid: 502 }, 'darwin'], [{ directory: false }, 'darwin'], [{ symlink: true }, 'darwin'],
            ] as const) expect(isSafeSupabaseExecutableDirectory(path, { ...stat, ...change }, 501, platform)).toBe(false);
        }
        for (const path of ['/opt/homebrew/bin/other', '/opt/homebrew/Cellar/other', '/other/Cellar', '/opt/homebrew/other']) {
            expect(isSafeSupabaseExecutableDirectory(path, stat, 501, 'darwin')).toBe(false);
        }
        expect(isSafeSupabaseExecutableDirectory('/ordinary', { ...stat, mode: 0o755 }, 501, 'linux')).toBe(true);
    });

    it('rechecks the final regular executable and identity before each child when its symlink changes', async () => {
        const original = `${cliPath}.original`;
        const replacement = `${cliPath}.replacement`;
        renameSync(cliPath, original); symlinkSync(original, cliPath);
        writeFileSync(replacement, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
        behavior = request => {
            if (request.args[0] === '--version') { rmSync(cliPath); symlinkSync(replacement, cliPath); }
        };
        const result = await run('--dry-run');
        assertSafeFailure(result, 'CLI_UNAVAILABLE');
        expect(calls).toHaveLength(1);
        expect(calls[0].command).toBe(original);
        expect(result.receipt).toMatchObject({ cliVersion: '2.114.0', originalsUnchanged: true, cleanupSucceeded: true });
    });

    it.each(['missing', 'empty'])('root-env requires one usable token: %s', condition => {
        writeFileSync(join(root, '.env.local'), `NEXT_PUBLIC_SUPABASE_URL=https://${REF}.supabase.co\n${condition === 'empty' ? 'SUPABASE_ACCESS_TOKEN=\n' : ''}`);
        return run('--dry-run', true).then(result => { assertSafeFailure(result, 'ENV_INVALID'); expect(calls).toHaveLength(0); });
    });

    it.each(['version', 'queryHelp', 'queryAgentHelp', 'queryProfileHelp', 'pushHelp', 'pushProfileHelp'])('fails pinned version or capability checks: %s', boundary => {
        dependencies.runChild = async request => {
            calls.push(request);
            if (request.args[0] === '--version') return { stdout: boundary === 'version' ? '2.102.0\n' : '2.114.0\n', stderr: '', exitCode: 0 };
            return { stdout: request.args.includes('query') ? (boundary === 'queryHelp' ? '--linked' : boundary === 'queryAgentHelp' ? QUERY_HELP.replace(' --agent [auto|yes|no]', '') : boundary === 'queryProfileHelp' ? QUERY_HELP.replace(' --profile string', '') : QUERY_HELP) : (boundary === 'pushHelp' ? '--dry-run' : boundary === 'pushProfileHelp' ? PUSH_HELP.replace(' --profile string', '') : PUSH_HELP), stderr: '', exitCode: 0 };
        };
        return run('--dry-run').then(result => { assertSafeFailure(result); expect(calls.some(call => call.args.includes('push') && !call.args.includes('--help'))).toBe(false); });
    });

    it.each(['missing', 'extra', 'metadata', 'rowExtra', 'wrapper', 'agentEnvelope', 'envelopeExtra', 'duplicate', 'prefix', 'suffix', 'duplicateKey'])('fails remote parity or contaminated JSON and never pushes: %s', mismatch => {
        const remote = rows() as Record<string, unknown>[];
        if (mismatch === 'missing') remote.pop();
        if (mismatch === 'extra') remote.push({ version: '20260301000000', statement_count: null, canonical_length: null, canonical_md5: null });
        if (mismatch === 'metadata') remote.at(-1)!.canonical_md5 = '0'.repeat(32);
        if (mismatch === 'rowExtra') remote[0].sql = 'FAKE_RAW_SECRET';
        if (mismatch === 'duplicate') remote.push(remote[0]);
        queryOverride = JSON.stringify(mismatch === 'wrapper' ? { rows: remote }
            : mismatch === 'agentEnvelope' ? { warning: 'fixture', boundary: 'fixture', rows: remote }
                : mismatch === 'envelopeExtra' ? { rows: remote, secret: 'FAKE_RAW_SECRET' } : remote);
        if (mismatch === 'prefix') queryOverride = 'FAKE_RAW_SECRET\n' + queryOverride;
        if (mismatch === 'suffix') queryOverride += '\nFAKE_RAW_SECRET';
        if (mismatch === 'duplicateKey') queryOverride = queryOverride.replace('"version":', `"v\\u0065rsion":"${remote[0].version}","version":`);
        return run('--dry-run').then(result => { assertSafeFailure(result); expect(calls.some(call => call.args.includes('push') && !call.args.includes('--help'))).toBe(false); });
    });

    it.each(['timeout', 'output', 'exit', 'stderr'])('fails child transport without raw errors or retries: %s', failure => {
        behavior = request => {
            if (!request.args.includes('query') || request.args.includes('--help')) return;
            if (failure === 'timeout') throw new PrivateSourceError('CHILD_TIMEOUT');
            if (failure === 'exit') throw new Error('FAKE_RAW_SECRET');
        };
        if (failure === 'output') queryOverride = 'x'.repeat(600 * 1024);
        if (failure === 'stderr') dependencies.runChild = async request => {
            calls.push(request);
            if (request.args[0] === '--version') return { stdout: '2.114.0\n', stderr: 'FAKE_RAW_SECRET', exitCode: 0 };
            throw new Error('FAKE_RAW_SECRET');
        };
        return run('--dry-run').then(result => { assertSafeFailure(result); expect(calls.filter(call => call.args.includes('query') && !call.args.includes('--help')).length).toBeLessThanOrEqual(1); });
    });

    it('enforces the timeout even when a fake transport never settles', async () => {
        dependencies.childTimeoutMs = 20;
        behavior = request => request.args[0] === '--version' ? new Promise<void>(() => undefined) : undefined;
        const result = await run('--dry-run'); assertSafeFailure(result, 'CHILD_TERMINATION_UNCONFIRMED'); expect(calls).toHaveLength(1);
        expect(result.receipt).toMatchObject({ originalsUnchanged: false, cleanupSucceeded: false });
    });

    it('finalizes only after an injected transport cooperates with timeout cancellation', async () => {
        dependencies.childTimeoutMs = 20;
        dependencies.runChild = async request => {
            calls.push(request);
            return new Promise((_resolve, reject) => request.signal.addEventListener('abort',
                () => reject(new PrivateSourceError('CHILD_TIMEOUT')), { once: true }));
        };
        const result = await run('--dry-run'); assertSafeFailure(result, 'CHILD_TIMEOUT');
        expect(result.receipt).toMatchObject({ originalsUnchanged: true, cleanupSucceeded: true });
    });

    it('waits for a definitive group probe after a transient denial', async () => {
        let injected = false;
        const originalKill = process.kill.bind(process);
        const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
            if (!injected && pid < 0 && signal === 0) {
                injected = true;
                throw Object.assign(new Error('fixture'), { code: 'EPERM' });
            }
            return originalKill(pid, signal);
        });
        try { expect((await run()).exitCode).toBe(0); expect(injected).toBe(true); }
        finally { spy.mockRestore(); }
    });

    it.each(['timeout', 'output'])('bounds and terminates a real local fake child: %s', failure => {
        writeFileSync(cliPath, `#!${process.execPath}\n${failure === 'timeout' ? 'setInterval(() => {}, 100);' : "process.stdout.write('x'.repeat(600 * 1024));"}\n`, { mode: 0o700 });
        delete dependencies.runChild;
        dependencies.childTimeoutMs = failure === 'timeout' ? 100 : 2_000;
        const started = Date.now();
        return run('--dry-run').then(result => {
            assertSafeFailure(result, failure === 'timeout' ? 'CHILD_TIMEOUT' : 'CHILD_OUTPUT_LIMIT');
            expect(Date.now() - started).toBeLessThan(3_000);
            expect(result.receipt?.cleanupSucceeded).toBe(true);
        });
    });

    it.each(['timeout', 'output', 'exit'])('terminates the isolated fake CLI group and inherited-pipe descendants before cleanup: %s', failure => {
        const leaderFile = join(base, 'fake-leader.pid');
        const descendantFile = join(base, 'fake-descendant.pid');
        // PIDs are fixture-only control data in owner-only files, never emitted or added to the DTO.
        const descendant = `require('node:fs').writeFileSync(${JSON.stringify(descendantFile)}, String(process.pid), {mode:0o600}); setInterval(() => {}, 100);`;
        const body = `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(leaderFile)}, String(process.pid), {mode:0o600});
require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:['ignore','inherit','inherit']});
setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(descendantFile)})) return;
    ${failure === 'output' ? "process.stdout.write('x'.repeat(600 * 1024));" : failure === 'exit' ? 'process.exit(7);' : ''}
}, 10);`;
        writeFileSync(cliPath, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
        delete dependencies.runChild;
        dependencies.childTimeoutMs = 1_500;
        const started = Date.now();
        return run('--dry-run').then(result => {
            assertSafeFailure(result, failure === 'timeout' ? 'CHILD_TIMEOUT' : failure === 'output' ? 'CHILD_OUTPUT_LIMIT' : 'CHILD_FAILED');
            expect(Date.now() - started).toBeLessThan(4_000);
            for (const path of [leaderFile, descendantFile]) {
                const pid = Number(readFileSync(path, 'utf8'));
                expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
                let terminated = false;
                try { process.kill(pid, 0); } catch (error) { terminated = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
                expect(terminated).toBe(true);
            }
            expect(result.receipt).toMatchObject({ originalsUnchanged: true, cleanupSucceeded: true });
            expect(readdirSync(base).some(name => name.startsWith('supabase-private-source-'))).toBe(false);
            for (const source of manifest.privateSources) {
                expect(HASH(readFileSync(source.path))).toBe(source.sha256);
                expect(lstatSync(source.path).mode & 0o777).toBe(0o600);
            }
        });
    });

    it('does not inspect originals or clean its workdir when child lifetime is unconfirmed', async () => {
        const removeTemp = vi.fn(); dependencies.removeTemp = removeTemp;
        behavior = request => {
            if (request.args[0] === '--version') throw new PrivateSourceError('CHILD_TERMINATION_UNCONFIRMED');
        };
        const result = await run('--dry-run');
        assertSafeFailure(result, 'CHILD_TERMINATION_UNCONFIRMED');
        expect(result.receipt).toMatchObject({ originalsUnchanged: false, cleanupSucceeded: false, plannedMigrationCount: null });
        expect(removeTemp).not.toHaveBeenCalled();
        expect(readdirSync(base).some(name => name.startsWith('supabase-private-source-'))).toBe(true);
    });

    it.each(['source', 'tempSymlink', 'tempCopy', 'tempMetadata'])('revalidates before later children after a fake child race: %s', tamper => {
        behavior = request => {
            if (request.args[0] !== '--version') return;
            if (tamper === 'source') { writeFileSync(manifest.privateSources[0].path, 'SELECT 999;\n'); return; }
            const workdir = request.env.TMPDIR;
            const path = join(workdir, 'supabase', 'migrations', manifest.privateSources[0].filename);
            if (tamper === 'tempSymlink') { rmSync(path); symlinkSync(manifest.privateSources[1].path, path); }
            if (tamper === 'tempCopy') { rmSync(path); writeFileSync(path, 'SELECT 1;\n', { mode: 0o600 }); }
            if (tamper === 'tempMetadata') writeFileSync(join(workdir, 'supabase', '.temp', 'project-ref'), 'tampered');
        };
        return run('--dry-run').then(result => {
            assertSafeFailure(result, tamper === 'source' ? 'ORIGINALS_CHANGED' : 'SOURCE_MISMATCH');
            expect(calls).toHaveLength(1); expect(result.receipt?.cleanupSucceeded).toBe(true);
        });
    });

    it.each(['pending', 'failure', 'contaminated', 'unproven', 'nonzero'])('accepts only explicit successful pending zero: %s', resultKind => {
        dryOverride = { stdout: resultKind === 'pending' ? 'Would push these migrations:\nFAKE_RAW_SECRET\n' : resultKind === 'unproven' ? '' : 'Remote database is up to date.\n',
            stderr: resultKind === 'contaminated' ? 'FAKE_RAW_SECRET\n' : '', exitCode: resultKind === 'failure' || resultKind === 'nonzero' ? 1 : 0 };
        return run('--dry-run').then(result => { assertSafeFailure(result); expect(calls.filter(call => call.args.includes('push') && !call.args.includes('--help'))).toHaveLength(1); });
    });

    it.each(['bytes', 'replace', 'permissions', 'symlink', 'metadata', 'env', 'extraLocal'])('checks original bytes and identity after execution: %s', tamper => {
        behavior = request => {
            if (!request.args.includes('push') || request.args.includes('--help')) return;
            const source = manifest.privateSources[0].path;
            if (tamper === 'bytes') writeFileSync(source, 'SELECT 999;\n');
            if (tamper === 'replace') { const buffer = readFileSync(source); rmSync(source); writeFileSync(source, buffer, { mode: 0o600 }); }
            if (tamper === 'permissions') chmodSync(source, 0o644);
            if (tamper === 'symlink') { renameSync(source, `${source}.real`); symlinkSync(`${source}.real`, source); }
            if (tamper === 'metadata') chmodSync(join(root, 'supabase', '.temp', 'project-ref'), 0o600);
            if (tamper === 'env') writeFileSync(join(root, '.env.local'), 'CHANGED=true\n');
            if (tamper === 'extraLocal') writeFileSync(join(root, 'supabase', 'migrations', '20260401000000_extra.sql'), 'SELECT 1;\n');
        };
        return run('--dry-run', true).then(result => {
            assertSafeFailure(result, 'ORIGINALS_CHANGED');
            expect(result.receipt?.originalsUnchanged).toBe(false);
            expect(result.receipt?.cleanupSucceeded).toBe(true);
            expect(calls.filter(call => call.args.includes('push') && !call.args.includes('--help'))).toHaveLength(1);
        });
    });

    it('fails when the canonical root stops being main during verification', async () => {
        delete dependencies.resolveRoot;
        behavior = request => {
            if (request.args.includes('push') && !request.args.includes('--help')) git(['symbolic-ref', 'HEAD', 'refs/heads/codex/changed']);
        };
        assertSafeFailure(await run('--dry-run'), 'ORIGINALS_CHANGED');
    });

    it('fails closed when cleanup cannot be established', async () => {
        dependencies.removeTemp = async () => { throw new Error('FAKE_RAW_SECRET'); };
        const result = await run('--dry-run'); assertSafeFailure(result, 'CLEANUP_FAILED');
        expect(result.receipt?.cleanupSucceeded).toBe(false);
    });

    it('detects a lying cleanup seam that leaves the owned temporary directory', async () => {
        dependencies.removeTemp = async () => undefined;
        const result = await run('--dry-run'); assertSafeFailure(result, 'CLEANUP_FAILED');
    });

    it('removes its temporary workdir on remote failure and preserves originals', async () => {
        queryOverride = '[]';
        const result = await run('--dry-run'); assertSafeFailure(result, 'REMOTE_MISMATCH');
        expect(result.receipt).toMatchObject({ originalsUnchanged: true, cleanupSucceeded: true });
        expect(readdirSync(base).sort()).toEqual(['fake-supabase', 'private', 'root']);
    });
});
