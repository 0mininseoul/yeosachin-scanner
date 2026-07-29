import { writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

function argument(name) {
    const index = process.argv.indexOf(name);
    const value = index >= 0 ? process.argv[index + 1] : undefined;
    if (!value || !isAbsolute(value)) {
        throw new Error(`Missing absolute ${name}`);
    }
    return value;
}

const outfile = argument('--outfile');
const metafile = argument('--metafile');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stub = resolve(root, 'scripts/replay-analysis-v2-job-supabase-stub.ts');

const result = await build({
    entryPoints: [resolve(root, 'scripts/replay-analysis-v2-job.ts')],
    outfile,
    alias: {
        '@/lib/supabase/admin': stub,
    },
    absWorkingDir: root,
    bundle: true,
    conditions: ['react-server'],
    format: 'esm',
    metafile: true,
    packages: 'external',
    platform: 'node',
    sourcemap: false,
    target: 'node24',
});

const resolvedGraph = [
    ...Object.keys(result.metafile.inputs),
    ...Object.values(result.metafile.outputs).flatMap(output => (
        output.imports.map(entry => entry.path)
    )),
].join('\n');
if (
    /supabase\/admin|supabase-js|result-store|attempt-store|lease-store|apify|(?:^|[/_-])r2(?:[/_.-]|$)|@google-cloud\/tasks|cloud-tasks|analysis-tasks|tasks-client|tasks-store|app\/api/i
        .test(resolvedGraph)
) {
    throw new Error('Replay job build contains a forbidden dependency');
}

// `original` is only the pre-alias source specifier. Omit it so this audit
// artifact describes the resolved graph that will actually execute.
const resolvedMetafile = JSON.parse(JSON.stringify(
    result.metafile,
    (key, value) => key === 'original' ? undefined : value,
));
await writeFile(metafile, `${JSON.stringify(resolvedMetafile, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
});
