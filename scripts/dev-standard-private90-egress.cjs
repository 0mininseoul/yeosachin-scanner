// This preload applies only to the private QA runner. The SQL engine, R2 and SDKs are local.
const dns = require('node:dns');
const net = require('node:net');
const dgram = require('node:dgram');
const { syncBuiltinESMExports } = require('node:module');
const cloud = process.env.PRIVATE90_FULL_REPLAY === 'cloud';
const api = new Set(['storage.googleapis.com', 'cloudkms.googleapis.com', 'secretmanager.googleapis.com']);
const metadata = new Set(['metadata.google.internal', 'metadata.google.internal.', '169.254.169.254']);
const permitted = host => cloud && (api.has(host) || metadata.has(host));
const denied = () => { throw new Error('PRIVATE90_NETWORK_DENIED'); };
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    const input = Array.isArray(args[0]) ? args[0] : args;
    const options = typeof input[0] === 'object' && input[0] !== null ? input[0] : { port: input[0], host: input[1] };
    const host = options.hostname || options.host;
    if (options.path || !permitted(host) || Number(options.port) !== (api.has(host) ? 443 : 80)) return denied();
    return connect.apply(this, args);
};
for (const resolver of [dns, dns.promises]) {
    const lookup = resolver.lookup;
    resolver.lookup = function (host, ...args) {
        if (!permitted(host)) return denied();
        return lookup.call(this, host, ...args);
    };
    for (const method of Object.keys(resolver).filter(name => name === 'reverse' || name.startsWith('resolve') || name === 'lookupService'))
        if (typeof resolver[method] === 'function') resolver[method] = denied;
}
// No application stage uses datagrams or a custom resolver. DNS is limited to the system lookup above.
dgram.createSocket = denied;
for (const resolver of [dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
    for (const name of Object.getOwnPropertyNames(resolver))
        if (name === 'reverse' || name.startsWith('resolve')) resolver[name] = denied;
}
syncBuiltinESMExports();
globalThis[Symbol.for('private90-egress')] = true;
