import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { regionalCapacityCommands } from '../../../scripts/plan-paid-standard-regional-capacity.mjs';
import { sharedStandardCapacity } from '../../analysis/execution/fixtures/standard-shared-capacities.mjs';

const project = 'regional-fixture';
const service = 'analysis-paid-worker';
const previous = service + '-previous';
const sourceSha = 'b'.repeat(40);
const image = 'example.invalid/private@sha256:' + 'a'.repeat(64);
const releaseProof = { project, service, sourceSha, image };
const tags = { project, sourceSha, releaseProof, suffix: 'qa-reviewed' };

function observations() {
    return {
        cloudRun: {
            metadata: { name: service, labels: {
                'analysis-v2-source-commit': sourceSha, 'analysis-workload-role': 'paid', 'analysis-capacity-stage': 'initial',
            }, annotations: { 'run.googleapis.com/maxScale': '10' } },
            spec: { template: { metadata: { annotations: { 'autoscaling.knative.dev/maxScale': '8' } },
                spec: { containerConcurrency: 1, containers: [{ image,
                    resources: { limits: { cpu: '2', memory: '2Gi' } },
                    env: Object.entries({
                        ANALYSIS_WORKLOAD_ROLE: 'paid', ANALYSIS_CAPACITY_STAGE: 'initial', ANALYSIS_V2_TASKS_PROJECT: project,
                        ANALYSIS_V2_TASKS_LOCATION: 'asia-northeast3', ANALYSIS_V2_TASKS_QUEUE: 'analysis-v2-pipeline',
                        ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true', ANALYSIS_CAPACITY_WORKER_CPU: '2',
                        ANALYSIS_CAPACITY_WORKER_MEMORY: '2Gi', UNRELATED_PRIVATE_TEXT: 'fixture-must-remain-private',
                    }).map(([name, value]) => ({ name, value })),
                }] },
            } },
            status: { latestReadyRevisionName: previous, latestCreatedRevisionName: previous,
                conditions: [{ type: 'Ready', status: 'True' }], traffic: [{ revisionName: previous, percent: 100 }] },
        },
        cloudTasks: { name: 'projects/' + project + '/locations/asia-northeast3/queues/analysis-v2-pipeline',
            state: 'RUNNING', rateLimits: { maxConcurrentDispatches: 8, maxDispatchesPerSecond: 8 } },
    };
}

