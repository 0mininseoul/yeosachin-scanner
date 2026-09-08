import {
    EpochError,
    canonicalDigest,
    epochFail,
    isObject,
    type ReadinessContract,
} from './contracts';
import {
    AuthenticatedProtectedTransport,
    FetchProtectedTransport,
    type ProtectedTokenProvider,
    parseProtectedObject,
    type ProtectedHttpResponse,
    type ProtectedTransport,
} from './platform';
import {
    assertPublicReadiness,
    parsePublicReadinessJson,
    type PublicReadinessExpected,
} from '../../lib/services/analysis/public-readiness-contract';
import type { LegacyPublicReadiness } from '../../lib/services/analysis/legacy-analysis-public-readiness';
import { requireLeaseCheck, type LeaseCheck } from './lease-capability';

const HOSTS = new Set(['api.vercel.com']);
const DEPLOYMENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PROJECT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TEAM_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHA = /^[0-9a-f]{40}$/;
const ALIAS = /^[A-Za-z0-9.-]{1,253}$/;

function fail(code: 'ADAPTER_REQUEST_INVALID' | 'ADAPTER_RESPONSE_INVALID' | 'ADAPTER_NOT_ALLOWED' | 'ADAPTER_TIMEOUT' | 'ADAPTER_REDIRECT' | 'READINESS_INVALID' | 'SOURCE_INVALID' | 'OBSERVATION_RACE' | 'LOCK_LOST'): never {
    epochFail(code);
}

function object(value: unknown): Record<string, unknown> {
    if (!isObject(value)) fail('ADAPTER_RESPONSE_INVALID');
    return value;
}

type PublicReadinessFetcher = (url: string, signal?: AbortSignal) => Promise<ProtectedHttpResponse>;

export type VercelDeploymentObservation = Readonly<{
    id: string;
    sourceSha: string;
    readyState: string;
    origin: string;
    target: string | null;
    aliasNames: readonly string[];
    digest: string;
}>;

export type VercelAdapterOptions = Readonly<{
    transport: AuthenticatedProtectedTransport;
    publicTransport?: ProtectedTransport;
    readinessFetcher?: PublicReadinessFetcher;
    publicReadinessOrigin: string;
    /** Optional independently reviewed team slug; never derive it from projectId. */
    teamSlug?: string;
    readinessTimeoutMs?: number;
}>;

/** Vercel's bearer token is deliberately supplied independently of Google ADC. */
export function createVercelProtectedTransport(options: Readonly<{
    tokenProvider: ProtectedTokenProvider;
    transport?: ProtectedTransport;
    maxResponseBytes?: number;
    timeoutMs?: number;
}>): AuthenticatedProtectedTransport {
    return new AuthenticatedProtectedTransport({
        transport: options.transport ?? new FetchProtectedTransport(options.maxResponseBytes),
        tokenProvider: options.tokenProvider,
        timeoutMs: options.timeoutMs,
        maxResponseBytes: options.maxResponseBytes,
    });
}

/** Vercel deployment/alias adapter plus strict raw v3 readiness consumption. */
export class VercelAdapter {
    private readonly transport: AuthenticatedProtectedTransport;
    private readonly readinessFetcher: PublicReadinessFetcher;
    private readonly publicReadinessOrigin: string;
    private readonly teamSlug?: string;
    private readonly readinessTimeoutMs: number;

