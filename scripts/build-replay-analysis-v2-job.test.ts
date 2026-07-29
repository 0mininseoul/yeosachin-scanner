import {
    lstat,
    mkdir,
    mkdtemp,
    open,
    readFile,
    readdir,
    rename,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

async function buildModule() {
    return import('./build-replay-analysis-v2-job.mjs');
}

const immutableImageDigest =
    `asia-northeast3-docker.pkg.dev/replay/jobs/analysis@sha256:${
        'a'.repeat(64)
    }`;

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
        const manifest = createReplayAnalysisV2JobRuntimeManifest(
            lockfile,
            immutableImageDigest,
        );

        expect(manifest).toEqual({
            schema: 'analysis-v2-replay-job-runtime-v2',
            node: '24.x',
            conditions: ['react-server'],
            dependencyClosure: {
                authority: 'immutable-container-image',
                image: immutableImageDigest,
                workspace: '/workspace',
                nodeModules: '/workspace/node_modules',
            },
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
            immutableImageDigest,
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
        }, lockfile, immutableImageDigest)).toThrow(
            'ANALYSIS_V2_REPLAY_JOB_RUNTIME_MANIFEST_INVALID',
        );
        expect(() => createReplayAnalysisV2JobRuntimeManifest(
            lockfile,
            'asia-northeast3-docker.pkg.dev/replay/jobs/analysis:latest',
        )).toThrow('ANALYSIS_V2_REPLAY_JOB_IMAGE_DIGEST_INVALID');
        expect(() => createReplayAnalysisV2JobRuntimeManifest(
            lockfile,
            'sha256:abc',
        )).toThrow('ANALYSIS_V2_REPLAY_JOB_IMAGE_DIGEST_INVALID');
    });

    it('exposes an exact image-owned Node launcher contract', async () => {
        const {
            createReplayAnalysisV2JobContainerLaunchContract,
        } = await buildModule();

        expect(createReplayAnalysisV2JobContainerLaunchContract({
            imageDigest: immutableImageDigest,
            entrypoint: '/workspace/replay-job/job.mjs',
        })).toEqual({
            image: immutableImageDigest,
            workdir: '/workspace',
            nodeModules: '/workspace/node_modules',
            command: [
                'node',
                '--conditions=react-server',
                '/workspace/replay-job/job.mjs',
            ],
            environment: {
                ANALYSIS_V2_REPLAY_JOB_EXPECTED_IMAGE_DIGEST:
                    immutableImageDigest,
            },
        });
    });

    it('accepts only an image-owned node_modules container fixture', async () => {
        const {
            createReplayAnalysisV2JobContainerLaunchContract,
            verifyReplayAnalysisV2JobContainerFilesystem,
        } = await buildModule();
        const imageRoot = await mkdtemp(join(
            tmpdir(),
            'replay-job-image-root-',
        ));
        const workspace = join(imageRoot, 'workspace');
        const nodeModules = join(workspace, 'node_modules');
        const entrypoint = join(workspace, 'replay-job', 'job.mjs');
        const contract = createReplayAnalysisV2JobContainerLaunchContract({
            imageDigest: immutableImageDigest,
            entrypoint: '/workspace/replay-job/job.mjs',
        });
        try {
            await mkdir(nodeModules, { recursive: true, mode: 0o755 });
            await mkdir(join(workspace, 'replay-job'), {
                recursive: true,
                mode: 0o755,
            });
            await writeFile(entrypoint, 'export {};', { mode: 0o600 });

            await expect(
                verifyReplayAnalysisV2JobContainerFilesystem({
                    imageRoot,
                    contract,
                }),
            ).resolves.toBeUndefined();

            await rm(nodeModules, { recursive: true });
            await symlink(
                join(process.cwd(), 'node_modules'),
                nodeModules,
                'dir',
            );
            await expect(
                verifyReplayAnalysisV2JobContainerFilesystem({
                    imageRoot,
                    contract,
                }),
            ).rejects.toThrow(
                'ANALYSIS_V2_REPLAY_JOB_CONTAINER_FILESYSTEM_INVALID',
            );
        } finally {
            await rm(imageRoot, { recursive: true, force: true });
        }
    });

    it('removes every staging directory after pre-publish faults', async () => {
        const {
            REPLAY_ANALYSIS_V2_JOB_LOCAL_INPUTS,
            buildReplayAnalysisV2Job,
        } = await buildModule();
        const parent = await mkdtemp(join(
            tmpdir(),
            'replay-job-atomic-build-',
        ));
        const failureSteps = [
            'staging-directory-created',
            'job.mjs-durable',
            'meta.json-durable',
            'runtime.json-durable',
            'staging-directory-durable',
        ];
        try {
            for (const [index, failureStep] of failureSteps.entries()) {
                const finalDirectory = join(parent, `bundle-${index}`);
                const outfile = join(finalDirectory, 'job.mjs');
                const metafile = join(finalDirectory, 'meta.json');
                const runtimeManifest = join(
                    finalDirectory,
                    'runtime.json',
                );
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

                await expect(buildReplayAnalysisV2Job({
                    outfile,
                    metafile,
                    runtimeManifest,
                    imageDigest: immutableImageDigest,
                    buildImpl,
                    publishStep: step => {
                        if (step === failureStep) {
                            throw new Error(`injected ${failureStep}`);
                        }
                    },
                })).rejects.toThrow(`injected ${failureStep}`);
                expect(buildImpl).toHaveBeenCalledOnce();
                expect(await readdir(parent)).toEqual([]);
            }
        } finally {
            await rm(parent, { recursive: true, force: true });
        }
    });

    it('closes once and removes staging when a durable file close fails', async () => {
        const {
            REPLAY_ANALYSIS_V2_JOB_LOCAL_INPUTS,
            buildReplayAnalysisV2Job,
        } = await buildModule();
        const parent = await mkdtemp(join(
            tmpdir(),
            'replay-job-close-failure-',
        ));
        const finalDirectory = join(parent, 'bundle-v1');
        const outfile = join(finalDirectory, 'job.mjs');
        const metafile = join(finalDirectory, 'meta.json');
        const runtimeManifest = join(finalDirectory, 'runtime.json');
        const buildImpl = vi.fn(async () => ({
            metafile: validMetafile(
                REPLAY_ANALYSIS_V2_JOB_LOCAL_INPUTS,
                outfile,
            ),
            outputFiles: [{
                path: outfile,
                contents: new TextEncoder().encode('new-job'),
            }],
        }));
        const close = vi.fn(async () => {});
        let firstFile = true;
        const openImpl: typeof open = async (
            path,
            flags = 'r',
            mode,
        ) => {
            const handle = await open(path, flags, mode);
            if (!firstFile) return handle;
            firstFile = false;
            const closeHandle = handle.close.bind(handle);
            close.mockImplementationOnce(async () => {
                await closeHandle();
                throw new Error('injected close failure');
            });
            handle.close = close;
            return handle;
        };
        try {
            await expect(buildReplayAnalysisV2Job({
                outfile,
                metafile,
                runtimeManifest,
                imageDigest: immutableImageDigest,
                buildImpl,
                openImpl,
            })).rejects.toThrow(
                'ANALYSIS_V2_REPLAY_JOB_STAGING_FILE_FAILED',
            );
            expect(close).toHaveBeenCalledOnce();
            expect(await readdir(parent)).toEqual([]);
        } finally {
            await rm(parent, { recursive: true, force: true });
        }
    });

    it('requires all three outputs to resolve inside one exact directory', async () => {
        const {
            REPLAY_ANALYSIS_V2_JOB_LOCAL_INPUTS,
            buildReplayAnalysisV2Job,
        } = await buildModule();
        const firstDirectory = await mkdtemp(join(
            tmpdir(),
            'replay-job-output-a-',
        ));
        const secondDirectory = await mkdtemp(join(
            tmpdir(),
            'replay-job-output-b-',
        ));
        const outfile = join(firstDirectory, 'job.mjs');
        const metafile = join(secondDirectory, 'meta.json');
        const runtimeManifest = join(secondDirectory, 'runtime.json');
        const buildImpl = vi.fn(async () => ({
            metafile: validMetafile(
                REPLAY_ANALYSIS_V2_JOB_LOCAL_INPUTS,
                outfile,
            ),
            outputFiles: [{
                path: outfile,
                contents: new TextEncoder().encode('new-job'),
            }],
        }));
        try {
            await expect(buildReplayAnalysisV2Job({
                outfile,
                metafile,
                runtimeManifest,
                imageDigest: immutableImageDigest,
                buildImpl,
            })).rejects.toThrow(
                'Replay job build outputs must share one directory',
            );
            expect(buildImpl).not.toHaveBeenCalled();
        } finally {
            await Promise.all([
                rm(firstDirectory, { recursive: true, force: true }),
                rm(secondDirectory, { recursive: true, force: true }),
            ]);
        }
    });

    it('keeps the complete immutable directory after the publish rename', async () => {
        const {
            REPLAY_ANALYSIS_V2_JOB_LOCAL_INPUTS,
            buildReplayAnalysisV2Job,
        } = await buildModule();
        const parent = await mkdtemp(join(
            tmpdir(),
            'replay-job-post-publish-failure-',
        ));
        const finalDirectory = join(parent, 'bundle-v1');
        const outfile = join(finalDirectory, 'job.mjs');
        const metafile = join(finalDirectory, 'meta.json');
        const runtimeManifest = join(finalDirectory, 'runtime.json');
        try {
            const buildImpl = vi.fn(async () => ({
                metafile: validMetafile(
                    REPLAY_ANALYSIS_V2_JOB_LOCAL_INPUTS,
                    outfile,
                ),
                outputFiles: [{
                    path: outfile,
                    contents: new TextEncoder().encode('new-job'),
                }],
            }));

            await expect(buildReplayAnalysisV2Job({
                outfile,
                metafile,
                runtimeManifest,
                imageDigest: immutableImageDigest,
                buildImpl,
                publishStep: step => {
                    if (step === 'final-directory-published') {
                        throw new Error('injected post-publish failure');
                    }
                },
            })).rejects.toThrow(
                'injected post-publish failure',
            );
            expect(await readdir(parent)).toEqual(['bundle-v1']);
            expect(await readdir(finalDirectory)).toEqual([
                'job.mjs',
                'meta.json',
                'runtime.json',
            ]);
        } finally {
            await rm(parent, { recursive: true, force: true });
        }
    });

    it('publishes all runtime contract outputs as private regular files', async () => {
        const {
            buildReplayAnalysisV2Job,
        } = await buildModule();
        const parent = await mkdtemp(join(
            tmpdir(),
            'replay-job-private-build-',
        ));
        const finalDirectory = join(parent, 'bundle-v1');
        const outfile = join(finalDirectory, 'job.mjs');
        const metafile = join(finalDirectory, 'meta.json');
        const runtimeManifest = join(finalDirectory, 'runtime.json');
        try {
            await buildReplayAnalysisV2Job({
                outfile,
                metafile,
                runtimeManifest,
                imageDigest: immutableImageDigest,
            });

            for (const path of [outfile, metafile, runtimeManifest]) {
                const file = await lstat(path);
                expect(file.isFile()).toBe(true);
                expect(file.mode & 0o777).toBe(0o600);
            }
        } finally {
            await rm(parent, { recursive: true, force: true });
        }
    }, 30_000);

    it('fails closed without overwrite when the immutable final directory exists', async () => {
        const {
            REPLAY_ANALYSIS_V2_JOB_LOCAL_INPUTS,
            buildReplayAnalysisV2Job,
        } = await buildModule();
        const parent = await mkdtemp(join(
            tmpdir(),
            'replay-job-create-only-',
        ));
        const finalDirectory = join(parent, 'bundle-v1');
        const outfile = join(finalDirectory, 'job.mjs');
        const metafile = join(finalDirectory, 'meta.json');
        const runtimeManifest = join(finalDirectory, 'runtime.json');
        await mkdir(finalDirectory, { mode: 0o700 });
        await writeFile(outfile, 'existing', { mode: 0o600 });
        const buildImpl = vi.fn(async () => ({
            metafile: validMetafile(
                REPLAY_ANALYSIS_V2_JOB_LOCAL_INPUTS,
                outfile,
            ),
            outputFiles: [{
                path: outfile,
                contents: new TextEncoder().encode('new-job'),
            }],
        }));
        try {
            await expect(buildReplayAnalysisV2Job({
                outfile,
                metafile,
                runtimeManifest,
                imageDigest: immutableImageDigest,
                buildImpl,
            })).rejects.toThrow(
                'ANALYSIS_V2_REPLAY_JOB_FINAL_DIRECTORY_EXISTS',
            );
            expect(buildImpl).not.toHaveBeenCalled();
            await expect(readFile(outfile, 'utf8'))
                .resolves.toBe('existing');
            expect(await readdir(parent)).toEqual(['bundle-v1']);
        } finally {
            await rm(parent, { recursive: true, force: true });
        }
    });

    it('publishes the complete triplet with one final directory rename', async () => {
        const {
            REPLAY_ANALYSIS_V2_JOB_LOCAL_INPUTS,
            buildReplayAnalysisV2Job,
        } = await buildModule();
        const parent = await mkdtemp(join(
            tmpdir(),
            'replay-job-directory-publish-',
        ));
        const finalDirectory = join(parent, 'bundle-v1');
        const outfile = join(finalDirectory, 'job.mjs');
        const metafile = join(finalDirectory, 'meta.json');
        const runtimeManifest = join(finalDirectory, 'runtime.json');
        const buildImpl = vi.fn(async () => ({
            metafile: validMetafile(
                REPLAY_ANALYSIS_V2_JOB_LOCAL_INPUTS,
                outfile,
            ),
            outputFiles: [{
                path: outfile,
                contents: new TextEncoder().encode('new-job'),
            }],
        }));
        const renameImpl = vi.fn(rename);
        try {
            await buildReplayAnalysisV2Job({
                outfile,
                metafile,
                runtimeManifest,
                imageDigest: immutableImageDigest,
                buildImpl,
                renameImpl,
            });

            expect(renameImpl).toHaveBeenCalledOnce();
            expect(renameImpl.mock.calls[0]![1]).toBe(finalDirectory);
            expect(await readdir(finalDirectory)).toEqual([
                'job.mjs',
                'meta.json',
                'runtime.json',
            ]);
        } finally {
            await rm(parent, { recursive: true, force: true });
        }
    });
});
