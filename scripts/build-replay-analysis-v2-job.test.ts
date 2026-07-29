import {
    lstat,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

async function buildModule() {
    return import('./build-replay-analysis-v2-job.mjs');
}

function validMetafile(
    inputs: readonly string[],
    outfile = '/tmp/replay-job.mjs',
) {
    return {
        inputs: Object.fromEntries(inputs.map(path => [path, {
            bytes: 1,
            imports: [],
        }])),
        outputs: {
            [outfile]: {
                imports: [
                    { path: '@google/genai', external: true },
                    { path: 'sharp', external: true },
                    { path: 'zod', external: true },
                    { path: 'node:crypto', external: true },
                ],
                exports: [],
                inputs: {},
                bytes: 1,
            },
        },
    };
}

describe('stateless replay job build contract', () => {
    it('requires the exact local graph and external package allowlist', async () => {
        const {
            REPLAY_ANALYSIS_V2_JOB_LOCAL_INPUTS,
            auditReplayAnalysisV2JobBuildGraph,
        } = await buildModule();
        const valid = validMetafile(
            REPLAY_ANALYSIS_V2_JOB_LOCAL_INPUTS,
        );

        expect(() => auditReplayAnalysisV2JobBuildGraph(valid))
            .not.toThrow();
        expect(() => auditReplayAnalysisV2JobBuildGraph({
            ...valid,
            outputs: {
                '/tmp/replay-job.mjs': {
                    ...valid.outputs['/tmp/replay-job.mjs'],
                    imports: [
                        ...valid.outputs['/tmp/replay-job.mjs'].imports,
                        { path: 'fs/promises', external: true },
                    ],
                },
            },
        })).not.toThrow();
        expect(() => auditReplayAnalysisV2JobBuildGraph({
            ...valid,
            inputs: {
                ...valid.inputs,
                'lib/services/media/aws-s3-r2-client.ts': {
                    bytes: 1,
                    imports: [],
                },
            },
        })).toThrow('ANALYSIS_V2_REPLAY_JOB_BUILD_GRAPH_FORBIDDEN');
        expect(() => auditReplayAnalysisV2JobBuildGraph({
            ...valid,
            outputs: {
                '/tmp/replay-job.mjs': {
                    ...valid.outputs['/tmp/replay-job.mjs'],
                    imports: [
                        ...valid.outputs['/tmp/replay-job.mjs'].imports,
                        {
                            path: '@aws-sdk/client-s3',
                            external: true,
                        },
                    ],
                },
            },
        })).toThrow('ANALYSIS_V2_REPLAY_JOB_BUILD_GRAPH_FORBIDDEN');
        expect(() => auditReplayAnalysisV2JobBuildGraph({
            ...valid,
            outputs: {
                '/tmp/replay-job.mjs': {
                    ...valid.outputs['/tmp/replay-job.mjs'],
                    imports: [
                        ...valid.outputs['/tmp/replay-job.mjs'].imports,
                        {
                            path: 'node:cloudflare/r2',
                            external: true,
                        },
                    ],
                },
            },
        })).toThrow('ANALYSIS_V2_REPLAY_JOB_BUILD_GRAPH_FORBIDDEN');
    });

    it('pins Node, react-server, and exact external package lock integrities', async () => {
        const {
            createReplayAnalysisV2JobRuntimeManifest,
            verifyReplayAnalysisV2JobRuntimeManifest,
        } = await buildModule();
        const lockfile = JSON.parse(await readFile(
            join(process.cwd(), 'package-lock.json'),
            'utf8',
        ));
        const manifest = createReplayAnalysisV2JobRuntimeManifest(lockfile);

        expect(manifest).toEqual({
            schema: 'analysis-v2-replay-job-runtime-v1',
            node: '24.x',
            conditions: ['react-server'],
            bundle: {
                format: 'esm',
                packages: 'external',
            },
            externalPackages: {
                '@google/genai': {
                    version: '2.7.0',
                    integrity:
                        'sha512-tv0DRtcndt2oEhBYy+5mA0TaXH98+L1Gt0AP9unBfH7DP20KhB7+O3QqAN1Lz+laMARGTHS7BFQSNpLbl4gm1g==',
                },
                sharp: {
                    version: '0.35.3',
                    integrity:
                        'sha512-ej0zVHuZGHCiABXcNxeYhpRnPNPAcvbG8RMdBAhDAxLKkCRVSpK3Iyu7qbqw3JMzoj0REeM6f3tJLtVwl0023Q==',
                },
                zod: {
                    version: '4.3.6',
                    integrity:
                        'sha512-rftlrkhHZOcjDwkGlnUtZZkvaPHCsDATp4pGpuOOMDaTdDDXF91wuVDJoWoPsKX/3YPQ5fHuF3STjcYyKr+Qhg==',
                },
            },
        });
        expect(() => verifyReplayAnalysisV2JobRuntimeManifest(
            manifest,
            lockfile,
        )).not.toThrow();
        expect(() => verifyReplayAnalysisV2JobRuntimeManifest({
            ...manifest,
            externalPackages: {
                ...manifest.externalPackages,
                sharp: {
                    ...manifest.externalPackages.sharp,
                    integrity: 'sha512-forged',
                },
            },
        }, lockfile)).toThrow(
            'ANALYSIS_V2_REPLAY_JOB_RUNTIME_MANIFEST_INVALID',
        );
    });

    it('audits before writes and rolls back all three prior outputs on publish failure', async () => {
        const {
            REPLAY_ANALYSIS_V2_JOB_LOCAL_INPUTS,
            buildReplayAnalysisV2Job,
        } = await buildModule();
        const directory = await mkdtemp(join(
            tmpdir(),
            'replay-job-atomic-build-',
        ));
        const outfile = join(directory, 'job.mjs');
        const metafile = join(directory, 'meta.json');
        const runtimeManifest = join(directory, 'runtime.json');
        try {
            await Promise.all([
                writeFile(outfile, 'old-job', { mode: 0o600 }),
                writeFile(metafile, 'old-meta', { mode: 0o600 }),
                writeFile(runtimeManifest, 'old-runtime', { mode: 0o600 }),
            ]);
            const buildImpl = vi.fn(async (options: {
                write?: boolean;
            }) => {
                expect(options.write).toBe(false);
                return {
                    metafile: validMetafile(
                        REPLAY_ANALYSIS_V2_JOB_LOCAL_INPUTS,
                        outfile,
                    ),
                    outputFiles: [{
                        path: outfile,
                        contents: new TextEncoder().encode('new-job'),
                    }],
                };
            });
            let publishRenames = 0;
            const renameImpl = vi.fn(async (
                source: string,
                target: string,
            ) => {
                if (
                    source.includes('.tmp-')
                    && ++publishRenames === 2
                ) {
                    throw new Error('injected publish failure');
                }
                await rename(source, target);
            });

            await expect(buildReplayAnalysisV2Job({
                outfile,
                metafile,
                runtimeManifest,
                buildImpl,
                renameImpl,
            })).rejects.toThrow('injected publish failure');

            expect(buildImpl).toHaveBeenCalledOnce();
            await expect(readFile(outfile, 'utf8')).resolves.toBe('old-job');
            await expect(readFile(metafile, 'utf8')).resolves.toBe('old-meta');
            await expect(readFile(runtimeManifest, 'utf8'))
                .resolves.toBe('old-runtime');
            expect(await readdir(directory)).toEqual([
                'job.mjs',
                'meta.json',
                'runtime.json',
            ]);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('publishes all runtime contract outputs as private regular files', async () => {
        const {
            buildReplayAnalysisV2Job,
        } = await buildModule();
        const directory = await mkdtemp(join(
            tmpdir(),
            'replay-job-private-build-',
        ));
        const outfile = join(directory, 'job.mjs');
        const metafile = join(directory, 'meta.json');
        const runtimeManifest = join(directory, 'runtime.json');
        try {
            await buildReplayAnalysisV2Job({
                outfile,
                metafile,
                runtimeManifest,
            });

            for (const path of [outfile, metafile, runtimeManifest]) {
                const file = await lstat(path);
                expect(file.isFile()).toBe(true);
                expect(file.mode & 0o777).toBe(0o600);
            }
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }, 30_000);
});
