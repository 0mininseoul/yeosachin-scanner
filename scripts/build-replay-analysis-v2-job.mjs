import { randomUUID } from 'node:crypto';
import {
    lstat,
    mkdir,
    open,
    readFile,
    realpath,
    rename,
    rm,
} from 'node:fs/promises';
import {
    basename,
    dirname,
    isAbsolute,
    join,
    resolve,
    sep,
} from 'node:path';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

export const REPLAY_ANALYSIS_V2_JOB_LOCAL_INPUTS = Object.freeze([
    'lib/domain/analysis/media-policy.ts',
    'lib/services/ai/gemini-cost.ts',
    'lib/services/ai/gemini-generation-policy.ts',
    'lib/services/ai/gemini-response.ts',
    'lib/services/ai/gemini.ts',
    'lib/services/ai/gender-resolution-generation.ts',
    'lib/services/ai/gender-resolution-pure.ts',
    'lib/services/ai/gender-resolution-reconciliation.ts',
    'lib/services/ai/gender-triage-microbatch-plan.ts',
    'lib/services/ai/image-preprocessing.ts',
    'lib/services/ai/pipeline-config.ts',
    'lib/services/ai/private-name-analysis.ts',
    'lib/services/ai/replay-stateless-capability.ts',
    'lib/services/ai/stage-policy.ts',
    'lib/services/ai/v2-staged-analysis.ts',
    'lib/services/analysis/narrative-privacy.ts',
    'lib/services/analysis/replay/diagnostic-partial-coverage-capability.ts',
    'lib/services/analysis/replay/historical-partial-available-artifact.ts',
    'lib/services/analysis/replay/replay-artifact-lifecycle.ts',
    'lib/services/analysis/replay/replay-bundle.ts',
    'lib/services/analysis/replay/replay-gender-quality-gate.ts',
    'lib/services/analysis/replay/replay-job-gcs.ts',
    'lib/services/analysis/replay/replay-job-report-contract.ts',
    'lib/services/analysis/replay/replay-runner.ts',
    'lib/services/analysis/replay/replay-source-lineage.ts',
    'lib/services/analysis/replay/replay-staged-ai-adapter.ts',
    'lib/services/analysis/v2-ai-fallback-policy.ts',
    'lib/services/analysis/v2-ai-result-identity.ts',
    'lib/services/analysis/v2-ai-scheduler-runtime.ts',
    'lib/services/analysis/v2-gender-resolver-media-policy.ts',
    'lib/services/analysis/v2-official-account-screening.ts',
    'lib/services/analysis/v2-v211-feature-admission.ts',
    'lib/services/analysis/v2-v211-gender-resolver-admission.ts',
    'lib/services/analysis/v2-v29-feature-admission.ts',
    'lib/services/analysis/v2-v29-gender-resolver-admission.ts',
    'lib/services/google/credentials.ts',
    'lib/services/instagram/username.ts',
    'lib/services/media/secure-image-fetch.ts',
    'scripts/replay-analysis-v2-job-supabase-stub.ts',
    'scripts/replay-analysis-v2-job.ts',
]);

const EXTERNAL_PACKAGES = Object.freeze([
    '@google/genai',
    'sharp',
    'zod',
]);
const NODE_BUILTINS = new Set(builtinModules.flatMap(name => (
    name.startsWith('node:') ? [name] : [name, `node:${name}`]
)));
const IMMUTABLE_IMAGE_DIGEST =
    /^[a-z0-9][a-z0-9._-]*(?:[./][a-z0-9][a-z0-9._-]*)+@sha256:[a-f0-9]{64}$/;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stub = resolve(
    root,
    'scripts/replay-analysis-v2-job-supabase-stub.ts',
);

function forbiddenGraph(reason) {
    throw new Error(
        `ANALYSIS_V2_REPLAY_JOB_BUILD_GRAPH_FORBIDDEN: ${reason}`,
    );
}

