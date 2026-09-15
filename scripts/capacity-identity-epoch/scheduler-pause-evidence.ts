import { canonicalDigest, epochFail, isObject, PROJECT_ID_PATTERN } from './contracts';
import type { AuthenticatedProtectedTransport } from './platform';
import type { PauseProvenance } from './work-planes';

/** Positive successful PAUSE evidence for the exact reviewed recovery jobs. */
export function createSchedulerPauseProvenanceReader(options: Readonly<{
    transport: AuthenticatedProtectedTransport;
    project: string;
    resources: readonly string[];
    now: () => number;
}>): (input: Readonly<{ resource: string; project: string; location: string; signal?: AbortSignal }>) => Promise<PauseProvenance> {
    const { project, transport, now } = options;
    if (!PROJECT_ID_PATTERN.test(project) || options.resources.length !== 2
        || new Set(options.resources).size !== 2 || options.resources.some(resource =>
            !new RegExp(`^projects/${project}/locations/[a-z][a-z0-9-]{0,62}/jobs/[A-Za-z0-9_-]{1,128}$`).test(resource))) epochFail('ADAPTER_REQUEST_INVALID');
    return async input => {
        if (input.project !== project || !options.resources.includes(input.resource)
            || input.resource.split('/')[3] !== input.location) epochFail('CAPABILITY_BINDING_MISMATCH');
        const observedStart = now();
        const start = new Date(observedStart - 30 * 86_400_000).toISOString();
        const method = 'google.cloud.scheduler.v1.CloudScheduler.PauseJob';
        const logName = `projects/${project}/logs/cloudaudit.googleapis.com%2Factivity`;
        const path = '/v2/entries:list';
        const seen = new Set<string>();
        let pageToken: string | undefined;
        const candidates: number[] = [];
        for (let page = 0; page < 100; page += 1) {
            if (input.signal?.aborted) epochFail('ADAPTER_TIMEOUT');
            const { value } = await transport.json({
                method: 'POST', url: `https://logging.googleapis.com${path}`,
                allowedHosts: new Set(['logging.googleapis.com']), allowedPath: candidate => candidate === path,
                allowedMethods: ['POST'], allowedQueryKeys: [], acceptedStatuses: [200],
                body: { resourceNames: [`projects/${project}`],
                    filter: `logName="${logName}" AND protoPayload.methodName="${method}" AND protoPayload.resourceName="${input.resource}" AND timestamp >= "${start}"`,
                    orderBy: 'timestamp desc', pageSize: 1000, ...(pageToken === undefined ? {} : { pageToken }) },
            });
            if (input.signal?.aborted) epochFail('ADAPTER_TIMEOUT');
            if (!isObject(value) || (value.entries !== undefined && !Array.isArray(value.entries))) epochFail('ADAPTER_RESPONSE_INVALID');
            for (const entry of value.entries ?? []) {
                if (!isObject(entry) || !isObject(entry.protoPayload)) epochFail('ADAPTER_RESPONSE_INVALID');
                const proto = entry.protoPayload;
                const timestamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
                if (proto.methodName !== method || proto.resourceName !== input.resource || !Number.isSafeInteger(timestamp)
                    || timestamp < Date.parse(start) || timestamp > now()) epochFail('EVIDENCE_UNAVAILABLE');
                if (proto.status !== undefined && (!isObject(proto.status) || (proto.status.code !== undefined && proto.status.code !== 0))) continue;
                if (isObject(entry.operation) && entry.operation.first === true && entry.operation.last !== true) continue;
                candidates.push(timestamp);
            }
            if (value.nextPageToken === undefined || value.nextPageToken === '') {
                if (candidates.length === 0) epochFail('EVIDENCE_UNAVAILABLE');
                const latest = Math.max(...candidates);
                const evidence = { resource: input.resource, operation: 'PAUSE' as const,
                    timestamp: new Date(latest).toISOString(), method, logName };
                return { resource: input.resource, pauseEpochMs: latest, observedAtMs: now(),
                    source: `cloud-logging:${logName}`, evidence, evidenceDigest: canonicalDigest(evidence), complete: true };
            }
            if (typeof value.nextPageToken !== 'string' || value.nextPageToken.length > 8192
                || seen.has(value.nextPageToken)) epochFail('PAGINATION_INCOMPLETE');
            seen.add(value.nextPageToken);
            pageToken = value.nextPageToken;
        }
        epochFail('PAGINATION_INCOMPLETE');
    };
}
