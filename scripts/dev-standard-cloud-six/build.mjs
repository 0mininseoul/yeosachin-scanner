import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../../',import.meta.url));
if (process.argv.length!==3) throw new Error('Expected a single output bundle path');
const result=await build({
    absWorkingDir:root,entryPoints:['scripts/dev-standard-cloud-six/dispatch.ts'],outfile:process.argv[2],
    bundle:true,packages:'external',platform:'node',target:'node24',format:'cjs',metafile:true,
    alias:{
        'server-only':path.join(root,'node_modules/server-only/empty.js'),
        '@google-cloud/tasks':path.join(root,'services/dev-standard-qa-worker/tasks.ts'),
        '@google/genai/node':path.join(root,'tests/analysis/execution/fixtures/standard-cloud-vertex.ts'),
        'resend':path.join(root,'services/dev-standard-qa-worker/providers.ts'),
        'apify-client':path.join(root,'services/dev-standard-qa-worker/providers.ts'),
    },
    plugins:[{name:'official-qa-tasks',setup(builder){
        builder.onResolve({filter:/^@google-cloud\/tasks$/},args=>args.importer.endsWith('/services/dev-standard-qa-worker/tasks.ts')
            ? {path:'@google-cloud/tasks',external:true}:undefined);
    }}],
});
const imports=Object.values(result.metafile.outputs).flatMap(v=>v.imports.map(i=>i.path));
if (imports.some(name=>['apify-client','@google/genai/node','resend'].includes(name))) throw new Error('QA_DRIVER_INCLUDES_REMOTE_PROVIDER');
