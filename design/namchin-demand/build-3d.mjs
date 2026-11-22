// Bundles the landing page's three.js scenes into public/namchin/3d/.
// Run from the repository root after `npm ci`:  node design/namchin-demand/build-3d.mjs
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const source = fileURLToPath(new URL('./three/', import.meta.url));
const outdir = fileURLToPath(new URL('../../public/namchin/3d/', import.meta.url));

rmSync(outdir, { recursive: true, force: true });
const result = await build({
  entryPoints: { hero: `${source}hero.js`, trust: `${source}trust.js` },
  outdir,
  bundle: true,
  splitting: true,
  format: 'esm',
  minify: true,
  target: ['es2020', 'safari15'],
  chunkNames: 'shared-[hash]',
  legalComments: 'eof',
  metafile: true,
  logLevel: 'info',
});

for (const [file, { bytes }] of Object.entries(result.metafile.outputs)) {
  console.log(`${file.replace(/^.*public\//, 'public/')}  ${(bytes / 1024).toFixed(1)} KB`);
}
