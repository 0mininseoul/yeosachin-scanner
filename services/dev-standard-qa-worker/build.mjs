import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, '../..');
const local = name => path.join(dir, name);
const standard = name => path.join(root, 'tests/analysis/execution/fixtures', name);

export async function bundleQaWorker(outfile) {
    const replacements = new Map([
        ['apify-client', local('providers.ts')], ['resend', local('providers.ts')],
        ['@google/genai/node', standard('standard-cloud-vertex.ts')],
        ['@google-cloud/tasks', local('tasks.ts')], ['server-only', path.join(root, 'node_modules/server-only/empty.js')],
        [path.join(root, 'lib/services/analysis/paid-worker-service'), local('scope.ts')],
        [path.join(root, 'lib/services/instagram/providers/selfhosted'), local('profile.ts')],
        [path.join(root, 'lib/services/media/secure-image-fetch'), local('media.ts')],
        [path.join(root, 'lib/supabase/admin'), local('admin.ts')],
    ]);
    const result = await build({
        absWorkingDir: root, entryPoints: [local('server.ts')], platform: 'node', target: 'node24', format: 'cjs',
        bundle: true, packages: 'external', metafile: true, write: Boolean(outfile), outfile,
        plugins: [{ name: 'dev-standard-qa-only', setup(plugin) {
            plugin.onResolve({ filter: /.*/ }, args => {
                const key = args.path.startsWith('@/') ? path.join(root, args.path.slice(2))
                    : args.path.startsWith('.') ? path.resolve(args.resolveDir, args.path) : args.path;
                if (key === path.join(root, 'lib/observability/server')
                    && args.importer === path.join(root, 'app/api/analysis/v2/worker/route.ts'))
                    return { path: local('outcome-log.ts') };
                if (key === path.join(root, 'lib/constants/dev-ui')
                    && [path.join(root, 'lib/services/ai/gemini.ts'), path.join(root, 'lib/services/instagram/providers/apify-relationship.ts')].includes(args.importer))
                    return { path: local('provider-mode.ts') };
                const replacement = replacements.get(key);
                if (replacement && replacement !== args.importer) return { path: replacement };
            });
        } }],
    });
    const names = Object.keys(result.metafile.inputs);
    const imports = Object.values(result.metafile.outputs).flatMap(output => output.imports.map(i => i.path));
    const forbidden = /^(?:@google\/genai|apify-client|resend)(?:\/|$)/;
    if (imports.some(name => forbidden.test(name)) || names.some(name => /node_modules\/(?:@google\/genai|apify-client|resend)\//.test(name))
        || !['app/api/analysis/preflight/worker/route.ts', 'app/api/analysis/v2/worker/route.ts', 'lib/supabase/admin.ts',
            'lib/services/media/r2-result-image-store.ts', 'lib/services/analysis/v2-media-artifact-store.ts',
            'services/dev-standard-qa-worker/admin.ts', 'services/dev-standard-qa-worker/profile.ts', 'services/dev-standard-qa-worker/outcome-log.ts',
            'services/dev-standard-qa-worker/media.ts', 'services/dev-standard-qa-worker/provider-mode.ts',
            'tests/analysis/execution/fixtures/standard-cloud-vertex.ts', 'tests/analysis/execution/fixtures/standard-cloud-apify.ts'
        ].every(name => names.includes(name)) || !imports.includes('@google-cloud/tasks')) throw new Error('DEV_STANDARD_QA_BUNDLE_REJECTED');
    return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    if (process.argv.length !== 3) throw new Error('Expected one QA worker bundle output path');
    await bundleQaWorker(process.argv[2]);
}
