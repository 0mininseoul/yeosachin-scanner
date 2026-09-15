import { execFile } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { canonicalDigest, EpochError, epochFail, type CapacityEpochPacket } from './contracts';
import { FetchProtectedTransport, type AuthenticatedProtectedTransport, type ProtectedTransport } from './platform';
import { VercelAdapter } from './vercel';
import {
    enqueuerIdentityFingerprint,
    PAID_ENQUEUER_IDENTITY_FINGERPRINT_VERSION,
    PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION,
    PREFLIGHT_ENQUEUER_IDENTITY_FINGERPRINT_VERSION,
    PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION,
} from '../../lib/services/analysis/legacy-analysis-public-readiness';

const READINESS_PATH = '/api/analysis/capacity/readiness';
const MAX_BYTES = 65_536;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Exact alias-bound public freeze, including the signed-test admission bypass. */
export function createFrozenGateReader(packet: CapacityEpochPacket, vercel: VercelAdapter): (leaseCheck: () => Promise<void>) => Promise<string> {
    return async leaseCheck => {
        const scope = packet.providerScope;
        const selector = { alias: scope.vercelProducerAlias, projectId: scope.vercelProjectId, teamId: scope.vercelTeamId };
        await leaseCheck();
        const before = await vercel.getAlias(selector);
        const phase = before?.deploymentId === scope.vercelExpectedOldDeploymentId ? 'old'
            : before?.deploymentId === scope.vercelDeploymentId ? 'desired' : null;
        if (!phase) epochFail('READINESS_INVALID');
        const expected = (phase === 'old' ? packet.oldManifest : packet.desiredManifest).readiness;
        const expectedManifest = phase === 'old' ? packet.oldManifest : packet.desiredManifest;
        await leaseCheck();
        const value = await vercel.readPublicReadiness({ url: `https://${scope.vercelProducerAlias}/api/analysis/capacity/readiness`, expected: {
            sourceSha: expected.sourceSha, legacyTargetResource: expected.legacyTargetResource,
            preflightProducerConfigFingerprintVersion: PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION,
            preflightProducerConfigFingerprint: expected.preflightFingerprint,
            paidProducerConfigFingerprintVersion: PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION,
            paidProducerConfigFingerprint: expected.paidFingerprint,
            preflightEnqueuerIdentityFingerprintVersion: PREFLIGHT_ENQUEUER_IDENTITY_FINGERPRINT_VERSION,
            preflightEnqueuerIdentityFingerprint: enqueuerIdentityFingerprint(
                'preflight', expectedManifest.roleSlots['preflight.enqueuer'].identity,
            ),
            paidEnqueuerIdentityFingerprintVersion: PAID_ENQUEUER_IDENTITY_FINGERPRINT_VERSION,
            paidEnqueuerIdentityFingerprint: enqueuerIdentityFingerprint(
                'paid', expectedManifest.roleSlots['paid.enqueuer'].identity,
            ),
            analysisV2AdmissionEnabled: false, earlybirdWebhookAutoAdmissionEnabled: false, ready: true,
        } });
        if (value.testEntitlementsEnabled !== false) epochFail('READINESS_INVALID');
        await leaseCheck();
        await vercel.getAlias({ ...selector, expectedDeploymentId: before!.deploymentId });
        await leaseCheck();
        return canonicalDigest({ deploymentId: before!.deploymentId, readiness: value });
    };
}

type Options = Readonly<{
    transport: AuthenticatedProtectedTransport;
    projectId: string;
    teamId: string;
    deploymentIds: readonly string[];
    publicReadinessOrigin: string;
    cwd?: string;
    publicTransport?: ProtectedTransport;
    /** Provider-free test seam; production executes the installed owner CLI. */
    runCli?: (deploymentId: string, signal?: AbortSignal) => Promise<string>;
}>;