export function auditReplayAnalysisV2JobBuildGraph(metafile) {
    if (!metafile || typeof metafile !== 'object') {
        forbiddenGraph('missing metafile');
    }

    const actualInputs = Object.keys(metafile.inputs ?? {}).sort();
    const expectedInputs = [...REPLAY_ANALYSIS_V2_JOB_LOCAL_INPUTS].sort();
    if (
        actualInputs.length !== expectedInputs.length
        || actualInputs.some((path, index) => path !== expectedInputs[index])
    ) {
        forbiddenGraph('local input allowlist mismatch');
    }

    for (const output of Object.values(metafile.outputs ?? {})) {
        for (const entry of output.imports ?? []) {
            const path = entry?.path;
            if (
                typeof path !== 'string'
                || (
                    !NODE_BUILTINS.has(path)
                    && !EXTERNAL_PACKAGES.includes(path)
                )
            ) {
                forbiddenGraph(`external import ${String(path)}`);
            }
        }
    }
}

function runtimePackage(lockfile, name) {
    const entry = lockfile?.packages?.[`node_modules/${name}`];
    if (
        !entry
        || typeof entry.version !== 'string'
        || typeof entry.integrity !== 'string'
    ) {
        throw new Error(
            `ANALYSIS_V2_REPLAY_JOB_RUNTIME_MANIFEST_INVALID: ${name}`,
        );
    }
    return {
        version: entry.version,
        integrity: entry.integrity,
    };
}

function assertImmutableImageDigest(imageDigest) {
    if (
        typeof imageDigest !== 'string'
        || !IMMUTABLE_IMAGE_DIGEST.test(imageDigest)
    ) {
        throw new Error(
            'ANALYSIS_V2_REPLAY_JOB_IMAGE_DIGEST_INVALID',
        );
    }
    return imageDigest;
}

export function createReplayAnalysisV2JobContainerLaunchContract({
    imageDigest,
    entrypoint,
}) {
    const image = assertImmutableImageDigest(imageDigest);
    if (
        typeof entrypoint !== 'string'
        || !entrypoint.startsWith('/workspace/')
        || resolve(entrypoint) !== entrypoint
    ) {
        throw new Error(
            'ANALYSIS_V2_REPLAY_JOB_CONTAINER_LAUNCH_INVALID',
        );
    }
    return {
        image,
        workdir: '/workspace',
        nodeModules: '/workspace/node_modules',
        command: [
            'node',
            '--conditions=react-server',
            entrypoint,
        ],
        environment: {
            ANALYSIS_V2_REPLAY_JOB_EXPECTED_IMAGE_DIGEST: image,
        },
    };
}

export async function verifyReplayAnalysisV2JobContainerFilesystem({
    imageRoot,
    contract,
}) {
    try {
        const expected = createReplayAnalysisV2JobContainerLaunchContract({
            imageDigest: contract?.image,
            entrypoint: contract?.command?.[2],
        });
        if (JSON.stringify(contract) !== JSON.stringify(expected)) {
            throw new Error('contract mismatch');
        }
        const rootPath = await realpath(imageRoot);
        const mountedPath = path => {
            const candidate = resolve(rootPath, `.${path}`);
            if (!candidate.startsWith(`${rootPath}${sep}`)) {
                throw new Error('path escape');
            }
            return candidate;
        };
        const workspacePath = mountedPath(contract.workdir);
        const nodeModulesPath = mountedPath(contract.nodeModules);
        const entrypointPath = mountedPath(contract.command[2]);
        const [workspace, nodeModules, entrypoint] = await Promise.all([
            lstat(workspacePath),
            lstat(nodeModulesPath),
            lstat(entrypointPath),
        ]);
        if (
            workspace.isSymbolicLink()
            || !workspace.isDirectory()
            || nodeModules.isSymbolicLink()
            || !nodeModules.isDirectory()
            || entrypoint.isSymbolicLink()
            || !entrypoint.isFile()
        ) {
            throw new Error('invalid filesystem type');
        }
        const [realWorkspace, realNodeModules, realEntrypoint] =
            await Promise.all([
                realpath(workspacePath),
                realpath(nodeModulesPath),
                realpath(entrypointPath),
            ]);
        if (
            realWorkspace !== workspacePath
            || realNodeModules !== nodeModulesPath
            || realEntrypoint !== entrypointPath
        ) {
            throw new Error('filesystem indirection');
        }
    } catch (cause) {
        throw new Error(
            'ANALYSIS_V2_REPLAY_JOB_CONTAINER_FILESYSTEM_INVALID',
            { cause },
        );
    }
}

