import type { AnalysisWorkloadRole } from './workload-role';
import { parseAnalysisWorkloadRole } from './workload-role';

export { parseAnalysisWorkloadRole } from './workload-role';

export const ANALYSIS_CAPACITY_LIMITS = Object.freeze({
    preflightInitial: 32,
    preflightExpanded: 64,
    paidInitial: 8,
    paidExpandedMinimum: 16,
});

/** Bootstrap is the private, gate-closed deployment stage. It has the same
 * conservative capacity as initial and cannot be treated as an intake stage. */
export type AnalysisCapacityStage = 'bootstrap' | 'initial' | 'expanded';

export interface AnalysisCapacityConfig {
    readonly role: AnalysisWorkloadRole;
    readonly stage: AnalysisCapacityStage;
    readonly activeConcurrency: number;
    readonly maxInstances: number;
    readonly containerConcurrency: 1;
    readonly queue: string;
    readonly targetUrl: string;
    readonly oidcAudience: string;
    readonly cloudRunService: string;
    readonly cloudRunRegion: string;
}

const PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const LOCATION_PATTERN = /^[a-z]+-[a-z]+[0-9]$/;
const QUEUE_PATTERN = /^[a-z](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const SERVICE_PATTERN = /^[a-z](?:[a-z0-9-]{0,47}[a-z0-9])?$/;

function strictBoolean(value: string | undefined, key: string, fallback = false): boolean {
    const normalized = value?.trim().toLowerCase();
    if (!normalized) return fallback;
    if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
    if (['0', 'false', 'off', 'no'].includes(normalized)) return false;
    throw new Error(`ANALYSIS_CAPACITY_CONFIG_ERROR: ${key} must be boolean.`);
}

function required(env: Record<string, string | undefined>, key: string): string {
    const value = env[key]?.trim();
    if (!value) throw new Error(`ANALYSIS_CAPACITY_CONFIG_ERROR: ${key} is required.`);
    return value;
}

function httpsOrigin(value: string, key: string): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`ANALYSIS_CAPACITY_CONFIG_ERROR: ${key} must be HTTPS.`);
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
        throw new Error(`ANALYSIS_CAPACITY_CONFIG_ERROR: ${key} must be HTTPS.`);
    }
    return url;
}

function roleKeys(role: AnalysisWorkloadRole): Readonly<{
    queue: string;
    targetUrl: string;
    audience: string;
    service: string;
    region: string;
}> {
    return role === 'preflight'
        ? {
            queue: 'PREFLIGHT_TASKS_QUEUE',
            targetUrl: 'PREFLIGHT_TASKS_TARGET_URL',
            audience: 'PREFLIGHT_TASKS_OIDC_AUDIENCE',
            service: 'PREFLIGHT_TASKS_CLOUD_RUN_SERVICE',
            region: 'PREFLIGHT_TASKS_CLOUD_RUN_REGION',
        }
        : {
            queue: 'ANALYSIS_V2_TASKS_QUEUE',
            targetUrl: 'ANALYSIS_V2_TASKS_TARGET_URL',
            audience: 'ANALYSIS_V2_TASKS_OIDC_AUDIENCE',
            service: 'ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE',
            region: 'ANALYSIS_V2_TASKS_CLOUD_RUN_REGION',
        };
}

function expectedPath(role: AnalysisWorkloadRole): string {
    return role === 'preflight'
        ? '/api/analysis/preflight/worker'
        : '/api/analysis/v2/worker';
}

