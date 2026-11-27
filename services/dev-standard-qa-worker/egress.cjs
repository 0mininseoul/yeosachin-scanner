// Preloaded by this QA-only image before any SDK caches the network primitives.
const net = require('node:net');
const { syncBuiltinESMExports } = require('node:module');
const allowed = new Set(['bgamojfpkxnnumfvkron.supabase.co', 'storage.googleapis.com',
    'cloudtasks.googleapis.com', 'www.googleapis.com', 'oauth2.googleapis.com', 'www.gstatic.com']);
const metadata = new Set(['metadata.google.internal', '169.254.169.254']);
const endpoint = process.env.ANALYSIS_V2_RESULT_IMAGE_R2_ENDPOINT || '';
if (/^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(endpoint)) {
    const host = new URL(endpoint).hostname;
    allowed.add(host);
    allowed.add('gen-lang-client-0311522474-dev-live-results.' + host);
}
const denied = () => { throw new Error('DEV_STANDARD_QA_NETWORK_DENIED'); };
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    const input = Array.isArray(args[0]) ? args[0] : args;
    const o = typeof input[0] === 'object' && input[0] !== null ? input[0] : { port: input[0], host: input[1] };
    const host = o.hostname || o.host;
    if (o.path || !(allowed.has(host) && Number(o.port) === 443 || metadata.has(host) && Number(o.port) === 80)) return denied();
    return originalConnect.apply(this, args);
};
const actualFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.href !== 'data:,standard-cloud-six-vertex' && (url.username || url.password ||
        !(url.protocol === 'https:' && !url.port && allowed.has(url.hostname) ||
          url.protocol === 'http:' && !url.port && metadata.has(url.hostname)))) return denied();
    return actualFetch(input, init);
};
syncBuiltinESMExports();
globalThis[Symbol.for('dev-standard-qa-egress')] = true;
