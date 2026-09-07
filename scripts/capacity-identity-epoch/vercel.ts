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

const HOSTS = new Set(['api.vercel.com']);
const DEPLOYMENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PROJECT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHA = /^[0-9a-f]{40}$/;
const ALIAS = /^[A-Za-z0-9.-]{1,253}$/;

function fail(code: 'ADAPTER_REQUEST_INVALID' | 'ADAPTER_RESPONSE_INVALID' | 'ADAPTER_NOT_ALLOWED' | 'ADAPTER_TIMEOUT' | 'ADAPTER_REDIRECT' | 'READINESS_INVALID' | 'SOURCE_INVALID'): never {
    epochFail(code);
}

function object(value: unknown): Record<string, unknown> {
    if (!isObject(value)) fail('ADAPTER_RESPONSE_INVALID');
    return value;
}

type PublicReadinessFetcher = (url: string) => Promise<ProtectedHttpResponse>;

export type VercelDeploymentObservation = Readonly<{
    id: string;
    sourceSha: string;
    readyState: string;
    target: string | null;
    aliasNames: readonly string[];
    digest: string;
}>;

export type VercelAdapterOptions = Readonly<{
    transport: AuthenticatedProtectedTransport;
    publicTransport?: ProtectedTransport;
    readinessFetcher?: PublicReadinessFetcher;
}>;

/** Vercel deployment/alias adapter plus strict raw v3 readiness consumption. */
export class VercelAdapter {
    private readonly transport: AuthenticatedProtectedTransport;
    private readonly readinessFetcher: PublicReadinessFetcher;

    constructor(options: VercelAdapterOptions) {
        this.transport = options.transport;
        const publicTransport = options.publicTransport ?? new FetchProtectedTransport(65_536);
        this.readinessFetcher = options.readinessFetcher ?? (async (url: string) => {
            let parsed: URL;
            try {
                parsed = new URL(url);
            } catch {
                fail('ADAPTER_REQUEST_INVALID');
            }
            if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) fail('ADAPTER_NOT_ALLOWED');
            let response: ProtectedHttpResponse;
            try {
                response = await publicTransport.request({
                    method: 'GET',
                    url: parsed.toString(),
                    headers: { accept: 'application/json' },
                });
            } catch (error) {
                if (error instanceof EpochError) throw error;
                fail('ADAPTER_TIMEOUT');
            }
            if (response.url !== undefined && response.url !== parsed.toString()) fail('ADAPTER_REDIRECT');
            return response;
        });
    }

    async getDeployment(options: Readonly<{ projectId: string; deploymentId: string }>): Promise<VercelDeploymentObservation> {
        if (!PROJECT_ID.test(options.projectId) || !DEPLOYMENT_ID.test(options.deploymentId)) fail('ADAPTER_REQUEST_INVALID');
        const path = `/v13/deployments/${encodeURIComponent(options.deploymentId)}`;
        const { value } = await this.transport.json({
            method: 'GET',
            url: `https://api.vercel.com${path}?projectId=${encodeURIComponent(options.projectId)}`,
            allowedHosts: HOSTS,
            allowedPath: candidate => candidate === path,
            allowedQueryKeys: ['projectId'],
            acceptedStatuses: [200],
        });
        const deployment = object(value);
        if (deployment.id !== options.deploymentId || typeof deployment.readyState !== 'string') fail('ADAPTER_RESPONSE_INVALID');
        const sourceSha = this.deploymentSourceSha(deployment);
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
            target,
            aliasNames,
            digest: canonicalDigest({ id: deployment.id, sourceSha, readyState: deployment.readyState, target, aliasNames }),
        };
    }

    async getAliases(deploymentId: string): Promise<readonly string[]> {
        if (!DEPLOYMENT_ID.test(deploymentId)) fail('ADAPTER_REQUEST_INVALID');
        const path = `/v2/deployments/${encodeURIComponent(deploymentId)}/aliases`;
        const { value } = await this.transport.json({
            method: 'GET',
            url: `https://api.vercel.com${path}`,
            allowedHosts: HOSTS,
            allowedPath: candidate => candidate === path,
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

    async assignAlias(options: Readonly<{ projectId: string; deploymentId: string; alias: string }>): Promise<readonly string[]> {
        if (!PROJECT_ID.test(options.projectId) || !DEPLOYMENT_ID.test(options.deploymentId) || !ALIAS.test(options.alias)) fail('ADAPTER_REQUEST_INVALID');
        const path = `/v2/deployments/${encodeURIComponent(options.deploymentId)}/aliases`;
        await this.transport.json({
            method: 'POST',
            url: `https://api.vercel.com${path}`,
            allowedHosts: HOSTS,
            allowedPath: candidate => candidate === path,
            acceptedStatuses: [200, 201],
            body: { alias: options.alias, projectId: options.projectId },
        });
        const aliases = await this.getAliases(options.deploymentId);
        if (!aliases.includes(options.alias)) fail('ADAPTER_RESPONSE_INVALID');
        return aliases;
    }

    async readPublicReadiness(options: Readonly<{
        url: string;
        expected: PublicReadinessExpected;
    }>): Promise<LegacyPublicReadiness> {
        let parsed: URL;
        try {
            parsed = new URL(options.url);
        } catch {
            fail('ADAPTER_REQUEST_INVALID');
        }
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) fail('ADAPTER_NOT_ALLOWED');
        const response = await this.readinessFetcher(parsed.toString());
        if (response.status !== 200) fail('READINESS_INVALID');
        let dto: LegacyPublicReadiness;
        try {
            // Parse the strict raw v3 contract before any normalized helper.
            dto = parsePublicReadinessJson(response.body);
            return assertPublicReadiness(dto, options.expected);
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
        const sha = gitSource.sha ?? gitSource.ref;
        if (typeof sha !== 'string' || !SHA.test(sha)) fail('SOURCE_INVALID');
        return sha;
    }
}

export { EpochError };
