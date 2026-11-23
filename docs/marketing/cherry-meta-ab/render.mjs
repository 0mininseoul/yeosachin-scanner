// Renders every concept × variant × size to out/ with the installed Google Chrome.
// Run from the repository root:  node docs/marketing/cherry-meta-ab/render.mjs [c=1] [v=bf]
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const concepts = { 1: 'question', 2: 'alimtalk', 3: 'reveal', 4: 'chat' };
const sizes = { feed: ['4x5', 1080, 1350], story: ['9x16', 1080, 1920] };
const filter = Object.fromEntries(process.argv.slice(2).map((arg) => arg.split('=')));

const out = path.join(here, 'out');
mkdirSync(out, { recursive: true });
// A private profile keeps headless Chrome from attaching to the user's running browser.
const profile = mkdtempSync(path.join(tmpdir(), 'cherry-ad-'));
try {
  for (const [c, slug] of Object.entries(concepts)) {
    if (filter.c && filter.c !== c) continue;
    for (const v of ['bf', 'crush']) {
      if (filter.v && filter.v !== v) continue;
      for (const [s, [ratio, width, height]] of Object.entries(sizes)) {
        const url = new URL(pathToFileURL(path.join(here, 'ad.html')));
        url.search = new URLSearchParams({ c, v, s }).toString();
        const file = path.join(out, `c${c}-${slug}_${v}_${ratio}.png`);
        execFileSync(chrome, [
          '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
          `--user-data-dir=${profile}`, '--force-device-scale-factor=1',
          '--allow-file-access-from-files', '--virtual-time-budget=4000',
          `--window-size=${width},${height}`, `--screenshot=${file}`, url.href,
        ], { stdio: 'ignore' });
        console.log(path.relative(process.cwd(), file));
      }
    }
  }
} finally {
  rmSync(profile, { recursive: true, force: true });
}