function validateSeparation(env: Record<string, string | undefined>): void {
    const preflightQueue = env.PREFLIGHT_TASKS_QUEUE?.trim();
    const paidQueue = env.ANALYSIS_V2_TASKS_QUEUE?.trim();
    if (preflightQueue && paidQueue && preflightQueue === paidQueue) {
        throw new Error('ANALYSIS_CAPACITY_QUEUE_ROLE_COLLISION');
    }
    const preflightService = env.PREFLIGHT_TASKS_CLOUD_RUN_SERVICE?.trim();
    const paidService = env.ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE?.trim();
    if (preflightService && paidService && preflightService === paidService) {
        throw new Error('ANALYSIS_CAPACITY_SERVICE_ROLE_COLLISION');
    }
    const preflightTarget = env.PREFLIGHT_TASKS_TARGET_URL?.trim();
    const paidTarget = env.ANALYSIS_V2_TASKS_TARGET_URL?.trim();
    if (preflightTarget && paidTarget) {
        try {
            if (new URL(preflightTarget).origin === new URL(paidTarget).origin) {
                throw new Error('ANALYSIS_CAPACITY_TARGET_ROLE_COLLISION');
            }
        } catch (error) {
            if (error instanceof Error && error.message === 'ANALYSIS_CAPACITY_TARGET_ROLE_COLLISION') {
                throw error;
            }
            // The role-specific parser emits the more precise HTTPS/target error.
        }
    }
    const preflightAudience = env.PREFLIGHT_TASKS_OIDC_AUDIENCE?.trim();
    const paidAudience = env.ANALYSIS_V2_TASKS_OIDC_AUDIENCE?.trim();
    if (preflightAudience && paidAudience) {
        try {
            if (new URL(preflightAudience).origin === new URL(paidAudience).origin) {
                throw new Error('ANALYSIS_CAPACITY_AUDIENCE_ROLE_COLLISION');
            }
        } catch (error) {
            if (error instanceof Error && error.message === 'ANALYSIS_CAPACITY_AUDIENCE_ROLE_COLLISION') {
                throw error;
            }
        }
    }
}

export function parseAnalysisCapacityStage(value: string | undefined): AnalysisCapacityStage {
    const stage = value?.trim().toLowerCase() || 'initial';
    if (stage !== 'bootstrap' && stage !== 'initial' && stage !== 'expanded') {
        throw new Error('ANALYSIS_CAPACITY_STAGE_INVALID');
    }
    return stage;
}

export function getAnalysisCapacityConfig(
    env: Record<string, string | undefined> = process.env,
): AnalysisCapacityConfig {
    const role = parseAnalysisWorkloadRole(env.ANALYSIS_WORKLOAD_ROLE);
    const stage = parseAnalysisCapacityStage(env.ANALYSIS_CAPACITY_STAGE);
    const expansionCanary = strictBoolean(
        env.ANALYSIS_CAPACITY_EXPANSION_CANARY,
        'ANALYSIS_CAPACITY_EXPANSION_CANARY',
    );
    if (stage === 'expanded' && !expansionCanary) {
        throw new Error('ANALYSIS_CAPACITY_EXPANSION_GATE_REQUIRED');
    }
    const keys = roleKeys(role);
    const queue = required(env, keys.queue);
    if (!QUEUE_PATTERN.test(queue)) {
        throw new Error('ANALYSIS_CAPACITY_QUEUE_INVALID');
    }
    const target = httpsOrigin(required(env, keys.targetUrl), keys.targetUrl);
    const audience = httpsOrigin(required(env, keys.audience), keys.audience);
    if (target.pathname !== expectedPath(role) || target.search) {
        throw new Error('ANALYSIS_CAPACITY_TARGET_ROLE_MISMATCH');
    }
    if (audience.pathname !== '/' || audience.search || target.origin !== audience.origin) {
        throw new Error('ANALYSIS_CAPACITY_AUDIENCE_TARGET_MISMATCH');
    }
    validateSeparation(env);
    const service = required(env, keys.service);
    if (!SERVICE_PATTERN.test(service) || !service.includes(role)) {
        throw new Error('ANALYSIS_CAPACITY_SERVICE_ROLE_MISMATCH');
    }
    const region = required(env, keys.region);
    if (!LOCATION_PATTERN.test(region)) {
        throw new Error('ANALYSIS_CAPACITY_REGION_INVALID');
    }
    const activeConcurrency = role === 'preflight'
        ? stage === 'expanded'
            ? ANALYSIS_CAPACITY_LIMITS.preflightExpanded
            : ANALYSIS_CAPACITY_LIMITS.preflightInitial
        : stage === 'expanded'
            ? ANALYSIS_CAPACITY_LIMITS.paidExpandedMinimum
            : ANALYSIS_CAPACITY_LIMITS.paidInitial;
    return Object.freeze({
        role,
        stage,
        activeConcurrency,
        maxInstances: activeConcurrency,
        containerConcurrency: 1,
        queue,
        targetUrl: target.toString(),
        oidcAudience: audience.origin,
        cloudRunService: service,
        cloudRunRegion: region,
    });
}

export function assertAnalysisCapacityConfig(
    env: Record<string, string | undefined> = process.env,
): AnalysisCapacityConfig {
    return getAnalysisCapacityConfig(env);
}
