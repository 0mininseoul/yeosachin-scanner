import { randomUUID } from 'node:crypto';
import {
    closeSync as closeDescriptorSync,
    constants as fileConstants,
    fstatSync as fstatDescriptorSync,
    lstatSync,
    renameSync,
} from 'node:fs';
import {
    chmod,
    copyFile,
    cp,
    lstat,
    mkdir,
    open,
    opendir,
    readFile,
    readlink,
    readdir,
    realpath,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import {
    basename,
    dirname,
    isAbsolute,
    join,
    relative,
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
    'lib/services/analysis/replay/replay-public-name-fusion.ts',
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
/** V2.14 imports the sealed V2.13 job runtime but has its own direct entry. */
export const REPLAY_ANALYSIS_V214_JOB_LOCAL_INPUTS = Object.freeze([
    ...REPLAY_ANALYSIS_V2_JOB_LOCAL_INPUTS,
    'scripts/replay-analysis-v214-job.ts',
]);
/** V2.15 imports the sealed shared runtime but has its own direct entry. */
export const REPLAY_ANALYSIS_V215_JOB_LOCAL_INPUTS = Object.freeze([
    ...REPLAY_ANALYSIS_V2_JOB_LOCAL_INPUTS,
    'scripts/replay-analysis-v215-job.ts',
]);
/** V2.16 imports the sealed shared runtime but has its own direct entry. */
export const REPLAY_ANALYSIS_V216_JOB_LOCAL_INPUTS = Object.freeze([
    ...REPLAY_ANALYSIS_V2_JOB_LOCAL_INPUTS,
    'scripts/replay-analysis-v216-job.ts',
]);
/** V2.17 imports the sealed shared runtime but has its own direct entry. */
export const REPLAY_ANALYSIS_V217_JOB_LOCAL_INPUTS = Object.freeze([
    ...REPLAY_ANALYSIS_V2_JOB_LOCAL_INPUTS,
    'scripts/replay-analysis-v217-job.ts',
]);
const REPLAY_ANALYSIS_V2_JOB_ENTRYPOINTS = Object.freeze({
    'ai-stage-policy-v2.13': 'scripts/replay-analysis-v2-job.ts',
    'ai-stage-policy-v2.14': 'scripts/replay-analysis-v214-job.ts',
    'ai-stage-policy-v2.15': 'scripts/replay-analysis-v215-job.ts',
    'ai-stage-policy-v2.16': 'scripts/replay-analysis-v216-job.ts',
    'ai-stage-policy-v2.17': 'scripts/replay-analysis-v217-job.ts',
});

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
const MAX_PHYSICAL_PACKAGE_TREE_ENTRIES = 20_000;
const MAX_PHYSICAL_PACKAGE_TREE_BYTES = 512 * 1024 * 1024;
const MAX_PHYSICAL_PACKAGE_TREE_DEPTH = 32;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stub = resolve(
    root,
    'scripts/replay-analysis-v2-job-supabase-stub.ts',
);

function packageParentKey(packageKey) {
    const marker = '/node_modules/';
    const markerIndex = packageKey.lastIndexOf(marker);
    return markerIndex < 0
        ? ''
        : packageKey.slice(0, markerIndex);
}

async function physicalPackageDirectory(workspace, packageKey) {
    const nodeModules = join(workspace, 'node_modules');
    const path = join(workspace, packageKey);
    let entry;
    try {
        entry = await lstat(path);
    } catch (error) {
        if (error?.code === 'ENOENT') return undefined;
        throw error;
    }
    if (
        entry.isSymbolicLink()
        || !entry.isDirectory()
        || await realpath(path) !== path
        || (
            path !== nodeModules
            && !path.startsWith(`${nodeModules}${sep}`)
        )
    ) {
        throw new Error(
            'ANALYSIS_V2_REPLAY_JOB_PHYSICAL_CLOSURE_INVALID',
        );
    }
    return path;
}

async function resolvePhysicalDependencyKey({
    dependency,
    fromKey,
    lockfile,
    workspace,
}) {
    let ancestor = fromKey;
    while (true) {
        const candidate = ancestor
            ? `${ancestor}/node_modules/${dependency}`
            : `node_modules/${dependency}`;
        if (
            lockfile.packages?.[candidate]
            && await physicalPackageDirectory(
                workspace,
                candidate,
            )
        ) {
            return candidate;
        }
        if (!ancestor) return undefined;
        ancestor = packageParentKey(ancestor);
    }
}

export async function resolveReplayAnalysisV2JobPhysicalDependencyClosure({
    lockfile,
    sourceWorkspace,
}) {
    const workspace = await realpath(sourceWorkspace);
    const pending = EXTERNAL_PACKAGES.map(
        name => `node_modules/${name}`,
    );
    const packages = new Set();
    while (pending.length > 0) {
        const packageKey = pending.shift();
        if (packages.has(packageKey)) continue;
        const locked = lockfile.packages?.[packageKey];
        if (
            !locked
            || !await physicalPackageDirectory(workspace, packageKey)
        ) {
            throw new Error(
                'ANALYSIS_V2_REPLAY_JOB_PHYSICAL_CLOSURE_INVALID',
            );
        }
        packages.add(packageKey);
        const requiredPeers = Object.keys(
            locked.peerDependencies ?? {},
        ).filter(name => (
            !locked.peerDependenciesMeta?.[name]?.optional
        ));
        const dependencies = new Set([
            ...Object.keys(locked.dependencies ?? {}),
            ...Object.keys(locked.optionalDependencies ?? {}),
            ...requiredPeers,
        ]);
        for (const dependency of dependencies) {
            const resolvedDependency =
                await resolvePhysicalDependencyKey({
                    dependency,
                    fromKey: packageKey,
                    lockfile,
                    workspace,
                });
            const required = dependency in (
                locked.dependencies ?? {}
            ) || requiredPeers.includes(dependency);
            if (!resolvedDependency) {
                if (required) {
                    throw new Error(
                        'ANALYSIS_V2_REPLAY_JOB_PHYSICAL_CLOSURE_INVALID',
                    );
                }
                continue;
            }
            pending.push(resolvedDependency);
        }
    }
    return [...packages].sort();
}

export async function copyReplayAnalysisV2JobPhysicalDependencyClosure({
    sourceWorkspace,
    imageWorkspace,
}) {
    const source = await realpath(sourceWorkspace);
    const destination = await realpath(imageWorkspace);
    const lockfilePath = join(source, 'package-lock.json');
    const lockfile = JSON.parse(await readFile(lockfilePath, 'utf8'));
    const packages =
        await resolveReplayAnalysisV2JobPhysicalDependencyClosure({
            lockfile,
            sourceWorkspace: source,
        });
    const nodeModules = join(destination, 'node_modules');
    await mkdir(nodeModules, { mode: 0o755 });
    for (const packageKey of packages) {
        const sourcePackage = join(source, packageKey);
        const destinationPackage = join(destination, packageKey);
        await mkdir(dirname(destinationPackage), {
            recursive: true,
        });
        await cp(sourcePackage, destinationPackage, {
            recursive: true,
            dereference: true,
            errorOnExist: true,
            force: false,
            filter: path => {
                const nested = relative(sourcePackage, path);
                return !nested
                    || !nested.split(sep).includes('node_modules');
            },
        });
    }
    const imageLockfile = join(destination, 'package-lock.json');
    await copyFile(
        lockfilePath,
        imageLockfile,
        fileConstants.COPYFILE_EXCL,
    );
    await chmod(imageLockfile, 0o600);
    const provenance = {
        schema: 'analysis-v2-replay-job-physical-closure-v1',
        platform: process.platform,
        arch: process.arch,
        packages: packages.map(path => ({
            path,
            version: lockfile.packages[path].version,
            integrity: lockfile.packages[path].integrity ?? null,
        })),
    };
    await writeFile(
        join(
            destination,
            'replay-job-dependency-provenance.json',
        ),
        `${JSON.stringify(provenance, null, 2)}\n`,
        {
            flag: 'wx',
            mode: 0o600,
        },
    );
    return {
        platform: process.platform,
        arch: process.arch,
        packages,
    };
}

function isStrictDescendant(parent, candidate) {
    const nested = relative(parent, candidate);
    return (
        nested !== ''
        && nested !== '..'
        && !nested.startsWith(`..${sep}`)
        && !isAbsolute(nested)
    );
}

export async function verifyReplayAnalysisV2JobPhysicalPackageTree({
    packageDirectory,
    nodeModulesDirectory,
    budget,
    opendirImpl = opendir,
    observeTraversal,
}) {
    try {
        const packageRoot = resolve(packageDirectory);
        const nodeModulesRoot = resolve(nodeModulesDirectory);
        if (!isStrictDescendant(nodeModulesRoot, packageRoot)) {
            throw new Error('package root escape');
        }
        const pending = [];
        const observe = () => observeTraversal?.({
            pending: pending.length,
            processed: budget.processed,
            discovered: budget.discovered,
        });
        const enqueue = candidate => {
            if (
                budget.discovered
                >= MAX_PHYSICAL_PACKAGE_TREE_ENTRIES
            ) {
                throw new Error('package tree entry limit');
            }
            budget.discovered += 1;
            pending.push(candidate);
            observe();
        };
        enqueue({
            path: packageRoot,
            depth: 0,
        });
        while (pending.length > 0) {
            const current = pending.pop();
            if (
                current.depth > MAX_PHYSICAL_PACKAGE_TREE_DEPTH
                || (
                    current.path !== packageRoot
                    && !isStrictDescendant(
                        packageRoot,
                        current.path,
                    )
                )
                || !isStrictDescendant(
                    nodeModulesRoot,
                    current.path,
                )
            ) {
                throw new Error('package tree escape or depth');
            }
            const entry = await lstat(current.path);
            budget.processed += 1;
            observe();
            if (entry.isFile()) {
                budget.bytes += entry.size;
                if (
                    budget.bytes
                    > MAX_PHYSICAL_PACKAGE_TREE_BYTES
                ) {
                    throw new Error('package tree byte limit');
                }
                continue;
            }
            if (!entry.isDirectory()) {
                throw new Error('package tree special entry');
            }
            const directory = await opendirImpl(current.path);
            for await (const child of directory) {
                enqueue({
                    path: join(current.path, child.name),
                    depth: current.depth + 1,
                });
            }
        }
    } catch (cause) {
        throw new Error(
            'physical closure package tree invalid',
            { cause },
        );
    }
}

function forbiddenGraph(reason) {
    throw new Error(
        `ANALYSIS_V2_REPLAY_JOB_BUILD_GRAPH_FORBIDDEN: ${reason}`,
    );
}

function replayJobLocalInputs(evaluationAiPolicy) {
    if (evaluationAiPolicy === 'ai-stage-policy-v2.13') {
        return REPLAY_ANALYSIS_V2_JOB_LOCAL_INPUTS;
    }
    if (evaluationAiPolicy === 'ai-stage-policy-v2.14') {
        return REPLAY_ANALYSIS_V214_JOB_LOCAL_INPUTS;
    }
    if (evaluationAiPolicy === 'ai-stage-policy-v2.15') {
        return REPLAY_ANALYSIS_V215_JOB_LOCAL_INPUTS;
    }
    if (evaluationAiPolicy === 'ai-stage-policy-v2.16') {
        return REPLAY_ANALYSIS_V216_JOB_LOCAL_INPUTS;
    }
    if (evaluationAiPolicy === 'ai-stage-policy-v2.17') {
        return REPLAY_ANALYSIS_V217_JOB_LOCAL_INPUTS;
    }
    throw new Error('ANALYSIS_V2_REPLAY_JOB_BUILD_ENTRY_POLICY_INVALID');
}

function replayJobEntrypoint(evaluationAiPolicy) {
    const entrypoint = REPLAY_ANALYSIS_V2_JOB_ENTRYPOINTS[evaluationAiPolicy];
    if (!entrypoint) {
        throw new Error('ANALYSIS_V2_REPLAY_JOB_BUILD_ENTRY_POLICY_INVALID');
    }
    return entrypoint;
}

export function auditReplayAnalysisV2JobBuildGraph(
    metafile,
    evaluationAiPolicy = 'ai-stage-policy-v2.13',
) {
    if (!metafile || typeof metafile !== 'object') {
        forbiddenGraph('missing metafile');
    }

    const actualInputs = Object.keys(metafile.inputs ?? {}).sort();
    const expectedInputs = [...replayJobLocalInputs(evaluationAiPolicy)].sort();
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
    manifest,
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
        const packageLockPath = mountedPath(
            manifest?.dependencyClosure?.packageLock,
        );
        const provenancePath = mountedPath(
            manifest?.dependencyClosure?.provenance,
        );
        if (
            manifest?.dependencyClosure?.authority
                !== 'immutable-container-image'
            || manifest.dependencyClosure.image !== contract.image
            || manifest.dependencyClosure.workspace !== contract.workdir
            || manifest.dependencyClosure.nodeModules
                !== contract.nodeModules
            || manifest.dependencyClosure.packageLock
                !== '/workspace/package-lock.json'
            || manifest.dependencyClosure.provenance
                !== '/workspace/replay-job-dependency-provenance.json'
            || manifest.schema !== 'analysis-v2-replay-job-runtime-v2'
        ) {
            throw new Error('runtime manifest closure mismatch');
        }
        const [
            workspace,
            nodeModules,
            packageLock,
            provenanceFile,
        ] = await Promise.all([
            lstat(workspacePath),
            lstat(nodeModulesPath),
            lstat(packageLockPath),
            lstat(provenancePath),
        ]);
        if (
            workspace.isSymbolicLink()
            || !workspace.isDirectory()
            || nodeModules.isSymbolicLink()
            || !nodeModules.isDirectory()
            || packageLock.isSymbolicLink()
            || !packageLock.isFile()
            || provenanceFile.isSymbolicLink()
            || !provenanceFile.isFile()
        ) {
            throw new Error('invalid filesystem type');
        }
        const [
            realWorkspace,
            realNodeModules,
            realPackageLock,
            realProvenance,
        ] =
            await Promise.all([
                realpath(workspacePath),
                realpath(nodeModulesPath),
                realpath(packageLockPath),
                realpath(provenancePath),
            ]);
        if (
            realWorkspace !== workspacePath
            || realNodeModules !== nodeModulesPath
            || realPackageLock !== packageLockPath
            || realProvenance !== provenancePath
        ) {
            throw new Error('filesystem indirection');
        }
        const pointer = await verifyReplayAnalysisV2JobArtifactPointer({
            finalDirectory: dirname(entrypointPath),
        });
        if (
            basename(entrypointPath) !== 'job.mjs'
            || await realpath(entrypointPath)
                !== join(
                    await realpath(pointer.contentDirectory),
                    'job.mjs',
                )
        ) {
            throw new Error('entrypoint pointer mismatch');
        }
        const imageLockfile = JSON.parse(await readFile(
            packageLockPath,
            'utf8',
        ));
        for (const name of EXTERNAL_PACKAGES) {
            const expected = manifest.externalPackages?.[name];
            const packageDirectory = join(nodeModulesPath, name);
            let packageEntry;
            try {
                packageEntry = await lstat(packageDirectory);
            } catch (error) {
                if (error?.code === 'ENOENT') {
                    throw new Error('dependency package missing');
                }
                throw error;
            }
            if (
                packageEntry.isSymbolicLink()
                || !packageEntry.isDirectory()
                || await realpath(packageDirectory) !== packageDirectory
            ) {
                throw new Error('dependency package is not physical');
            }
            const packageJsonPath = join(
                packageDirectory,
                'package.json',
            );
            const packageJsonEntry = await lstat(packageJsonPath);
            if (
                packageJsonEntry.isSymbolicLink()
                || !packageJsonEntry.isFile()
                || await realpath(packageJsonPath) !== packageJsonPath
            ) {
                throw new Error('dependency package is not physical');
            }
            const packageJson = JSON.parse(await readFile(
                packageJsonPath,
                'utf8',
            ));
            if (
                packageJson.name !== name
                || packageJson.version !== expected?.version
            ) {
                throw new Error(
                    'dependency package provenance mismatch',
                );
            }
            const locked = imageLockfile?.packages?.[
                `node_modules/${name}`
            ];
            if (
                locked?.version !== expected.version
                || locked?.integrity !== expected.integrity
            ) {
                throw new Error(
                    'dependency lock provenance mismatch',
                );
            }
        }
        const provenance = JSON.parse(await readFile(
            provenancePath,
            'utf8',
        ));
        let computedPackages;
        try {
            computedPackages =
                await resolveReplayAnalysisV2JobPhysicalDependencyClosure({
                    lockfile: imageLockfile,
                    sourceWorkspace: workspacePath,
                });
        } catch {
            throw new Error(
                'physical closure provenance mismatch',
            );
        }
        if (
            provenance?.schema
                !== 'analysis-v2-replay-job-physical-closure-v1'
            || provenance.platform !== process.platform
            || provenance.arch !== process.arch
            || !Array.isArray(provenance.packages)
            || provenance.packages.length
                !== computedPackages.length
            || provenance.packages.some((entry, index) => (
                !entry
                || typeof entry !== 'object'
                || entry.path !== computedPackages[index]
            ))
        ) {
            throw new Error(
                'physical closure provenance mismatch',
            );
        }
        const packageTreeBudget = {
            discovered: 0,
            processed: 0,
            bytes: 0,
        };
        for (const entry of provenance.packages) {
            const locked = imageLockfile.packages?.[entry.path];
            const packageDirectory = join(
                workspacePath,
                entry.path,
            );
            const packageJsonPath = join(
                packageDirectory,
                'package.json',
            );
            let packageJson;
            try {
                const packageJsonEntry = await lstat(packageJsonPath);
                if (
                    packageJsonEntry.isSymbolicLink()
                    || !packageJsonEntry.isFile()
                    || await realpath(packageJsonPath)
                        !== packageJsonPath
                ) {
                    throw new Error('not physical');
                }
                packageJson = JSON.parse(await readFile(
                    packageJsonPath,
                    'utf8',
                ));
            } catch {
                throw new Error(
                    'physical closure provenance mismatch',
                );
            }
            if (
                typeof entry.version !== 'string'
                || packageJson.version !== entry.version
                || locked?.version !== entry.version
                || (locked.integrity ?? null)
                    !== entry.integrity
            ) {
                throw new Error(
                    'physical closure provenance mismatch',
                );
            }
            await verifyReplayAnalysisV2JobPhysicalPackageTree({
                packageDirectory,
                nodeModulesDirectory: nodeModulesPath,
                budget: packageTreeBudget,
            });
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
            packageLock: '/workspace/package-lock.json',
            provenance:
                '/workspace/replay-job-dependency-provenance.json',
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

async function closeAfterOperation(
    handle,
    operation,
    {
        closeSyncImpl,
        fstatSyncImpl,
    },
) {
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
    let fallbackError;
    if (
        closeError
        && Number.isInteger(handle.fd)
        && handle.fd >= 0
    ) {
        try {
            fstatSyncImpl(handle.fd);
            closeSyncImpl(handle.fd);
        } catch (error) {
            if (error?.code !== 'EBADF') {
                fallbackError = error;
            }
        }
    }
    const errors = [
        operationError,
        closeError,
        fallbackError,
    ].filter(Boolean);
    if (errors.length > 0) {
        throw durableWriteError(
            errors.length === 1
                ? errors[0]
                : new AggregateError(errors),
        );
    }
}

async function stagePrivateFile(
    target,
    contents,
    openImpl,
    closeDependencies,
) {
    const handle = await openImpl(target, 'wx', 0o600);
    await closeAfterOperation(handle, async () => {
        await handle.writeFile(contents);
        await handle.sync();
    }, closeDependencies);
}

async function syncDirectory(path, openImpl, closeDependencies) {
    const handle = await openImpl(path, 'r');
    await closeAfterOperation(
        handle,
        () => handle.sync(),
        closeDependencies,
    );
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

async function removeOwnedUnpublishedContent({
    contentDirectory,
    identity,
    rmImpl,
}) {
    let current;
    try {
        current = lstatSync(contentDirectory);
    } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
    }
    if (
        current.isSymbolicLink()
        || !current.isDirectory()
        || current.dev !== identity.device
        || current.ino !== identity.inode
    ) {
        return;
    }
    const quarantine = `${contentDirectory}.cleanup-${randomUUID()}`;
    renameSync(contentDirectory, quarantine);
    const moved = lstatSync(quarantine);
    if (
        moved.isSymbolicLink()
        || !moved.isDirectory()
        || moved.dev !== identity.device
        || moved.ino !== identity.inode
    ) {
        return;
    }
    await rmImpl(quarantine, {
        recursive: true,
        force: true,
    });
}

const REPLAY_JOB_ARTIFACT_FILES = Object.freeze([
    'job.mjs',
    'meta.json',
    'runtime.json',
]);

export async function verifyReplayAnalysisV2JobArtifactPointer({
    finalDirectory,
}) {
    try {
        const resolvedFinalDirectory = resolve(finalDirectory);
        const parentDirectory = dirname(resolvedFinalDirectory);
        const canonicalParent = await realpath(parentDirectory);
        const pointer = await lstat(resolvedFinalDirectory);
        if (!pointer.isSymbolicLink()) {
            throw new Error('final path is not a symlink');
        }
        const relativeTarget = await readlink(resolvedFinalDirectory);
        const expectedPrefix = `.${basename(resolvedFinalDirectory)}.content-`;
        if (
            relativeTarget !== basename(relativeTarget)
            || !relativeTarget.startsWith(expectedPrefix)
            || relativeTarget.length === expectedPrefix.length
        ) {
            throw new Error('pointer target is not a unique sibling');
        }
        const contentDirectory = join(parentDirectory, relativeTarget);
        const canonicalContentDirectory = join(
            canonicalParent,
            relativeTarget,
        );
        const content = await lstat(contentDirectory);
        if (
            content.isSymbolicLink()
            || !content.isDirectory()
            || (content.mode & 0o077) !== 0
        ) {
            throw new Error('content directory is not private and physical');
        }
        const [realContent, realPointer] = await Promise.all([
            realpath(contentDirectory),
            realpath(resolvedFinalDirectory),
        ]);
        if (
            realContent !== canonicalContentDirectory
            || realPointer !== canonicalContentDirectory
        ) {
            throw new Error('pointer escaped its owned sibling');
        }
        const files = (await readdir(contentDirectory)).sort();
        if (
            files.length !== REPLAY_JOB_ARTIFACT_FILES.length
            || files.some((
                file,
                index,
            ) => file !== REPLAY_JOB_ARTIFACT_FILES[index])
        ) {
            throw new Error('immutable content triplet mismatch');
        }
        for (const file of files) {
            const path = join(contentDirectory, file);
            const entry = await lstat(path);
            if (
                entry.isSymbolicLink()
                || !entry.isFile()
                || (entry.mode & 0o077) !== 0
                || await realpath(path) !== join(
                    canonicalContentDirectory,
                    file,
                )
            ) {
                throw new Error('immutable content file invalid');
            }
        }
        return {
            contentDirectory,
            files,
        };
    } catch (cause) {
        throw new Error(
            'ANALYSIS_V2_REPLAY_JOB_ARTIFACT_POINTER_INVALID',
            { cause },
        );
    }
}

async function publishImmutableDirectory({
    finalDirectory,
    files,
    closeDependencies,
    mkdirImpl,
    openImpl,
    publishStep,
    rmImpl,
    symlinkImpl,
}) {
    const parentDirectory = dirname(finalDirectory);
    const contentDirectory = join(
        parentDirectory,
        `.${basename(finalDirectory)}.content-${randomUUID()}`,
    );
    let contentCreated = false;
    let contentIdentity;
    let published = false;
    try {
        await mkdirImpl(contentDirectory, { mode: 0o700 });
        contentCreated = true;
        const created = await lstat(contentDirectory);
        contentIdentity = {
            device: created.dev,
            inode: created.ino,
        };
        await publishStep?.('content-directory-created');
        for (const file of files) {
            await stagePrivateFile(
                join(contentDirectory, basename(file.target)),
                file.contents,
                openImpl,
                closeDependencies,
            );
            await publishStep?.(`${basename(file.target)}-durable`);
        }
        await syncDirectory(
            contentDirectory,
            openImpl,
            closeDependencies,
        );
        await publishStep?.('content-directory-durable');
        await assertFinalDirectoryAbsent(finalDirectory);
        await publishStep?.('final-path-absent');
        try {
            await symlinkImpl(
                basename(contentDirectory),
                finalDirectory,
                'dir',
            );
        } catch (error) {
            if (error?.code === 'EEXIST') {
                throw new Error(
                    'ANALYSIS_V2_REPLAY_JOB_FINAL_DIRECTORY_EXISTS',
                    { cause: error },
                );
            }
            throw error;
        }
        published = true;
        await publishStep?.('final-pointer-published');
        await syncDirectory(
            parentDirectory,
            openImpl,
            closeDependencies,
        );
        await publishStep?.('parent-directory-durable');
        await verifyReplayAnalysisV2JobArtifactPointer({
            finalDirectory,
        });
    } finally {
        // Never scan or delete residue from another invocation. Only the
        // inode captured immediately after this invocation's mkdir is eligible
        // for pre-pointer cleanup; crash residue stays inert and unreachable.
        if (contentCreated && contentIdentity && !published) {
            await removeOwnedUnpublishedContent({
                contentDirectory,
                identity: contentIdentity,
                rmImpl,
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
 *   evaluationAiPolicy?: 'ai-stage-policy-v2.13' | 'ai-stage-policy-v2.14' | 'ai-stage-policy-v2.15' | 'ai-stage-policy-v2.16' | 'ai-stage-policy-v2.17';
 *   buildImpl?: (
 *     options: { write?: boolean; [key: string]: unknown }
 *   ) => Promise<any>;
 *   closeSyncImpl?: typeof closeDescriptorSync;
 *   fstatSyncImpl?: typeof fstatDescriptorSync;
 *   mkdirImpl?: typeof mkdir;
 *   openImpl?: typeof open;
 *   publishStep?: (step: string) => void | Promise<void>;
 *   rmImpl?: typeof rm;
 *   symlinkImpl?: typeof symlink;
 * }} input
 */
export async function buildReplayAnalysisV2Job({
    outfile,
    metafile,
    runtimeManifest,
    imageDigest,
    evaluationAiPolicy = 'ai-stage-policy-v2.13',
    buildImpl = build,
    closeSyncImpl = closeDescriptorSync,
    fstatSyncImpl = fstatDescriptorSync,
    mkdirImpl = mkdir,
    openImpl = open,
    publishStep,
    rmImpl = rm,
    symlinkImpl = symlink,
}) {
    const entrypoint = replayJobEntrypoint(evaluationAiPolicy);
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
            resolve(root, entrypoint),
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
            __ANALYSIS_V2_REPLAY_JOB_ENTRY_POLICY__:
                JSON.stringify(evaluationAiPolicy),
        },
        metafile: true,
        packages: 'external',
        platform: 'node',
        sourcemap: false,
        target: 'node24',
        write: false,
    });

    auditReplayAnalysisV2JobBuildGraph(result.metafile, evaluationAiPolicy);
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
        closeDependencies: {
            closeSyncImpl,
            fstatSyncImpl,
        },
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
        rmImpl,
        symlinkImpl,
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

function optionalLiteralArgument(name, fallback) {
    const index = process.argv.indexOf(name);
    const assignment = process.argv.find(argument => (
        argument.startsWith(`${name}=`)
    ));
    if (index >= 0 && assignment) throw new Error(`Duplicate ${name}`);
    if (index < 0 && !assignment) return fallback;
    const value = assignment
        ? assignment.slice(name.length + 1)
        : process.argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing ${name}`);
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
        evaluationAiPolicy: optionalLiteralArgument(
            '--evaluation-ai-policy',
            'ai-stage-policy-v2.13',
        ),
    });
}
