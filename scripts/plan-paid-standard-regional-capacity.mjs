// Read-only release planner. Only the two describe commands below call gcloud.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const service = 'analysis-paid-worker';
const queue = 'analysis-v2-pipeline';
const region = 'asia-northeast3';

class ReleasePlanError extends Error {}

function requireCondition(ok, message) {
    if (!ok) throw new ReleasePlanError(message);
}

export function regionalCapacityCommands({ project, sourceSha, releaseProof, suffix, cloudRun, cloudTasks, processFeatureSlots = 3 }) {
    requireCondition(processFeatureSlots === 3 || processFeatureSlots === 4, 'Expected 3 or 4 feature slots per worker.');
    requireCondition(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)
        && /^[a-f0-9]{40}$/.test(sourceSha) && /^[a-z][a-z0-9-]{0,22}[a-z0-9]$/.test(suffix),
    'Invalid project, reviewed commit or revision suffix.');
    requireCondition(releaseProof?.project === project && releaseProof.service === service
        && releaseProof.sourceSha === sourceSha && typeof releaseProof.image === 'string'
        && /^[^\s@]+@sha256:[a-f0-9]{64}$/.test(releaseProof.image),
    'The trusted release record must bind the paid service and reviewed commit to an immutable image.');
    const spec = cloudRun.spec?.template?.spec;
    const container = spec?.containers?.[0];
    const env = new Map((container?.env ?? []).map(entry => [entry.name, entry.value]));
    const traffic = cloudRun.status?.traffic;
    const previous = traffic?.[0]?.revisionName;
    const sourceLabel = cloudRun.metadata?.labels?.['analysis-v2-source-commit'];
    const candidate = service + '-' + suffix;
    const restored = candidate + '-base';
    requireCondition(cloudRun.metadata?.name === service && sourceLabel === sourceSha
        && cloudRun.metadata?.labels?.['analysis-workload-role'] === 'paid'
        && cloudRun.metadata?.labels?.['analysis-capacity-stage'] === 'initial'
        && env.get('ANALYSIS_WORKLOAD_ROLE') === 'paid' && env.get('ANALYSIS_CAPACITY_STAGE') === 'initial'
        && env.get('ANALYSIS_V2_TASKS_PROJECT') === project && env.get('ANALYSIS_V2_TASKS_LOCATION') === region
        && env.get('ANALYSIS_V2_TASKS_QUEUE') === queue && env.get('ANALYSIS_PROVIDER_ADMISSION_ENABLED') === 'true'
        && env.get('ANALYSIS_CAPACITY_WORKER_CPU') === '2' && env.get('ANALYSIS_CAPACITY_WORKER_MEMORY') === '2Gi'
        && !env.has('DEV_LIVE_WORKLOAD') && !env.has('PAID_STANDARD_VERTEX_CAPACITY_MODE') && !env.has('PAID_STANDARD_PROCESS_FEATURE_SLOTS'),
    'The target must be the reviewed initial production paid worker with expansion off.');
    requireCondition(traffic?.length === 1 && traffic[0].percent === 100 && !traffic[0].tag
        && typeof previous === 'string' && previous.startsWith(service + '-') && previous !== candidate && previous !== restored
        && cloudRun.status.latestReadyRevisionName === previous && cloudRun.status.latestCreatedRevisionName === previous
        && cloudRun.status.conditions?.some(c => c.type === 'Ready' && c.status === 'True')
        && spec.containers.length === 1 && container.image === releaseProof.image,
    'The reviewed image must be immutable and the only ready, latest and serving revision.');
    // status resolves even LATEST to a named revision. Only the desired spec
    // distinguishes automatic tracking from a fixed pin after --no-traffic.
    const desiredTraffic = cloudRun.spec.traffic;
    let previousTrafficMode = 'latest';
    if (desiredTraffic !== undefined && !(Array.isArray(desiredTraffic) && desiredTraffic.length === 0)) {
        requireCondition(Array.isArray(desiredTraffic) && desiredTraffic.length === 1
            && desiredTraffic[0]?.percent === 100 && !desiredTraffic[0].tag,
        'The original desired traffic must be a single untagged 100% target.');
        const target = desiredTraffic[0];
        if (target.latestRevision === true && !target.revisionName) {
            previousTrafficMode = 'latest';
        } else {
            requireCondition((target.latestRevision === undefined || target.latestRevision === false)
                && target.revisionName === previous, 'The original traffic target must match the serving revision.');
            previousTrafficMode = 'pinned';
        }
    }
    requireCondition(traffic[0].latestRevision === undefined || traffic[0].latestRevision === (previousTrafficMode === 'latest'),
        'The observed traffic mode must match the desired route.');
    const serviceMax = cloudRun.metadata?.annotations?.['run.googleapis.com/maxScale'];
    const revisionMax = cloudRun.spec.template.metadata?.annotations?.['autoscaling.knative.dev/maxScale'];
    requireCondition(serviceMax === '10' && revisionMax === '8' && spec.containerConcurrency === 1
        && container.resources?.limits?.cpu === '2' && container.resources?.limits?.memory === '2Gi',
    'Observed service or revision shape differs from the recorded production baseline.');
    const rates = cloudTasks.rateLimits;
    requireCondition(cloudTasks.name === 'projects/' + project + '/locations/' + region + '/queues/' + queue
        && cloudTasks.state === 'RUNNING' && rates?.maxConcurrentDispatches === 8 && rates?.maxDispatchesPerSecond === 8,
    'Expected the existing production paid queue at 8 concurrent and 8 starts per second.');

    const run = (...args) => ['gcloud', 'run', 'services', ...args, '--project=' + project, '--region=' + region, '--quiet'];
    const queueLimits = (concurrent, perSecond) => ['gcloud', 'tasks', 'queues', 'update', queue,
        '--project=' + project, '--location=' + region, '--max-concurrent-dispatches=' + concurrent,
        '--max-dispatches-per-second=' + perSecond, '--quiet'];
    const trafficTo = revision => run('update-traffic', service, '--to-revisions=' + revision + '=100');
    const featureEnv = processFeatureSlots === 4 ? ',PAID_STANDARD_PROCESS_FEATURE_SLOTS=4' : '';
    const restoreFeatureEnv = processFeatureSlots === 4 ? ',PAID_STANDARD_PROCESS_FEATURE_SLOTS' : '';
    return {
        service, queue, region, sourceSha, processFeatureSlots, previous, previousTrafficMode, candidate, restored, image: container.image,
        stage: run('update', service, '--image=' + container.image, '--no-traffic', '--revision-suffix=' + suffix,
            '--cpu=1', '--memory=2Gi', '--concurrency=3', '--max-instances=18',
            '--update-env-vars=PAID_STANDARD_VERTEX_CAPACITY_MODE=expanded128,ANALYSIS_CAPACITY_WORKER_CPU=1' + featureEnv),
        raiseServiceCap: run('update', service, '--max=18'),
        promote: trafficTo(candidate),
        raiseQueue: queueLimits(40, 32),
        restoreQueue: queueLimits(rates.maxConcurrentDispatches, rates.maxDispatchesPerSecond),
        restoreTraffic: trafficTo(previous),
        restoreServiceCap: run('update', service, '--max=' + serviceMax),
        restoreTemplate: run('update', service, '--image=' + container.image, '--no-traffic',
            '--revision-suffix=' + suffix + '-base', '--cpu=2', '--memory=2Gi', '--concurrency=1',
            '--max-instances=' + revisionMax, '--remove-env-vars=PAID_STANDARD_VERTEX_CAPACITY_MODE' + restoreFeatureEnv,
            '--update-env-vars=ANALYSIS_CAPACITY_WORKER_CPU=2'),
        promoteRestoredTemplate: previousTrafficMode === 'latest'
            ? run('update-traffic', service, '--to-latest')
            : trafficTo(restored),
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const [choice, project, sourceSha, proofFile, suffix] = process.argv.slice(2);
        const processFeatureSlots = choice === '--plan-paid-standard-18i-40q-f4' ? 4 : 3;
        requireCondition(process.argv.length === 7 && ['--plan-paid-standard-18i-40q', '--plan-paid-standard-18i-40q-f4'].includes(choice)
            && /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project ?? ''),
        'Usage: node scripts/plan-paid-standard-regional-capacity.mjs --plan-paid-standard-18i-40q[-f4] PROJECT REVIEWED_SHA VERIFIED_RELEASE_JSON SUFFIX');
        requireCondition(/^[a-f0-9]{40}$/.test(sourceSha) && /^[a-z][a-z0-9-]{0,22}[a-z0-9]$/.test(suffix),
            'Invalid reviewed commit or revision suffix.');
        const releaseProof = JSON.parse(readFileSync(proofFile, 'utf8'));
        const contracts = [
            ['lib/services/analysis/paid-standard-capacity.ts', 'PAID_STANDARD_VERTEX_CAPACITY_MODE'],
            ['lib/services/analysis/v2-worker.ts', 'paid_standard_capacity_lineage_v1'],
            ['lib/services/analysis/v2-ai-attempt-store.ts', 'reserve_paid_standard_ai_attempt_v1'],
            ['supabase/operations/20261126_expand_paid_standard_vertex.sql', 'reserve_paid_standard_ai_attempt_v1'],
        ];
        if (processFeatureSlots === 4) contracts.push(
            ['lib/services/analysis/paid-standard-capacity.ts', 'PAID_STANDARD_PROCESS_FEATURE_SLOTS'],
            ['lib/services/analysis/v2-ai-scheduler-runtime.ts', 'paidStandardFourthFeatureEnabled'],
            ['lib/services/ai/gemini.ts', 'runWithMixedFeatureSlot'],
        );
        for (const [path, symbol] of contracts) {
            const file = execFileSync('git', ['show', sourceSha + ':' + path], { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] });
            requireCondition(file.includes(symbol), 'The reviewed commit lacks the paid Standard release contract.');
        }
        const observe = args => JSON.parse(execFileSync('gcloud', args, { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }));
        const cloudRun = observe(['run', 'services', 'describe', service, '--project=' + project, '--region=' + region, '--format=json']);
        const cloudTasks = observe(['tasks', 'queues', 'describe', queue, '--project=' + project, '--location=' + region, '--format=json']);
        console.log(JSON.stringify(regionalCapacityCommands({ project, sourceSha, releaseProof, suffix, cloudRun, cloudTasks, processFeatureSlots }), null, 2));
    } catch (error) {
        console.error(error instanceof ReleasePlanError ? error.message : 'Could not inspect the reviewed source or Cloud resources.');
        process.exitCode = 1;
    }
}
