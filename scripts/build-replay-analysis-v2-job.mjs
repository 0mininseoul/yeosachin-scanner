import { randomUUID } from 'node:crypto';
import {
    open,
    readFile,
    rename,
    unlink,
} from 'node:fs/promises';
import {
    basename,
    dirname,
    isAbsolute,
    join,
    resolve,
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

export function createReplayAnalysisV2JobRuntimeManifest(lockfile) {
    return {
        schema: 'analysis-v2-replay-job-runtime-v1',
        node: '24.x',
        conditions: ['react-server'],
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
) {
    const expected = createReplayAnalysisV2JobRuntimeManifest(lockfile);
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

async function stagePrivateFile(target, contents) {
    const temporary = join(
        dirname(target),
        `.${basename(target)}.tmp-${randomUUID()}`,
    );
    const handle = await open(temporary, 'wx', 0o600);
    try {
        await handle.writeFile(contents);
        await handle.sync();
    } catch (error) {
        await handle.close();
        await removeIfPresent(temporary);
        throw error;
    }
    await handle.close();
    return temporary;
}

async function removeIfPresent(path) {
    try {
        await unlink(path);
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            throw error;
        }
    }
}

async function publishAtomically(files, renameImpl) {
    const staged = [];
    try {
        for (const file of files) {
            staged.push({
                ...file,
                temporary: await stagePrivateFile(
                    file.target,
                    file.contents,
                ),
                backup: join(
                    dirname(file.target),
                    `.${basename(file.target)}.bak-${randomUUID()}`,
                ),
                backedUp: false,
                published: false,
            });
        }

        try {
            for (const file of staged) {
                try {
                    await renameImpl(file.target, file.backup);
                    file.backedUp = true;
                } catch (error) {
                    if (error?.code !== 'ENOENT') {
                        throw error;
                    }
                }
            }
            for (const file of staged) {
                await renameImpl(file.temporary, file.target);
                file.published = true;
            }
        } catch (error) {
            for (const file of [...staged].reverse()) {
                if (file.published) {
                    await removeIfPresent(file.target);
                }
            }
            for (const file of [...staged].reverse()) {
                if (file.backedUp) {
                    await renameImpl(file.backup, file.target);
                    file.backedUp = false;
                }
            }
            throw error;
        }

        for (const file of staged) {
            if (file.backedUp) {
                await removeIfPresent(file.backup);
                file.backedUp = false;
            }
        }
    } finally {
        for (const file of staged) {
            await removeIfPresent(file.temporary);
            await removeIfPresent(file.backup);
        }
    }
}

/**
 * @param {{
 *   outfile: string;
 *   metafile: string;
 *   runtimeManifest: string;
 *   buildImpl?: (
 *     options: { write?: boolean; [key: string]: unknown }
 *   ) => Promise<any>;
 *   renameImpl?: (source: string, target: string) => Promise<void>;
 * }} input
 */
export async function buildReplayAnalysisV2Job({
    outfile,
    metafile,
    runtimeManifest,
    buildImpl = build,
    renameImpl = rename,
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
    if (new Set([outfile, metafile, runtimeManifest]).size !== 3) {
        throw new Error('Replay job build outputs must be distinct');
    }

    const lockfile = JSON.parse(await readFile(
        resolve(root, 'package-lock.json'),
        'utf8',
    ));
    const manifest = createReplayAnalysisV2JobRuntimeManifest(lockfile);
    verifyReplayAnalysisV2JobRuntimeManifest(manifest, lockfile);

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

    await publishAtomically([
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
    ], renameImpl);
}

function argument(name) {
    const index = process.argv.indexOf(name);
    const value = index >= 0 ? process.argv[index + 1] : undefined;
    if (!value || !isAbsolute(value)) {
        throw new Error(`Missing absolute ${name}`);
    }
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
    });
}
