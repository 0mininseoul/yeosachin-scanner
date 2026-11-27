import { createServer } from 'node:http';
import { assertQaCloudIdentity, qaWorkerConfig, placeholder } from './config';
import { origin, taskPath } from './scope';
import { APIFY_CREDENTIAL_TOKEN_ENV } from '@/lib/services/instagram/providers/types';
import { handleQaWorker } from './handler';

const { role } = qaWorkerConfig();
if (!Reflect.get(globalThis, Symbol.for('dev-standard-qa-egress'))) throw new Error('DEV_STANDARD_QA_EGRESS_REQUIRED');
// Production credential-slot selection remains exercised using inert fixture values.
for (const key of Object.values(APIFY_CREDENTIAL_TOKEN_ENV)) process.env[key] = placeholder;
const port = Number(process.env.PORT ?? 8080);
const server = createServer(async (req, res) => {
    try {
        if (req.method !== 'POST' || req.url !== taskPath(role)) { res.writeHead(404).end(); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const part of req) {
            const bytes = Buffer.from(part);
            size += bytes.length;
            if (size > 16_384) { res.writeHead(413).end(); return; }
            chunks.push(bytes);
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
        const response = await handleQaWorker(new Request(origin(role) + taskPath(role), {
            method: 'POST', headers, body: Buffer.concat(chunks).toString('utf8'),
        }));
        res.writeHead(response.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(503).end(); }
});
void assertQaCloudIdentity(role).then(() => server.listen(port, '0.0.0.0')).catch(() => {
    console.error('DEV_STANDARD_QA_CLOUD_IDENTITY_REJECTED'); process.exitCode = 1;
});