export function createReplayAnalysisV2JobRuntimeManifest(
    lockfile,
    imageDigest,
) {
    const image = assertImmutableImageDigest(imageDigest);
    return {
        schema: 'analysis-v2-replay-job-runtime-v2',
        node: '24.x',
        conditions: ['react-server'],
        dependencyClosure: {
            authority: 'immutable-container-image',
            image,
            workspace: '/workspace',
            nodeModules: '/workspace/node_modules',
        },
        bundle: {
            format: 'esm',
            packages: 'external',
        },
        externalPackages: Object.fromEntries(
            EXTERNAL_PACKAGES.map(name => [
                name,
                runtimePackage(lockfile, name),
            ]),
        ),
    };
}

export function verifyReplayAnalysisV2JobRuntimeManifest(
    manifest,
    lockfile,
    imageDigest,
) {
    const expected = createReplayAnalysisV2JobRuntimeManifest(
        lockfile,
        imageDigest,
    );
    if (JSON.stringify(manifest) !== JSON.stringify(expected)) {
        throw new Error(
            'ANALYSIS_V2_REPLAY_JOB_RUNTIME_MANIFEST_INVALID',
        );
    }
}

function resolvedMetafile(metafile) {
    return JSON.parse(JSON.stringify(
        metafile,
        (key, value) => key === 'original' ? undefined : value,
    ));
}

function durableWriteError(cause) {
    return new Error(
        'ANALYSIS_V2_REPLAY_JOB_STAGING_FILE_FAILED',
        { cause },
    );
}

async function closeAfterOperation(handle, operation) {
    let operationError;
    try {
        await operation();
    } catch (error) {
        operationError = error;
    }
    let closeError;
    try {
        await handle.close();
    } catch (error) {
        closeError = error;
    }
    if (operationError && closeError) {
        throw durableWriteError(new AggregateError([
            operationError,
            closeError,
        ]));
    }
    if (operationError || closeError) {
        throw durableWriteError(operationError ?? closeError);
    }
}

async function stagePrivateFile(target, contents, openImpl) {
    const handle = await openImpl(target, 'wx', 0o600);
    await closeAfterOperation(handle, async () => {
        await handle.writeFile(contents);
        await handle.sync();
    });
}

async function syncDirectory(path, openImpl) {
    const handle = await openImpl(path, 'r');
    await closeAfterOperation(handle, () => handle.sync());
}

async function assertFinalDirectoryAbsent(finalDirectory) {
    try {
        await lstat(finalDirectory);
    } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
    }
    throw new Error(
        'ANALYSIS_V2_REPLAY_JOB_FINAL_DIRECTORY_EXISTS',
    );
}

async function publishImmutableDirectory({
    finalDirectory,
    files,
    mkdirImpl,
    openImpl,
    publishStep,
    renameImpl,
    rmImpl,
}) {
    const parentDirectory = dirname(finalDirectory);
    const stagingDirectory = join(
        parentDirectory,
        `.${basename(finalDirectory)}.tmp-${randomUUID()}`,
    );
    let stagingCreated = false;
    let published = false;
    try {
        await mkdirImpl(stagingDirectory, { mode: 0o700 });
        stagingCreated = true;
        await publishStep?.('staging-directory-created');
        for (const file of files) {
            await stagePrivateFile(
                join(stagingDirectory, basename(file.target)),
                file.contents,
                openImpl,
            );
            await publishStep?.(`${basename(file.target)}-durable`);
        }
        await syncDirectory(stagingDirectory, openImpl);
        await publishStep?.('staging-directory-durable');
        await assertFinalDirectoryAbsent(finalDirectory);
        await renameImpl(stagingDirectory, finalDirectory);
        published = true;
        await publishStep?.('final-directory-published');
        await syncDirectory(parentDirectory, openImpl);
        await publishStep?.('parent-directory-durable');
    } finally {
        if (stagingCreated && !published) {
            await rmImpl(stagingDirectory, {
                recursive: true,
                force: true,
            });
        }
    }
}