function ownerCli(options: Options, deploymentId: string, signal?: AbortSignal): Promise<string> {
    const cwd = resolve(options.cwd ?? process.cwd());
    let cli: string;
    try {
        // The native CLI must use the same installed project/team binding.
        // Do not let it auto-link or accept inherited token/env overrides.
        const path = join(cwd, '.vercel', 'project.json');
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0 || stat.size > 8192) throw new Error();
        const link = JSON.parse(readFileSync(path, 'utf8'));
        if (link.projectId !== options.projectId || link.orgId !== options.teamId) throw new Error();
        cli = realpathSync(join(dirname(process.execPath), 'vercel'));
        const cliStat = lstatSync(cli);
        if (!cliStat.isFile() || (cliStat.mode & 0o022) !== 0) throw new Error();
    } catch { epochFail('OWNER_AUTH_UNAVAILABLE'); }
    return new Promise((resolveOutput, reject) => {
        execFile(process.execPath, [cli, 'curl', READINESS_PATH, '--deployment', deploymentId,
            '--', '--silent', '--max-time', '12',
            '--max-redirs', '0', '--write-out', '\n%{http_code}'], {
            cwd, shell: false, timeout: 15_000, signal, maxBuffer: MAX_BYTES + 16,
            env: { PATH: `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
                LANG: 'C', LC_ALL: 'C', NODE_ENV: 'production', NO_COLOR: '1', VERCEL_TELEMETRY_DISABLED: '1' },
            encoding: 'utf8',
        }, (error, stdout) => {
            // Never expose CLI stderr, command objects, or credential diagnostics.
            if (error) {
                reject(new EpochError(error.killed || error.name === 'AbortError' ? 'ADAPTER_TIMEOUT' : 'ADAPTER_RESPONSE_INVALID'));
                return;
            }
            resolveOutput(stdout);
        });
    });
}

/**
 * Public alias evidence remains unauthenticated. Only an exact, independently
 * read deployment in this project/team may use native CLI protection bypass.
 * The bypass grants transport access; normal raw readiness/SHA checks remain.
 */
export function createOwnerReadinessTransport(options: Options): ProtectedTransport {
    if (!ID.test(options.projectId) || !ID.test(options.teamId) || options.deploymentIds.length < 1
        || options.deploymentIds.length > 2 || options.deploymentIds.some(id => !ID.test(id))) epochFail('ADAPTER_REQUEST_INVALID');
    let publicOrigin: string;
    try {
        const url = new URL(options.publicReadinessOrigin);
        if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) throw new Error();
        publicOrigin = url.origin;
    } catch { epochFail('ADAPTER_REQUEST_INVALID'); }
    const direct = options.publicTransport ?? new FetchProtectedTransport(MAX_BYTES);
    const adapter = new VercelAdapter({ transport: options.transport, publicReadinessOrigin: publicOrigin });
    const runCli = options.runCli ?? ((id, signal) => ownerCli(options, id, signal));
    return {
        async request(request, signal) {
            let url: URL;
            try { url = new URL(request.url); } catch { epochFail('ADAPTER_REQUEST_INVALID'); }
            if (request.method !== 'GET' || request.body !== undefined || url.protocol !== 'https:'
                || url.username || url.password || url.port || url.search || url.hash || url.pathname !== READINESS_PATH
                || Object.entries(request.headers).some(([key, value]) => key.toLowerCase() !== 'accept' || value !== 'application/json')) epochFail('ADAPTER_NOT_ALLOWED');
            if (url.origin === publicOrigin) return direct.request(request, signal);
            if (!/^[a-z0-9-]+\.vercel\.app$/.test(url.hostname)) epochFail('ADAPTER_NOT_ALLOWED');
            const matches = [];
            for (const deploymentId of new Set(options.deploymentIds)) {
                const deployment = await adapter.getDeployment({ projectId: options.projectId, teamId: options.teamId, deploymentId });
                if (deployment.origin === url.origin && deployment.readyState === 'READY') matches.push(deployment);
            }
            if (matches.length !== 1) epochFail('ADAPTER_NOT_ALLOWED');
            const raw = await runCli(matches[0]!.id, signal);
            if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_BYTES + 4) epochFail('ADAPTER_RESPONSE_INVALID');
            const match = /\n([1-5][0-9]{2})$/.exec(raw);
            if (!match) epochFail('ADAPTER_RESPONSE_INVALID');
            const status = Number(match[1]);
            if (status >= 300 && status < 400) epochFail('ADAPTER_REDIRECT');
            return { status, body: raw.slice(0, match.index), headers: { 'content-type': 'application/json' }, url: request.url };
        },
    };
}
