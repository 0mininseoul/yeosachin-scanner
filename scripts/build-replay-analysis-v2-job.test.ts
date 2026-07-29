import {
    lstat,
    mkdir,
    mkdtemp,
    open,
    readFile,
    readlink,
    readdir,
    realpath,
    rename,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    closeSync as closeDescriptorSync,
    fstatSync as fstatDescriptorSync,
    fsyncSync,
    openSync,
    writeFileSync,
} from 'node:fs';
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

async function stageContainerArtifactPointer(workspace: string) {
    const content = join(workspace, '.replay-job.content-fixture');
    await mkdir(content, { mode: 0o700 });
    await Promise.all([
        writeFile(join(content, 'job.mjs'), 'export {};', {
            mode: 0o600,
        }),
        writeFile(join(content, 'meta.json'), '{}\n', {
            mode: 0o600,
        }),
        writeFile(join(content, 'runtime.json'), '{}\n', {
            mode: 0o600,
        }),
    ]);
    await symlink('.replay-job.content-fixture', join(
        workspace,
        'replay-job',
    ), 'dir');
}

async function stageContainerRootPackages(input: {
    workspace: string;
    manifest: {
        externalPackages: Record<
            string,
            { version: string; integrity: string }
        >;
    };
    mutation?: 'empty' | 'host-symlink' | 'wrong-version' | 'wrong-integrity';
}) {
    const nodeModules = join(input.workspace, 'node_modules');
    await mkdir(nodeModules, { recursive: true, mode: 0o755 });
    const packages = Object.entries(input.manifest.externalPackages);
    if (input.mutation !== 'empty') {
        for (const [name, provenance] of packages) {
            const packageDirectory = join(nodeModules, name);
            await mkdir(join(packageDirectory, '..'), {
                recursive: true,
            });
            if (
                input.mutation === 'host-symlink'
                && name === 'zod'
            ) {
                await symlink(
                    join(process.cwd(), 'node_modules', name),
                    packageDirectory,
                    'dir',
                );
                continue;
            }
            await mkdir(packageDirectory, { recursive: true });
            await writeFile(
                join(packageDirectory, 'package.json'),
                `${JSON.stringify({
                    name,
                    version: input.mutation === 'wrong-version'
                        && name === 'sharp'
                        ? '0.0.0'
                        : provenance.version,
                })}\n`,
            );
        }
    }
    await writeFile(
        join(input.workspace, 'package-lock.json'),
        `${JSON.stringify({
            name: 'replay-job-image',
            lockfileVersion: 3,
            packages: Object.fromEntries([
                ['', { name: 'replay-job-image' }],
                ...packages.map(([name, provenance]) => [
                    `node_modules/${name}`,
                    {
                        version: provenance.version,
                        integrity:
                            input.mutation === 'wrong-integrity'
                                && name === '@google/genai'
                                ? 'sha512-forged'
                                : provenance.integrity,
                    },
                ]),
            ]),
        }, null, 2)}\n`,
        { mode: 0o600 },
    );
    await writeFile(
        join(
            input.workspace,
            'replay-job-dependency-provenance.json',
        ),
        `${JSON.stringify({
            schema:
                'analysis-v2-replay-job-physical-closure-v1',
            platform: process.platform,
            arch: process.arch,
            packages: packages.map(([name, provenance]) => ({
                path: `node_modules/${name}`,
                version: provenance.version,
                integrity: provenance.integrity,
            })),
        }, null, 2)}\n`,
        { mode: 0o600 },
    );
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
                packageLock: '/workspace/package-lock.json',
                provenance:
                    '/workspace/replay-job-dependency-provenance.json',
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

    it('accepts an image-owned root package and lock provenance fixture', async () => {
        const {
            createReplayAnalysisV2JobContainerLaunchContract,
            createReplayAnalysisV2JobRuntimeManifest,
            verifyReplayAnalysisV2JobContainerFilesystem,
        } = await buildModule();
        const imageRoot = await mkdtemp(join(
            tmpdir(),
            'replay-job-image-root-',
        ));
        const workspace = join(imageRoot, 'workspace');
        const contract = createReplayAnalysisV2JobContainerLaunchContract({
            imageDigest: immutableImageDigest,
            entrypoint: '/workspace/replay-job/job.mjs',
        });
        const lockfile = JSON.parse(await readFile(
            join(process.cwd(), 'package-lock.json'),
            'utf8',
        ));
        const manifest = createReplayAnalysisV2JobRuntimeManifest(
            lockfile,
            immutableImageDigest,
        );
        try {
            await mkdir(workspace, {
                recursive: true,
                mode: 0o700,
            });
            await stageContainerArtifactPointer(workspace);
            await stageContainerRootPackages({
                workspace,
                manifest,
            });

            await expect(
                verifyReplayAnalysisV2JobContainerFilesystem({
                    imageRoot,
                    contract,
                    manifest,
                }),
            ).resolves.toBeUndefined();
        } finally {
            await rm(imageRoot, { recursive: true, force: true });
        }
    });

    it.each([
        ['empty', 'dependency package missing'],
        ['host-symlink', 'dependency package is not physical'],
        ['wrong-version', 'dependency package provenance mismatch'],
        ['wrong-integrity', 'dependency lock provenance mismatch'],
    ] as const)(
        'rejects a %s physical dependency closure fixture',
        async (mutation, expectedCause) => {
            const {
                createReplayAnalysisV2JobContainerLaunchContract,
                createReplayAnalysisV2JobRuntimeManifest,
                verifyReplayAnalysisV2JobContainerFilesystem,
            } = await buildModule();
            const imageRoot = await mkdtemp(join(
                tmpdir(),
                'replay-job-invalid-image-root-',
            ));
            const workspace = join(imageRoot, 'workspace');
            const contract =
                createReplayAnalysisV2JobContainerLaunchContract({
                    imageDigest: immutableImageDigest,
                    entrypoint: '/workspace/replay-job/job.mjs',
                });
            const lockfile = JSON.parse(await readFile(
                join(process.cwd(), 'package-lock.json'),
                'utf8',
            ));
            const manifest = createReplayAnalysisV2JobRuntimeManifest(
                lockfile,
                immutableImageDigest,
            );
            try {
                await mkdir(workspace, {
                    recursive: true,
                    mode: 0o700,
                });
                await stageContainerArtifactPointer(workspace);
                await stageContainerRootPackages({
                    workspace,
                    manifest,
                    mutation,
                });

                const error = await verifyReplayAnalysisV2JobContainerFilesystem({
                        imageRoot,
                        contract,
                        manifest,
                    }).then(() => undefined, cause => cause);
                expect(error).toMatchObject({
                    message:
                        'ANALYSIS_V2_REPLAY_JOB_CONTAINER_FILESYSTEM_INVALID',
                    cause: {
                        message: expectedCause,
                    },
                });
            } finally {
                await rm(imageRoot, { recursive: true, force: true });
            }
        },
    );

    it('computes and copies the complete installed Mac dependency closure physically', async () => {
        const {
            copyReplayAnalysisV2JobPhysicalDependencyClosure,
        } = await buildModule();
        const imageRoot = await mkdtemp(join(
            tmpdir(),
            'replay-job-physical-copy-',
        ));
        const imageWorkspace = join(imageRoot, 'workspace');
        try {
            await mkdir(imageWorkspace, {
                recursive: true,
                mode: 0o700,
            });
            const closure =
                await copyReplayAnalysisV2JobPhysicalDependencyClosure({
                    sourceWorkspace: process.cwd(),
                    imageWorkspace,
                });

            expect(closure).toMatchObject({
                platform: process.platform,
                arch: process.arch,
            });
            expect(closure.packages.length).toBeGreaterThanOrEqual(45);
            expect(closure.packages).toEqual(
                [...closure.packages].sort(),
            );
            expect(closure.packages).toEqual(expect.arrayContaining([
                'node_modules/@google/genai',
                'node_modules/@img/sharp-darwin-arm64',
                'node_modules/google-auth-library',
                'node_modules/node-fetch/node_modules/data-uri-to-buffer',
                'node_modules/sharp',
                'node_modules/zod',
            ]));
            const canonicalImageWorkspace = await realpath(
                imageWorkspace,
            );
            for (const packagePath of closure.packages) {
                const target = join(imageWorkspace, packagePath);
                const entry = await lstat(target);
                expect(entry.isDirectory()).toBe(true);
                expect(entry.isSymbolicLink()).toBe(false);
                expect(await realpath(target)).toBe(join(
                    canonicalImageWorkspace,
                    packagePath,
                ));
            }
            for (const provenanceFile of [
                'package-lock.json',
                'replay-job-dependency-provenance.json',
            ]) {
                const path = join(imageWorkspace, provenanceFile);
                const entry = await lstat(path);
                expect(entry.isFile()).toBe(true);
                expect(entry.isSymbolicLink()).toBe(false);
                expect(await realpath(path)).toBe(join(
                    canonicalImageWorkspace,
                    provenanceFile,
                ));
            }
            const provenance = JSON.parse(await readFile(
                join(
                    imageWorkspace,
                    'replay-job-dependency-provenance.json',
                ),
                'utf8',
            ));
            expect(provenance.packages.map(
                (entry: { path: string }) => entry.path,
            )).toEqual(closure.packages);
        } finally {
            await rm(imageRoot, { recursive: true, force: true });
        }
    }, 30_000);

    it('rejects a missing transitive package from the computed physical closure', async () => {
        const {
            copyReplayAnalysisV2JobPhysicalDependencyClosure,
            createReplayAnalysisV2JobContainerLaunchContract,
            createReplayAnalysisV2JobRuntimeManifest,
            verifyReplayAnalysisV2JobContainerFilesystem,
        } = await buildModule();
        const imageRoot = await mkdtemp(join(
            tmpdir(),
            'replay-job-transitive-closure-',
        ));
        const workspace = join(imageRoot, 'workspace');
        const contract = createReplayAnalysisV2JobContainerLaunchContract({
            imageDigest: immutableImageDigest,
            entrypoint: '/workspace/replay-job/job.mjs',
        });
        const lockfile = JSON.parse(await readFile(
            join(process.cwd(), 'package-lock.json'),
            'utf8',
        ));
        const manifest = createReplayAnalysisV2JobRuntimeManifest(
            lockfile,
            immutableImageDigest,
        );
        try {
            await mkdir(workspace, {
                recursive: true,
                mode: 0o700,
            });
            await stageContainerArtifactPointer(workspace);
            await copyReplayAnalysisV2JobPhysicalDependencyClosure({
                sourceWorkspace: process.cwd(),
                imageWorkspace: workspace,
            });
            await rm(join(
                workspace,
                'node_modules/google-auth-library',
            ), {
                recursive: true,
            });

            const error =
                await verifyReplayAnalysisV2JobContainerFilesystem({
                    imageRoot,
                    contract,
                    manifest,
                }).then(() => undefined, cause => cause);
            expect(error).toMatchObject({
                message:
                    'ANALYSIS_V2_REPLAY_JOB_CONTAINER_FILESYSTEM_INVALID',
                cause: {
                    message: 'physical closure provenance mismatch',
                },
            });
        } finally {
            await rm(imageRoot, { recursive: true, force: true });
        }
    }, 30_000);

    it('removes every owned content directory after pre-pointer faults', async () => {
        const {
            REPLAY_ANALYSIS_V2_JOB_LOCAL_INPUTS,
            buildReplayAnalysisV2Job,
        } = await buildModule();
        const parent = await mkdtemp(join(
            tmpdir(),
            'replay-job-atomic-build-',
        ));
        const failureSteps = [
            'content-directory-created',
            'job.mjs-durable',
            'meta.json-durable',
            'runtime.json-durable',
            'content-directory-durable',
            'final-path-absent',
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

    it('sync-closes a still-valid descriptor after FileHandle.close rejects', async () => {
        const {
            REPLAY_ANALYSIS_V2_JOB_LOCAL_INPUTS,
            buildReplayAnalysisV2Job,
        } = await buildModule();
        const parent = await mkdtemp(join(
            tmpdir(),
            'replay-job-valid-fd-close-failure-',
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
        let descriptor = -1;
        let firstFile = true;
        const openImpl: typeof open = async (
            path,
            flags = 'r',
            mode,
        ) => {
            if (!firstFile) return open(path, flags, mode);
            firstFile = false;
            descriptor = openSync(path, flags, mode);
            return {
                fd: descriptor,
                writeFile: async (
                    contents: string | Uint8Array,
                ) => {
                    writeFileSync(descriptor, contents);
                },
                sync: async () => {
                    fsyncSync(descriptor);
                },
                close: async () => {
                    throw new Error('injected close rejection');
                },
            } as unknown as Awaited<ReturnType<typeof open>>;
        };
        const closeSyncImpl = vi.fn(closeDescriptorSync);
        try {
            await expect(buildReplayAnalysisV2Job({
                outfile,
                metafile,
                runtimeManifest,
                imageDigest: immutableImageDigest,
                buildImpl,
                openImpl,
                closeSyncImpl,
            })).rejects.toThrow(
                'ANALYSIS_V2_REPLAY_JOB_STAGING_FILE_FAILED',
            );
            expect(closeSyncImpl).toHaveBeenCalledOnce();
            expect(closeSyncImpl).toHaveBeenCalledWith(descriptor);
            expect(() => fstatDescriptorSync(descriptor))
                .toThrow(expect.objectContaining({ code: 'EBADF' }));
            expect(await readdir(parent)).toEqual([]);
        } finally {
            try {
                closeDescriptorSync(descriptor);
            } catch {
                // The expected fallback already owns descriptor cleanup.
            }
            await rm(parent, { recursive: true, force: true });
        }
    });

    it('does not reclose a descriptor already reported as minus one', async () => {
        const {
            REPLAY_ANALYSIS_V2_JOB_LOCAL_INPUTS,
            buildReplayAnalysisV2Job,
        } = await buildModule();
        const parent = await mkdtemp(join(
            tmpdir(),
            'replay-job-invalid-fd-close-failure-',
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
        let firstFile = true;
        const openImpl: typeof open = async (
            path,
            flags = 'r',
            mode,
        ) => {
            if (!firstFile) return open(path, flags, mode);
            firstFile = false;
            const descriptor = openSync(path, flags, mode);
            closeDescriptorSync(descriptor);
            return {
                fd: -1,
                writeFile: async () => undefined,
                sync: async () => undefined,
                close: async () => {
                    throw new Error('injected closed-handle rejection');
                },
            } as unknown as Awaited<ReturnType<typeof open>>;
        };
        const closeSyncImpl = vi.fn(closeDescriptorSync);
        try {
            await expect(buildReplayAnalysisV2Job({
                outfile,
                metafile,
                runtimeManifest,
                imageDigest: immutableImageDigest,
                buildImpl,
                openImpl,
                closeSyncImpl,
            })).rejects.toThrow(
                'ANALYSIS_V2_REPLAY_JOB_STAGING_FILE_FAILED',
            );
            expect(closeSyncImpl).not.toHaveBeenCalled();
            expect(await readdir(parent)).toEqual([]);
        } finally {
            await rm(parent, { recursive: true, force: true });
        }
    });

    it('aggregates write, close, and fallback errors while removing staging', async () => {
        const {
            REPLAY_ANALYSIS_V2_JOB_LOCAL_INPUTS,
            buildReplayAnalysisV2Job,
        } = await buildModule();
        const parent = await mkdtemp(join(
            tmpdir(),
            'replay-job-aggregate-close-failure-',
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
        let descriptor = -1;
        let firstFile = true;
        const openImpl: typeof open = async (
            path,
            flags = 'r',
            mode,
        ) => {
            if (!firstFile) return open(path, flags, mode);
            firstFile = false;
            descriptor = openSync(path, flags, mode);
            return {
                fd: descriptor,
                writeFile: async () => {
                    throw new Error('injected write failure');
                },
                sync: async () => undefined,
                close: async () => {
                    throw new Error('injected close failure');
                },
            } as unknown as Awaited<ReturnType<typeof open>>;
        };
        const closeSyncImpl = vi.fn((fd: number) => {
            closeDescriptorSync(fd);
            throw new Error('injected fallback failure');
        });
        try {
            const error = await buildReplayAnalysisV2Job({
                outfile,
                metafile,
                runtimeManifest,
                imageDigest: immutableImageDigest,
                buildImpl,
                openImpl,
                closeSyncImpl,
            }).then(() => undefined, cause => cause);

            expect(error).toMatchObject({
                message: 'ANALYSIS_V2_REPLAY_JOB_STAGING_FILE_FAILED',
                cause: expect.any(AggregateError),
            });
            expect(
                (error.cause as AggregateError).errors.map(
                    (entry: Error) => entry.message,
                ),
            ).toEqual([
                'injected write failure',
                'injected close failure',
                'injected fallback failure',
            ]);
            expect(closeSyncImpl).toHaveBeenCalledOnce();
            expect(() => fstatDescriptorSync(descriptor))
                .toThrow(expect.objectContaining({ code: 'EBADF' }));
            expect(await readdir(parent)).toEqual([]);
        } finally {
            try {
                closeDescriptorSync(descriptor);
            } catch {
                // The injected fallback closes before reporting its fault.
            }
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

    it('keeps the complete immutable target after pointer publication', async () => {
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
                    if (step === 'final-pointer-published') {
                        throw new Error('injected post-publish failure');
                    }
                },
            })).rejects.toThrow(
                'injected post-publish failure',
            );
            expect((await lstat(finalDirectory)).isSymbolicLink())
                .toBe(true);
            expect((await readdir(parent)).sort()).toEqual([
                expect.stringMatching(
                    /^\.bundle-v1\.content-[a-f0-9-]+$/,
                ),
                'bundle-v1',
            ]);
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

    it('publishes the complete triplet with one final pointer creation', async () => {
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
        const symlinkImpl = vi.fn(symlink);
        try {
            await buildReplayAnalysisV2Job({
                outfile,
                metafile,
                runtimeManifest,
                imageDigest: immutableImageDigest,
                buildImpl,
                symlinkImpl,
            });

            expect(symlinkImpl).toHaveBeenCalledOnce();
            expect(symlinkImpl.mock.calls[0]![1]).toBe(finalDirectory);
            expect((await lstat(finalDirectory)).isSymbolicLink())
                .toBe(true);
            expect(await readdir(finalDirectory)).toEqual([
                'job.mjs',
                'meta.json',
                'runtime.json',
            ]);
        } finally {
            await rm(parent, { recursive: true, force: true });
        }
    });

    it.each([
        'file',
        'directory',
        'symlink',
    ] as const)(
        'preserves a racing %s created immediately before pointer publish',
        async competitorType => {
            const {
                REPLAY_ANALYSIS_V2_JOB_LOCAL_INPUTS,
                buildReplayAnalysisV2Job,
            } = await buildModule();
            const parent = await mkdtemp(join(
                tmpdir(),
                'replay-job-pointer-race-',
            ));
            const finalDirectory = join(parent, 'bundle-v1');
            const outfile = join(finalDirectory, 'job.mjs');
            const metafile = join(finalDirectory, 'meta.json');
            const runtimeManifest = join(finalDirectory, 'runtime.json');
            const competitorTarget = join(parent, 'competitor-target');
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
                    publishStep: async step => {
                        if (step !== 'final-path-absent') return;
                        if (competitorType === 'file') {
                            await writeFile(
                                finalDirectory,
                                'competitor-file',
                                { mode: 0o600 },
                            );
                            return;
                        }
                        await mkdir(competitorTarget, { mode: 0o700 });
                        await writeFile(
                            join(competitorTarget, 'marker'),
                            'competitor-target',
                            { mode: 0o600 },
                        );
                        if (competitorType === 'directory') {
                            await rename(
                                competitorTarget,
                                finalDirectory,
                            );
                            return;
                        }
                        await symlink(
                            'competitor-target',
                            finalDirectory,
                            'dir',
                        );
                    },
                })).rejects.toThrow(
                    'ANALYSIS_V2_REPLAY_JOB_FINAL_DIRECTORY_EXISTS',
                );

                const final = await lstat(finalDirectory);
                if (competitorType === 'file') {
                    expect(final.isFile()).toBe(true);
                    await expect(readFile(finalDirectory, 'utf8'))
                        .resolves.toBe('competitor-file');
                } else if (competitorType === 'directory') {
                    expect(final.isDirectory()).toBe(true);
                    await expect(readFile(
                        join(finalDirectory, 'marker'),
                        'utf8',
                    )).resolves.toBe('competitor-target');
                } else {
                    expect(final.isSymbolicLink()).toBe(true);
                    await expect(readlink(finalDirectory))
                        .resolves.toBe('competitor-target');
                    await expect(readFile(
                        join(finalDirectory, 'marker'),
                        'utf8',
                    )).resolves.toBe('competitor-target');
                }
            } finally {
                await rm(parent, { recursive: true, force: true });
            }
        },
    );

    it('publishes one create-only relative pointer to a verified immutable sibling', async () => {
        const {
            REPLAY_ANALYSIS_V2_JOB_LOCAL_INPUTS,
            buildReplayAnalysisV2Job,
            verifyReplayAnalysisV2JobArtifactPointer,
        } = await buildModule();
        const parent = await mkdtemp(join(
            tmpdir(),
            'replay-job-pointer-publish-',
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
        const symlinkImpl = vi.fn(symlink);
        try {
            await buildReplayAnalysisV2Job({
                outfile,
                metafile,
                runtimeManifest,
                imageDigest: immutableImageDigest,
                buildImpl,
                symlinkImpl,
            });

            const pointer = await lstat(finalDirectory);
            expect(pointer.isSymbolicLink()).toBe(true);
            const target = await readlink(finalDirectory);
            expect(target).toMatch(/^\.bundle-v1\.content-[a-f0-9-]+$/);
            expect(target).not.toContain('/');
            expect(await realpath(finalDirectory))
                .toBe(await realpath(join(parent, target)));
            expect(symlinkImpl).toHaveBeenCalledOnce();
            expect(symlinkImpl).toHaveBeenCalledWith(
                target,
                finalDirectory,
                'dir',
            );
            await expect(
                verifyReplayAnalysisV2JobArtifactPointer({
                    finalDirectory,
                }),
            ).resolves.toEqual({
                contentDirectory: join(parent, target),
                files: ['job.mjs', 'meta.json', 'runtime.json'],
            });
        } finally {
            await rm(parent, { recursive: true, force: true });
        }
    });

    it('leaves the final pointer absent or complete across every publish step', async () => {
        const {
            REPLAY_ANALYSIS_V2_JOB_LOCAL_INPUTS,
            buildReplayAnalysisV2Job,
            verifyReplayAnalysisV2JobArtifactPointer,
        } = await buildModule();
        const parent = await mkdtemp(join(
            tmpdir(),
            'replay-job-pointer-faults-',
        ));
        const steps = [
            'content-directory-created',
            'job.mjs-durable',
            'meta.json-durable',
            'runtime.json-durable',
            'content-directory-durable',
            'final-path-absent',
            'final-pointer-published',
            'parent-directory-durable',
        ];
        try {
            for (const [index, failureStep] of steps.entries()) {
                const finalDirectory = join(parent, `bundle-${index}`);
                const outfile = join(finalDirectory, 'job.mjs');
                const metafile = join(finalDirectory, 'meta.json');
                const runtimeManifest = join(
                    finalDirectory,
                    'runtime.json',
                );
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
                        if (step === failureStep) {
                            throw new Error(`injected ${failureStep}`);
                        }
                    },
                })).rejects.toThrow(`injected ${failureStep}`);

                if (
                    failureStep === 'final-pointer-published'
                    || failureStep === 'parent-directory-durable'
                ) {
                    await expect(
                        verifyReplayAnalysisV2JobArtifactPointer({
                            finalDirectory,
                        }),
                    ).resolves.toMatchObject({
                        files: [
                            'job.mjs',
                            'meta.json',
                            'runtime.json',
                        ],
                    });
                } else {
                    await expect(lstat(finalDirectory)).rejects.toMatchObject({
                        code: 'ENOENT',
                    });
                    expect(
                        (await readdir(parent)).filter(name => (
                            name.startsWith(`.bundle-${index}.`)
                        )),
                    ).toEqual([]);
                }
            }
        } finally {
            await rm(parent, { recursive: true, force: true });
        }
    });

    it('never removes a replacement at an owned content cleanup path', async () => {
        const {
            REPLAY_ANALYSIS_V2_JOB_LOCAL_INPUTS,
            buildReplayAnalysisV2Job,
        } = await buildModule();
        const parent = await mkdtemp(join(
            tmpdir(),
            'replay-job-content-cleanup-race-',
        ));
        const finalDirectory = join(parent, 'bundle-v1');
        const outfile = join(finalDirectory, 'job.mjs');
        const metafile = join(finalDirectory, 'meta.json');
        const runtimeManifest = join(finalDirectory, 'runtime.json');
        const ownedOriginal = join(parent, 'owned-original');
        let contentDirectory: string | undefined;
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
                publishStep: async step => {
                    if (step === 'content-directory-created') {
                        const contentName = (await readdir(parent)).find(
                            name => name.startsWith(
                                '.bundle-v1.content-',
                            ),
                        );
                        contentDirectory = contentName
                            ? join(parent, contentName)
                            : undefined;
                        return;
                    }
                    if (step !== 'job.mjs-durable') return;
                    expect(contentDirectory).toBeTypeOf('string');
                    await rename(contentDirectory!, ownedOriginal);
                    await mkdir(contentDirectory!, { mode: 0o700 });
                    await writeFile(
                        join(contentDirectory!, 'competitor-marker'),
                        'preserve-me',
                        { mode: 0o600 },
                    );
                    throw new Error('injected cleanup race');
                },
            })).rejects.toThrow('injected cleanup race');

            await expect(readFile(
                join(contentDirectory!, 'competitor-marker'),
                'utf8',
            )).resolves.toBe('preserve-me');
            await expect(readFile(
                join(ownedOriginal, 'job.mjs'),
                'utf8',
            )).resolves.toBe('new-job');
            await expect(lstat(finalDirectory)).rejects.toMatchObject({
                code: 'ENOENT',
            });
        } finally {
            await rm(parent, { recursive: true, force: true });
        }
    });
});