/**
 * @param {{
 *   outfile: string;
 *   metafile: string;
 *   runtimeManifest: string;
 *   imageDigest: string;
 *   buildImpl?: (
 *     options: { write?: boolean; [key: string]: unknown }
 *   ) => Promise<any>;
 *   mkdirImpl?: typeof mkdir;
 *   openImpl?: typeof open;
 *   publishStep?: (step: string) => void | Promise<void>;
 *   renameImpl?: (source: string, target: string) => Promise<void>;
 *   rmImpl?: typeof rm;
 * }} input
 */
export async function buildReplayAnalysisV2Job({
    outfile,
    metafile,
    runtimeManifest,
    imageDigest,
    buildImpl = build,
    mkdirImpl = mkdir,
    openImpl = open,
    publishStep,
    renameImpl = rename,
    rmImpl = rm,
}) {
    for (const [name, path] of Object.entries({
        outfile,
        metafile,
        runtimeManifest,
    })) {
        if (!path || !isAbsolute(path)) {
            throw new Error(`Missing absolute --${name}`);
        }
    }
    assertImmutableImageDigest(imageDigest);
    const resolvedOutputs = [outfile, metafile, runtimeManifest]
        .map(path => resolve(path));
    if (
        new Set(resolvedOutputs).size !== 3
    ) {
        throw new Error('Replay job build outputs must be distinct');
    }
    const outputDirectories = resolvedOutputs.map(dirname);
    if (
        new Set(outputDirectories).size !== 1
    ) {
        throw new Error(
            'Replay job build outputs must share one directory',
        );
    }
    const unresolvedFinalDirectory = outputDirectories[0];
    await realpath(dirname(unresolvedFinalDirectory));
    const finalDirectory = unresolvedFinalDirectory;
    await assertFinalDirectoryAbsent(finalDirectory);

    const lockfile = JSON.parse(await readFile(
        resolve(root, 'package-lock.json'),
        'utf8',
    ));
    const manifest = createReplayAnalysisV2JobRuntimeManifest(
        lockfile,
        imageDigest,
    );
    verifyReplayAnalysisV2JobRuntimeManifest(
        manifest,
        lockfile,
        imageDigest,
    );

    const result = await buildImpl({
        entryPoints: [
            resolve(root, 'scripts/replay-analysis-v2-job.ts'),
        ],
        outfile,
        alias: {
            '@/lib/supabase/admin': stub,
        },
        absWorkingDir: root,
        bundle: true,
        conditions: ['react-server'],
        format: 'esm',
        define: {
            __ANALYSIS_V2_REPLAY_JOB_IMAGE_DIGEST__:
                JSON.stringify(imageDigest),
        },
        metafile: true,
        packages: 'external',
        platform: 'node',
        sourcemap: false,
        target: 'node24',
        write: false,
    });

    auditReplayAnalysisV2JobBuildGraph(result.metafile);
    const output = result.outputFiles?.find(
        candidate => resolve(candidate.path) === resolve(outfile),
    );
    if (!output || result.outputFiles.length !== 1) {
        throw new Error(
            'ANALYSIS_V2_REPLAY_JOB_BUILD_GRAPH_FORBIDDEN: bundle output',
        );
    }

    await publishImmutableDirectory({
        finalDirectory,
        files: [
            {
                target: outfile,
                contents: output.contents,
            },
            {
                target: metafile,
                contents: `${JSON.stringify(
                    resolvedMetafile(result.metafile),
                    null,
                    2,
                )}\n`,
            },
            {
                target: runtimeManifest,
                contents: `${JSON.stringify(manifest, null, 2)}\n`,
            },
        ],
        mkdirImpl,
        openImpl,
        publishStep,
        renameImpl,
        rmImpl,
    });
}

function argument(name) {
    const index = process.argv.indexOf(name);
    const value = index >= 0 ? process.argv[index + 1] : undefined;
    if (!value || !isAbsolute(value)) {
        throw new Error(`Missing absolute ${name}`);
    }
    return value;
}

function literalArgument(name) {
    const index = process.argv.indexOf(name);
    const value = index >= 0 ? process.argv[index + 1] : undefined;
    if (!value) throw new Error(`Missing ${name}`);
    return value;
}

if (
    process.argv[1]
    && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    await buildReplayAnalysisV2Job({
        outfile: argument('--outfile'),
        metafile: argument('--metafile'),
        runtimeManifest: argument('--runtime-manifest'),
        imageDigest: literalArgument('--image-digest'),
    });
}
