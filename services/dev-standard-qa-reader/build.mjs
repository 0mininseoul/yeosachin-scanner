import { build } from 'esbuild';
if (process.argv.length !== 3) throw new Error('One output bundle path is required');
const result = await build({
    entryPoints: ['services/dev-standard-qa-reader/reader.mjs'], outfile: process.argv[2],
    bundle: true, platform: 'node', target: 'node24', format: 'cjs', metafile: true, logLevel: 'silent',
    external: ['sharp', 'playwright-core'],
});
const runtimeImports = Object.values(result.metafile.outputs).flatMap(out => out.imports.map(x => x.path));
if (runtimeImports.some(path => /^(?:@google\/|apify-client|resend)/.test(path))) throw new Error('Unexpected reader provider');
