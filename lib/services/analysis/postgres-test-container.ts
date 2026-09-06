import { execFileSync } from 'node:child_process';

// Docker lifecycle arguments for the repository's PostgreSQL integration containers.
//
// `postgres:16-alpine` declares `VOLUME /var/lib/postgresql/data`.  Docker allocates a
// fresh *anonymous* volume for any declared VOLUME path left without an explicit mount,
// so every `docker run` of the image used to strand roughly one initdb cluster (~82MB)
// on the host.  `--rm` only reaps that volume when the container exits on its own, and
// `docker rm -f` without `-v` never reaps it, so an interrupted run, a suite timeout or
// a force removal orphaned the volume permanently.  A 2026-08-23 audit of the
// development machine found 671 orphaned anonymous volumes, 613 of them (49.47GB)
// traceable to these test containers.
//
// Mounting a tmpfs over the declared path removes the failure mode at the source rather
// than relying on teardown running: with an explicit mount present Docker never creates
// the anonymous volume, so no persistent storage exists to leak however the test process
// dies.  This tmpfs property independently prevents persistent-volume leakage; explicit
// catch, afterAll, and normal-process-exit cleanup remain best-effort container cleanup.
// The cluster is throwaway per suite, so keeping it in RAM also preserves test semantics
// exactly while removing the disk write entirely.

/** The path `postgres:16-alpine` declares as a `VOLUME`. */
export const POSTGRES_TEST_DATA_DIR = '/var/lib/postgresql/data';

export const POSTGRES_TEST_IMAGE = 'postgres:16-alpine';

// Docker's default tmpfs maximum is 50% of host RAM.  `64m` is the default size of
// `/dev/shm`, not this data mount.  Pin a larger ceiling so a fresh initdb cluster plus
// its 16MB WAL segments has room; tmpfs only consumes pages actually written.
export const POSTGRES_TEST_TMPFS_SIZE_BYTES = 512 * 1024 * 1024;

export interface PostgresTestContainerSpec {
    containerName: string;
    password: string;
    database: string;
    image?: string;
}

/**
 * Arguments for starting a throwaway PostgreSQL container that cannot leak storage.
 *
 * The tmpfs is created root-owned at mode 0700; the official entrypoint runs as root and
 * chowns `PGDATA` to `postgres` before dropping privileges, which is the same shape a
 * normal volume mount presents to it.
 */
export function buildPostgresRunArgs(spec: PostgresTestContainerSpec): string[] {
    const tmpfs = [
        'type=tmpfs',
        `destination=${POSTGRES_TEST_DATA_DIR}`,
        `tmpfs-size=${POSTGRES_TEST_TMPFS_SIZE_BYTES}`,
        'tmpfs-mode=0700',
    ].join(',');
    return [
        'run', '-d', '--rm', '--name', spec.containerName,
        '--mount', tmpfs,
        '-e', `POSTGRES_PASSWORD=${spec.password}`,
        '-e', `POSTGRES_DB=${spec.database}`,
        '-p', '127.0.0.1::5432',
        spec.image ?? POSTGRES_TEST_IMAGE,
    ];
}

/**
 * Arguments for teardown.  `-v` is required: without it a force removal leaves behind any
 * anonymous volume the container still owns.  It stays as defence in depth even though
 * {@link buildPostgresRunArgs} no longer creates one, so a future caller that reintroduces
 * a volume cannot silently reintroduce the leak.
 */
export function buildPostgresRemoveArgs(containerName: string): string[] {
    return ['rm', '-f', '-v', containerName];
}

export interface PostgresDockerCommandOptions {
    encoding?: 'utf8';
    stdio?: 'ignore';
    timeout?: number;
}

export type PostgresDockerCommandRunner = (
    command: string,
    args: string[],
    options?: PostgresDockerCommandOptions,
) => string | Buffer;

function runDockerCommand(
    command: string,
    args: string[],
    options?: PostgresDockerCommandOptions,
): string | Buffer {
    return execFileSync(command, args, options) as string | Buffer;
}

function commandOutput(value: string | Buffer): string {
    return typeof value === 'string' ? value : value.toString('utf8');
}

export interface PostgresTestContainerLifecycleOptions {
    suppliedUrl?: string;
    containerName: string;
    password: string;
    database: string;
    image?: string;
    commandRunner?: PostgresDockerCommandRunner;
}

export interface PostgresTestContainerLifecycle {
    /** Start Docker and return its connection URL, or return the supplied URL unchanged. */
    start(): string;
    /** Best-effort synchronous cleanup; failed removal remains retryable. */
    cleanup(): void;
    /** Whether this lifecycle was configured to use Docker. */
    usesDocker: boolean;
}

