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
// dies.  The cluster is throwaway per suite, so keeping it in RAM also preserves test
// semantics exactly while removing the disk write entirely.

/** The path `postgres:16-alpine` declares as a `VOLUME`. */
export const POSTGRES_TEST_DATA_DIR = '/var/lib/postgresql/data';

export const POSTGRES_TEST_IMAGE = 'postgres:16-alpine';

// Docker's default tmpfs size is 64MB, well under a fresh initdb cluster plus its 16MB
// WAL segments.  tmpfs only consumes the pages actually written, so this is a ceiling
// rather than an allocation.
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