describe('read-only regional paid Standard release plan', () => {
    it('matches the measured shape and reconstructs the original service, revision and queue separately', () => {
        const plan = regionalCapacityCommands({ ...tags, ...observations() });
        const measured = sharedStandardCapacity('18i-40q');
        if (measured.preset !== '18i-40q') throw new Error('Missing regional test preset');
        expect(plan.stage).toEqual(expect.arrayContaining([
            '--no-traffic', '--image=' + image, '--cpu=' + measured.cpu, '--memory=2Gi', '--concurrency=3',
            '--max-instances=' + measured.instances, '--revision-suffix=qa-reviewed',
            '--update-env-vars=PAID_STANDARD_VERTEX_CAPACITY_MODE=expanded128,ANALYSIS_CAPACITY_WORKER_CPU=1',
        ]));
        expect(plan.stage).not.toContain('--max=18');
        expect(plan.raiseServiceCap).toContain('--max=18');
        expect(plan.promote).toContain('--to-revisions=' + plan.candidate + '=100');
        expect(plan.raiseQueue).toEqual(expect.arrayContaining(['--max-concurrent-dispatches=' + measured.workers, '--max-dispatches-per-second=32']));
        expect(plan.restoreQueue).toEqual(expect.arrayContaining(['--max-concurrent-dispatches=8', '--max-dispatches-per-second=8']));
        expect(plan.restoreTraffic).toContain('--to-revisions=' + previous + '=100');
        expect(plan.restoreServiceCap).toContain('--max=10');
        expect(plan.restoreTemplate).toEqual(expect.arrayContaining(['--no-traffic', '--cpu=2', '--concurrency=1',
            '--max-instances=8', '--image=' + image, '--remove-env-vars=PAID_STANDARD_VERTEX_CAPACITY_MODE']));
        expect(plan.previousTrafficMode).toBe('latest');
        expect(plan.promoteRestoredTemplate).toContain('--to-latest');
        expect(JSON.stringify(plan)).not.toContain('fixture-must-remain-private');
    });

    it.each([
        { name: 'explicit LATEST', traffic: [{ latestRevision: true, percent: 100 }], mode: 'latest' },
        { name: 'empty default', traffic: [], mode: 'latest' },
        { name: 'fixed revision', traffic: [{ revisionName: previous, percent: 100 }], mode: 'pinned' },
    ])('preserves $name after reverting a candidate staged with zero traffic', ({ traffic, mode }) => {
        const state = observations();
        Object.assign(state.cloudRun.spec, { traffic });
        const plan = regionalCapacityCommands({ ...tags, ...state });
        expect(plan.stage).toContain('--no-traffic');
        expect(plan.restoreTemplate).toContain('--no-traffic');
        expect(plan.restoreTraffic).toContain('--to-revisions=' + previous + '=100');
        expect(plan.previousTrafficMode).toBe(mode);
        expect(plan.promoteRestoredTemplate).toContain(mode === 'latest'
            ? '--to-latest' : '--to-revisions=' + plan.restored + '=100');
    });

    it.each([
        null,
        [{ revisionName: 'other', percent: 100 }],
        [{ latestRevision: true, revisionName: previous, percent: 100 }],
        [{ latestRevision: true, percent: 50 }, { revisionName: previous, percent: 50 }],
        [{ revisionName: previous, tag: 'other', percent: 100 }],
    ].map(traffic => ({ traffic })))('rejects an ambiguous or unsupported desired traffic target %#', ({ traffic }) => {
        const state = observations();
        Object.assign(state.cloudRun.spec, { traffic });
        expect(() => regionalCapacityCommands({ ...tags, ...state })).toThrow();
    });

    it('refuses an image attested for a different commit, even when the service label and runtime image match the arguments', () => {
        expect(() => regionalCapacityCommands({
            ...tags, ...observations(), releaseProof: { ...releaseProof, sourceSha: 'c'.repeat(40) },
        })).toThrow('trusted release record');
    });

    it('only describes the exact service and queue from the CLI, without executing the generated plan', () => {
        const directory = mkdtempSync(join(tmpdir(), 'paid-regional-plan-'));
        try {
            const testedSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
            const state = observations();
            const proofFile = join(directory, 'verified.json');
            writeFileSync(proofFile, JSON.stringify({ ...releaseProof, sourceSha: testedSha }));
            state.cloudRun.metadata.labels['analysis-v2-source-commit'] = testedSha;
            writeFileSync(join(directory, 'service.json'), JSON.stringify(state.cloudRun));
            writeFileSync(join(directory, 'queue.json'), JSON.stringify(state.cloudTasks));
            writeFileSync(join(directory, 'gcloud'), `#!/bin/sh
set -eu
echo "$*" >> "$MOCK_CLOUD_DIR/calls"
case "$1 $2 $3 $4" in
    'run services describe analysis-paid-worker') cat "$MOCK_CLOUD_DIR/service.json" ;;
    'tasks queues describe analysis-v2-pipeline') cat "$MOCK_CLOUD_DIR/queue.json" ;;
    *) exit 91 ;;
esac
`, { mode: 0o700 });
            const output = execFileSync(process.execPath, ['scripts/plan-paid-standard-regional-capacity.mjs',
                '--plan-paid-standard-18i-40q', project, testedSha, proofFile, tags.suffix], {
                encoding: 'utf8', env: { ...process.env, PATH: directory + ':' + process.env.PATH, MOCK_CLOUD_DIR: directory },
            });
            expect(JSON.parse(output).previous).toBe(previous);
            expect(readFileSync(join(directory, 'calls'), 'utf8').trim().split('\n')).toEqual([
                'run services describe analysis-paid-worker --project=regional-fixture --region=asia-northeast3 --format=json',
                'tasks queues describe analysis-v2-pipeline --project=regional-fixture --location=asia-northeast3 --format=json',
            ]);
            expect(output).not.toContain('fixture-must-remain-private');
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it.each([
        ['another service', (r: ReturnType<typeof observations>) => { r.cloudRun.metadata.name = 'dev-live-paid'; }],
        ['a preflight role', (r: ReturnType<typeof observations>) => { r.cloudRun.metadata.labels['analysis-workload-role'] = 'preflight'; }],
        ['another commit', (r: ReturnType<typeof observations>) => { r.cloudRun.metadata.labels['analysis-v2-source-commit'] = 'c'.repeat(40); }],
        ['service cap drift', (r: ReturnType<typeof observations>) => { r.cloudRun.metadata.annotations['run.googleapis.com/maxScale'] = '18'; }],
        ['split traffic', (r: ReturnType<typeof observations>) => { r.cloudRun.status.traffic[0].percent = 50; }],
        ['unserved template', (r: ReturnType<typeof observations>) => { r.cloudRun.status.latestCreatedRevisionName = 'other'; }],
        ['a different valid immutable digest under the reviewed service label', (r: ReturnType<typeof observations>) => {
            r.cloudRun.spec.template.spec.containers[0].image = 'example.invalid/private@sha256:' + 'f'.repeat(64);
        }],
        ['mutable image', (r: ReturnType<typeof observations>) => { r.cloudRun.spec.template.spec.containers[0].image = 'repo:latest'; }],
        ['queue scope', (r: ReturnType<typeof observations>) => { r.cloudTasks.name = r.cloudTasks.name.replace(project, 'other-project'); }],
        ['queue drift', (r: ReturnType<typeof observations>) => { r.cloudTasks.rateLimits.maxConcurrentDispatches = 40; }],
        ['existing paid opt-in', (r: ReturnType<typeof observations>) => {
            r.cloudRun.spec.template.spec.containers[0].env.push({ name: 'PAID_STANDARD_VERTEX_CAPACITY_MODE', value: 'expanded128' });
        }],
    ] as const)('rejects %s', (_name, change) => {
        const state = observations();
        change(state);
        expect(() => regionalCapacityCommands({ ...tags, ...state })).toThrow();
    });
});