    constructor(options: VercelAdapterOptions) {
        this.transport = options.transport;
        let publicOrigin: URL;
        try { publicOrigin = new URL(options.publicReadinessOrigin); } catch { fail('ADAPTER_REQUEST_INVALID'); }
        if (publicOrigin.protocol !== 'https:' || publicOrigin.username || publicOrigin.password || publicOrigin.port || publicOrigin.pathname !== '/' || publicOrigin.search || publicOrigin.hash) fail('ADAPTER_REQUEST_INVALID');
        this.publicReadinessOrigin = publicOrigin.origin;
        if (options.teamSlug !== undefined && !PROJECT_ID.test(options.teamSlug)) fail('ADAPTER_REQUEST_INVALID');
        this.teamSlug = options.teamSlug;
        const timeoutMs = options.readinessTimeoutMs ?? 15_000;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) fail('ADAPTER_REQUEST_INVALID');
        this.readinessTimeoutMs = timeoutMs;
        const publicTransport = options.publicTransport ?? new FetchProtectedTransport(65_536);
        this.readinessFetcher = options.readinessFetcher ?? (async (url: string, signal?: AbortSignal) => {
            let parsed: URL;
            try {
                parsed = new URL(url);
            } catch {
                fail('ADAPTER_REQUEST_INVALID');
            }
            let response: ProtectedHttpResponse;
            try {
                response = await publicTransport.request({
                    method: 'GET',
                    url: parsed.toString(),
                    headers: { accept: 'application/json' },
                }, signal);
            } catch (error) {
                if (error instanceof EpochError) throw error;
                fail('ADAPTER_TIMEOUT');
            }
            return response;
        });
    }

    async getDeployment(options: Readonly<{ projectId: string; teamId: string; deploymentId: string; teamSlug?: string }>): Promise<VercelDeploymentObservation> {
        if (!PROJECT_ID.test(options.projectId) || !TEAM_ID.test(options.teamId) || !DEPLOYMENT_ID.test(options.deploymentId)) fail('ADAPTER_REQUEST_INVALID');
        const teamSlug = options.teamSlug ?? this.teamSlug;
        if (teamSlug !== undefined && !PROJECT_ID.test(teamSlug)) fail('ADAPTER_REQUEST_INVALID');
        const path = `/v13/deployments/${encodeURIComponent(options.deploymentId)}`;
        const query = new URLSearchParams({ withGitRepoInfo: 'true', teamId: options.teamId });
        if (teamSlug !== undefined) query.set('slug', teamSlug);
        const { value } = await this.transport.json({
            method: 'GET',
            url: `https://api.vercel.com${path}?${query.toString()}`,
            allowedHosts: HOSTS,
            allowedPath: candidate => candidate === path,
            allowedMethods: ['GET'],
            allowedQueryKeys: teamSlug === undefined ? ['withGitRepoInfo', 'teamId'] : ['withGitRepoInfo', 'teamId', 'slug'],
            acceptedStatuses: [200],
        });
        const deployment = object(value);
        const project = object(deployment.project);
        const team = object(deployment.team);
        if (deployment.id !== options.deploymentId || project.id !== options.projectId || team.id !== options.teamId || typeof deployment.readyState !== 'string') fail('ADAPTER_RESPONSE_INVALID');
        const sourceSha = this.deploymentSourceSha(deployment);
        const deploymentUrl = deployment.url;
        if (typeof deploymentUrl !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,251}[A-Za-z0-9]$/.test(deploymentUrl) || deploymentUrl.includes('..')) fail('ADAPTER_RESPONSE_INVALID');
        const origin = `https://${deploymentUrl}`;
        const aliases = Array.isArray(deployment.alias) ? deployment.alias : [];
        const aliasNames = aliases.map(alias => {
            if (typeof alias !== 'string' || !ALIAS.test(alias)) fail('ADAPTER_RESPONSE_INVALID');
            return alias;
        });
        const target = deployment.target === undefined || deployment.target === null ? null : deployment.target;
        if (target !== null && typeof target !== 'string') fail('ADAPTER_RESPONSE_INVALID');
        return {
            id: options.deploymentId,
            sourceSha,
            readyState: deployment.readyState,
            origin,
            target,
            aliasNames,
            digest: canonicalDigest({ id: deployment.id, sourceSha, readyState: deployment.readyState, origin, target, aliasNames }),
        };
    }

    async getAliases(options: Readonly<{ deploymentId: string; teamId: string }>): Promise<readonly string[]> {
        if (!DEPLOYMENT_ID.test(options.deploymentId) || !TEAM_ID.test(options.teamId)) fail('ADAPTER_REQUEST_INVALID');
        const path = `/v2/deployments/${encodeURIComponent(options.deploymentId)}/aliases`;
        const { value } = await this.transport.json({
            method: 'GET',
            url: `https://api.vercel.com${path}?teamId=${encodeURIComponent(options.teamId)}`,
            allowedHosts: HOSTS,
            allowedPath: candidate => candidate === path,
            allowedMethods: ['GET'],
            allowedQueryKeys: ['teamId'],
            acceptedStatuses: [200],
        });
        const body = object(value);
        const aliases = body.aliases;
        if (!Array.isArray(aliases)) fail('ADAPTER_RESPONSE_INVALID');
        return aliases.map(item => {
            const alias = object(item);
            if (typeof alias.alias !== 'string' || !ALIAS.test(alias.alias)) fail('ADAPTER_RESPONSE_INVALID');
            return alias.alias;
        });
    }

    async assignAlias(options: Readonly<{ projectId: string; teamId: string; deploymentId: string; expectedOldDeploymentId: string; expectedSourceSha: string; alias: string; leaseCheck?: LeaseCheck }>): Promise<readonly string[]> {
        const leaseCheck = requireLeaseCheck(options.leaseCheck, { operation: 'alias.assign', resource: options.alias });
        await leaseCheck();
        if (!PROJECT_ID.test(options.projectId) || !TEAM_ID.test(options.teamId) || !DEPLOYMENT_ID.test(options.deploymentId) || !DEPLOYMENT_ID.test(options.expectedOldDeploymentId) || !SHA.test(options.expectedSourceSha) || !ALIAS.test(options.alias)) fail('ADAPTER_REQUEST_INVALID');
        const deployment = await this.getDeployment({ projectId: options.projectId, teamId: options.teamId, deploymentId: options.deploymentId });
        if (deployment.readyState !== 'READY' || deployment.sourceSha !== options.expectedSourceSha) fail('ADAPTER_RESPONSE_INVALID');
        const prior = await this.getAlias({ alias: options.alias, projectId: options.projectId, teamId: options.teamId, allowMissing: true });
        // The reviewed transition is an ownership move from a known old
        // deployment.  A missing alias is not equivalent to that owner and
        // must fail closed before POST; there is no invented Vercel CAS field.
        if (!prior) fail('OBSERVATION_RACE');
        if (prior && prior.deploymentId === options.deploymentId) {
            await leaseCheck();
            return this.getAliases({ deploymentId: options.deploymentId, teamId: options.teamId });
        }
        if (prior && prior.deploymentId !== options.expectedOldDeploymentId) fail('OBSERVATION_RACE');
        const path = `/v2/deployments/${encodeURIComponent(options.deploymentId)}/aliases`;
        await leaseCheck();
        const response = await this.transport.json({
            method: 'POST',
            url: `https://api.vercel.com${path}?teamId=${encodeURIComponent(options.teamId)}`,
            allowedHosts: HOSTS,
            allowedPath: candidate => candidate === path,
            allowedMethods: ['POST'],
            allowedQueryKeys: ['teamId'],
            acceptedStatuses: [200, 201],
            body: { alias: options.alias, redirect: null },
        });
        const post = object(response.value);
        if (post.alias !== options.alias || post.projectId !== options.projectId || post.deploymentId !== options.deploymentId
            || (post.oldDeploymentId !== undefined && post.oldDeploymentId !== options.expectedOldDeploymentId)) fail('OBSERVATION_RACE');
        // The pre-read is an ownership barrier, not a provider-side atomic
        // CAS.  The independent post-read below detects a race after POST and
        // prevents this adapter from claiming success if another owner won.
        await leaseCheck();
        const assigned = await this.getAlias({ alias: options.alias, projectId: options.projectId, teamId: options.teamId, expectedDeploymentId: options.deploymentId });
        if (!assigned || assigned.alias !== options.alias) fail('ADAPTER_RESPONSE_INVALID');
        await leaseCheck();
        return this.getAliases({ deploymentId: options.deploymentId, teamId: options.teamId });
    }

    async readPublicReadiness(options: Readonly<{
        url: string;
        expected: PublicReadinessExpected;
    }>): Promise<LegacyPublicReadiness> {
        return this.readReadinessAt(options.url, options.expected, this.publicReadinessOrigin);
    }

    /** Proves the desired immutable deployment before its alias can be changed. */
    async readDeploymentReadiness(options: Readonly<{ deployment: VercelDeploymentObservation; expected: PublicReadinessExpected }>): Promise<LegacyPublicReadiness> {
        return this.readReadinessAt(`${options.deployment.origin}/api/analysis/capacity/readiness`, options.expected, options.deployment.origin);
    }

    private async readReadinessAt(url: string, expected: PublicReadinessExpected, expectedOrigin: string): Promise<LegacyPublicReadiness> {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            fail('ADAPTER_REQUEST_INVALID');
        }
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) fail('ADAPTER_NOT_ALLOWED');
        if (parsed.pathname !== '/api/analysis/capacity/readiness') fail('ADAPTER_NOT_ALLOWED');
        if (parsed.port || parsed.origin !== expectedOrigin) fail('ADAPTER_NOT_ALLOWED');
        const controller = new AbortController();
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        let response: ProtectedHttpResponse;
        try {
            response = await Promise.race([
                this.readinessFetcher(parsed.toString(), controller.signal),
                new Promise<ProtectedHttpResponse>((_, reject) => {
                    timeoutHandle = setTimeout(() => { controller.abort(); reject(new EpochError('ADAPTER_TIMEOUT')); }, this.readinessTimeoutMs);
                }),
            ]);
        } catch (error) {
            if (error instanceof EpochError) throw error;
            fail('ADAPTER_TIMEOUT');
        } finally {
            if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
            controller.abort();
        }
        if (response.url !== undefined && response.url !== parsed.toString()) fail('ADAPTER_REDIRECT');
        if (response.status !== 200) fail('READINESS_INVALID');
        if (typeof response.body !== 'string' || Buffer.byteLength(response.body, 'utf8') > 65_536) fail('READINESS_INVALID');
        let dto: LegacyPublicReadiness;
        try {
            // Parse the strict raw v3 contract before any normalized helper.
            dto = parsePublicReadinessJson(response.body);
            return assertPublicReadiness(dto, expected);
        } catch (error) {
            if (error instanceof EpochError) throw error;
            fail('READINESS_INVALID');
        }
    }

    async assertClosedReadiness(options: Readonly<{ url: string; expected: ReadinessContract; sourceSha: string; preflightVersion: string; paidVersion: string }>): Promise<LegacyPublicReadiness> {
        if (!SHA.test(options.sourceSha)) fail('SOURCE_INVALID');
        return this.readPublicReadiness({
            url: options.url,
            expected: {
                sourceSha: options.sourceSha,
                legacyTargetResource: options.expected.legacyTargetResource,
                preflightProducerConfigFingerprintVersion: options.preflightVersion,
                preflightProducerConfigFingerprint: options.expected.preflightFingerprint,
                paidProducerConfigFingerprintVersion: options.paidVersion,
                paidProducerConfigFingerprint: options.expected.paidFingerprint,
                analysisV2AdmissionEnabled: options.expected.analysisV2AdmissionEnabled,
                earlybirdWebhookAutoAdmissionEnabled: options.expected.earlybirdWebhookAutoAdmissionEnabled,
                ready: true,
            },
        });
    }

    private deploymentSourceSha(deployment: Record<string, unknown>): string {
        const gitSource = object(deployment.gitSource ?? {});
        const sha = gitSource.sha;
        if (typeof sha !== 'string' || !SHA.test(sha)) fail('SOURCE_INVALID');
        return sha;
    }

    private async getAlias(options: Readonly<{ alias: string; projectId: string; teamId: string; expectedDeploymentId?: string; allowMissing?: boolean }>): Promise<{ alias: string; projectId: string; teamId: string; deploymentId: string } | null> {
        if (!ALIAS.test(options.alias) || !PROJECT_ID.test(options.projectId) || !TEAM_ID.test(options.teamId)
            || (options.expectedDeploymentId !== undefined && !DEPLOYMENT_ID.test(options.expectedDeploymentId))) fail('ADAPTER_REQUEST_INVALID');
        const path = `/v4/aliases/${encodeURIComponent(options.alias)}`;
        const response = await this.transport.request({
            method: 'GET', url: `https://api.vercel.com${path}?teamId=${encodeURIComponent(options.teamId)}`,
            allowedHosts: HOSTS, allowedPath: candidate => candidate === path, allowedMethods: ['GET'], allowedQueryKeys: ['teamId'], acceptedStatuses: options.allowMissing ? [200, 404] : [200],
        });
        if (response.status === 404 && options.allowMissing) return null;
        const value = parseProtectedObject(response.body, this.transport.maxResponseBytes);
        const alias = object(value);
        if (alias.alias !== options.alias || alias.projectId !== options.projectId || typeof alias.deploymentId !== 'string' || !DEPLOYMENT_ID.test(alias.deploymentId)) fail('ADAPTER_RESPONSE_INVALID');
        if (options.expectedDeploymentId !== undefined && alias.deploymentId !== options.expectedDeploymentId) fail('ADAPTER_RESPONSE_INVALID');
        return { alias: options.alias, projectId: options.projectId, teamId: options.teamId, deploymentId: alias.deploymentId };
    }
}

export { EpochError };
