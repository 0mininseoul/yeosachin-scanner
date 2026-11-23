import { closeSync, mkdtempSync, openSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { normalizeKoreanMobileNumber } from '../../lib/services/identity/phone-number.ts';
import { campaignClosesAt } from '../../public/cherry/campaign.mjs';

const landingRoot = '../../public/cherry/';
const landingPage = [landingRoot + 'landing.html', 'text/html; charset=utf-8'];
const staticFiles = new Map([
  ['/', landingPage],
  ['/cherry', landingPage],
  ['/cherry/', landingPage],
  ['/cherry/landing.css', [landingRoot + 'landing.css', 'text/css; charset=utf-8']],
  ['/cherry/landing.js', [landingRoot + 'landing.js', 'text/javascript; charset=utf-8']],
  ['/cherry/intro.js', [landingRoot + 'intro.js', 'text/javascript; charset=utf-8']],
  ['/cherry/campaign.mjs', [landingRoot + 'campaign.mjs', 'text/javascript; charset=utf-8']],
  ['/cherry/logo.png', [landingRoot + 'logo.png', 'image/png']],
  ['/cherry/og.jpg', [landingRoot + 'og.jpg', 'image/jpeg']],
  ['/cherry/og-crush.jpg', [landingRoot + 'og-crush.jpg', 'image/jpeg']],
  ['/og/', ['./og/index.html', 'text/html; charset=utf-8']],
  ...['a', 'b', 'b-crush', 'c'].map(name => [`/og/${name}.html`, [`./og/${name}.html`, 'text/html; charset=utf-8']]),
  ...['og', 'board'].map(name => [`/og/${name}.css`, [`./og/${name}.css`, 'text/css; charset=utf-8']]),
  ['/private-concepts/', ['./private-concepts/index.html', 'text/html; charset=utf-8']],
  ...['a', 'b', 'c'].map(name => [`/private-concepts/${name}.html`, [`./private-concepts/${name}.html`, 'text/html; charset=utf-8']]),
  ...['concepts', 'board'].map(name => [`/private-concepts/${name}.css`, [`./private-concepts/${name}.css`, 'text/css; charset=utf-8']]),
  ['/cherry/assets/kakao-symbol.svg', [landingRoot + 'assets/kakao-symbol.svg', 'image/svg+xml']],
  ['/cherry/assets/notification-bell.jpg', [landingRoot + 'assets/notification-bell.jpg', 'image/jpeg']],
  ...['barlow-condensed-bold.woff2', 'Paperlogy-4Regular.woff2', 'Paperlogy-8ExtraBold.woff2'].map(name => [
    `/cherry/assets/${name}`, [landingRoot + `assets/${name}`, 'font/woff2'],
  ]),
  ['/logo-concepts/', ['./logo-concepts/index.html', 'text/html; charset=utf-8']],
  ['/logo-concepts/board.css', ['./logo-concepts/board.css', 'text/css; charset=utf-8']],
  ...['a-bell', 'b-links', 'c-bird', 'd-envelope'].map(name => [
    `/logo-concepts/${name}.png`, [`./logo-concepts/${name}.png`, 'image/png'],
  ]),
  ['/cherry-logo-concepts/', ['./cherry-logo-concepts/index.html', 'text/html; charset=utf-8']],
  ['/cherry-logo-concepts/board.css', ['./cherry-logo-concepts/board.css', 'text/css; charset=utf-8']],
  ['/cherry-logo-concepts/render.html', ['./cherry-logo-concepts/render.html', 'text/html; charset=utf-8']],
  ['/cherry-logo-concepts/render.css', ['./cherry-logo-concepts/render.css', 'text/css; charset=utf-8']],
  ['/cherry-logo-concepts/render.js', ['./cherry-logo-concepts/render.js', 'text/javascript; charset=utf-8']],
  ['/intro-concepts/', ['./intro-concepts/index.html', 'text/html; charset=utf-8']],
  ['/intro-concepts/intros.css', ['./intro-concepts/intros.css', 'text/css; charset=utf-8']],
  ['/intro-concepts/intros.js', ['./intro-concepts/intros.js', 'text/javascript; charset=utf-8']],
  ['/timer-concepts/', ['./timer-concepts/index.html', 'text/html; charset=utf-8']],
  ['/timer-concepts/timers.css', ['./timer-concepts/timers.css', 'text/css; charset=utf-8']],
  ['/timer-concepts/timers.js', ['./timer-concepts/timers.js', 'text/javascript; charset=utf-8']],
]);

// Directories whose files are served as-is (3D bundles and hero media).
const staticDirectories = [
  ['/cherry/3d/', landingRoot + '3d/'],
  ['/cherry/assets/hero/', landingRoot + 'assets/hero/'],
  ['/cherry-logo-concepts/', './cherry-logo-concepts/'],
  ['/og/', './og/'],
];
const contentTypes = {
  '.js': 'text/javascript; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function directoryResource(pathname) {
  for (const [prefix, directory] of staticDirectories) {
    if (!pathname.startsWith(prefix)) continue;
    const name = pathname.slice(prefix.length);
    const type = contentTypes[extname(name).toLowerCase()];
    if (!type || !/^[\w.-]+$/.test(name)) return null;
    return [directory + name, type];
  }
  return null;
}

const port = Number(process.env.NAMCHIN_PREVIEW_PORT ?? 4327);
const previewStart = process.env.NAMCHIN_PREVIEW_NOW;
const clockOffset = previewStart ? Date.parse(previewStart) - Date.now() : 0;
if (!Number.isFinite(clockOffset)) throw new Error('NAMCHIN_PREVIEW_NOW must be an ISO 8601 timestamp.');
const dbPath = process.env.NAMCHIN_PREVIEW_DB
  ? resolve(process.env.NAMCHIN_PREVIEW_DB)
  : join(mkdtempSync(join(tmpdir(), 'namchin-demand-')), 'responses.sqlite');
closeSync(openSync(dbPath, 'a', 0o600));
const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS launch_reservations (
    email TEXT PRIMARY KEY NOT NULL COLLATE NOCASE,
    phone TEXT NOT NULL UNIQUE,
    launch_consent_at TEXT NOT NULL
  );
`);
const register = db.prepare(`
  INSERT INTO launch_reservations (email, phone, launch_consent_at)
  VALUES (?, ?, ?)
  ON CONFLICT DO NOTHING
`);
const countRegistrations = db.prepare('SELECT COUNT(*) AS count FROM launch_reservations');
let pageViews = 0;

const responseHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'self'; form-action 'self'",
};

function json(response, status, data) {
  response.writeHead(status, { ...responseHeaders, 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

const reservationSchema = z.object({
  email: z.string().trim().max(254).email().toLowerCase(),
  phone: z.string().max(24),
  consent: z.literal(true),
  privateAck: z.literal(true),
}).strict();

async function readRegistration(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2_048) return null;
    chunks.push(chunk);
  }
  const parsed = reservationSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
  if (!parsed.success) return null;
  const phone = normalizeKoreanMobileNumber(parsed.data.phone);
  return phone ? { email: parsed.data.email, phone } : null;
}

const server = createServer(async (request, response) => {
  const livePort = server.address().port;
  const host = request.headers.host;
  if (host !== `127.0.0.1:${livePort}` && host !== `localhost:${livePort}`) {
    return json(response, 403, { error: 'local_preview_only' });
  }
  const pathname = request.url?.split('?')[0];

  if (request.method === 'POST' && pathname === '/api/cherry/reservations') {
    if (request.headers.origin !== `http://${host}`) return json(response, 403, { error: 'origin' });
    if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
      return json(response, 415, { error: 'content_type' });
    }
    let submission;
    try {
      submission = await readRegistration(request);
    } catch {
      return json(response, 400, { error: 'invalid_registration' });
    }
    if (!submission) return json(response, 400, { error: 'invalid_registration' });

    const now = Date.now() + clockOffset;
    if (now >= campaignClosesAt) return json(response, 410, { status: 'closed' });
    try {
      const { email, phone } = submission;
      register.run(email, phone, new Date(now).toISOString());
      return json(response, 200, { received: true });
    } catch {
      return json(response, 503, { error: 'unavailable' });
    }
  }

  if (request.method === 'GET' && pathname === '/api/cherry/reservations') {
    const serverTime = Date.now() + clockOffset;
    return json(response, 200, { status: serverTime < campaignClosesAt ? 'open' : 'closed', serverTime });
  }

  if (request.method === 'GET' && pathname === '/preview/stats') {
    return json(response, 200, { pageViews, registrations: countRegistrations.get().count });
  }

  if (pathname === '/cherry/') {
    response.writeHead(308, { ...responseHeaders, Location: '/cherry' + (request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '') });
    return response.end();
  }

  if (request.method === 'GET' && pathname === '/privacy') {
    response.writeHead(302, { ...responseHeaders, Location: 'https://yeosachin.com/privacy#namchin' });
    return response.end();
  }

  const resource = staticFiles.get(pathname) ?? directoryResource(pathname);
  if ((request.method !== 'GET' && request.method !== 'HEAD') || !resource) {
    return json(response, 404, { error: 'not_found' });
  }
  try {
    const [file, type] = resource;
    const data = readFileSync(new URL(file, import.meta.url));
    if (resource === landingPage && request.method === 'GET') pageViews += 1;
    response.writeHead(200, { ...responseHeaders, 'Content-Type': type, 'Content-Length': data.length });
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch {
    return json(response, 404, { error: 'not_found' });
  }
});

server.listen(port, '127.0.0.1', () => {
  const previewUrl = `http://127.0.0.1:${server.address().port}`;
  console.log(`미리보기 ${previewUrl}/cherry\n테스트 집계 ${previewUrl}/preview/stats\n테스트 데이터 ${dbPath}`);
});