/**
 * Build the Docker-owned portion of the PostgreSQL test lifecycle.
 *
 * The initial remove is an idempotent name fence.  It is intentionally separate from
 * the current run's reaper state: a successful fence must not suppress cleanup of the
 * container that is started immediately afterward.  `cleanup()` marks a run reaped only
 * after the remove command returns successfully, so a transient failure can be retried
 * by the beforeAll catch, afterAll, or the normal-process-exit handler.
 */
export function createPostgresTestContainerLifecycle(
    options: PostgresTestContainerLifecycleOptions,
): PostgresTestContainerLifecycle {
    const commandRunner = options.commandRunner ?? runDockerCommand;
    const usesDocker = !options.suppliedUrl;
    let containerAttempted = false;
    let containerReaped = false;
    let exitCleanupRegistered = false;

    const removeOptions: PostgresDockerCommandOptions = {
        stdio: 'ignore',
        timeout: 15_000,
    };

    const unregisterExitCleanup = (exitCleanup: () => void): void => {
        if (!exitCleanupRegistered) return;
        process.removeListener('exit', exitCleanup);
        exitCleanupRegistered = false;
    };

    const cleanup = (): void => {
        if (!containerAttempted || containerReaped) return;
        try {
            commandRunner('docker', buildPostgresRemoveArgs(options.containerName), removeOptions);
            // Do not move this assignment above commandRunner: a transient command failure
            // must leave cleanup retryable for a later hook.
            containerReaped = true;
            unregisterExitCleanup(cleanup);
        } catch {
            // `--rm` may already have removed an exited container.  Keep the state unreaped
            // so a transient daemon/CLI failure is retried by a later cleanup hook.
        }
    };

    const registerExitCleanup = (): void => {
        if (exitCleanupRegistered) return;
        process.once('exit', cleanup);
        exitCleanupRegistered = true;
    };

    const start = (): string => {
        if (!usesDocker) return options.suppliedUrl!;

        // Mark the attempt before the fence: even a run or port command that throws still
        // gets a best-effort rm -f -v attempt from the catch/afterAll/normal exit paths.
        containerAttempted = true;
        registerExitCleanup();

        // The UUID name is unique in normal operation, but this fence makes retries safe
        // and prevents a stale same-name container from blocking docker run.
        try {
            commandRunner('docker', buildPostgresRemoveArgs(options.containerName), removeOptions);
        } catch {
            // A missing or transiently unreachable container must not prevent the run from
            // being attempted; cleanup() below remains responsible for retrying removal.
        }

        const id = commandOutput(commandRunner(
            'docker',
            buildPostgresRunArgs({
                containerName: options.containerName,
                password: options.password,
                database: options.database,
                image: options.image,
            }),
            { encoding: 'utf8' },
        )).trim();
        if (!id) throw new Error('BETA_APIFY_POSTGRES_DOCKER_START_FAILED');

        const portOutput = commandOutput(commandRunner(
            'docker',
            ['port', options.containerName, '5432/tcp'],
            { encoding: 'utf8' },
        )).trim();
        const port = portOutput.split(':').at(-1)?.trim();
        if (!port) throw new Error('BETA_APIFY_POSTGRES_DOCKER_PORT_MISSING');
        return `postgres://postgres:${options.password}@127.0.0.1:${port}/${options.database}`;
    };

    return { start, cleanup, usesDocker };
}

export interface InitializePostgresTestContainerOptions {
    lifecycle: PostgresTestContainerLifecycle;
    suppliedUrl?: string;
    waitForDatabase: (url: string) => Promise<void>;
    connectClients: (url: string) => Promise<void>;
    setupDatabase: () => Promise<void>;
    closeClients: () => Promise<void>;
}

/**
 * Run all beforeAll work, including readiness and database setup, behind one cleanup fence.
 * The callbacks make this contract testable without a Docker daemon while preserving the
 * production hook's order: close clients first, then attempt container removal, then
 * rethrow the original failure.
 */
export async function initializePostgresTestContainer(
    options: InitializePostgresTestContainerOptions,
): Promise<string> {
    let databaseUrl = options.suppliedUrl;
    try {
        if (!databaseUrl) databaseUrl = options.lifecycle.start();
        await options.waitForDatabase(databaseUrl);
        await options.connectClients(databaseUrl);
        await options.setupDatabase();
        return databaseUrl;
    } catch (error) {
        await options.closeClients().catch(() => undefined);
        options.lifecycle.cleanup();
        throw error;
    }
}
