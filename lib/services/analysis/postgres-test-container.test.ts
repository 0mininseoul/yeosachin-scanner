import { describe, expect, it } from 'vitest';
import {
    buildPostgresRemoveArgs,
    buildPostgresRunArgs,
    POSTGRES_TEST_DATA_DIR,
    POSTGRES_TEST_IMAGE,
    POSTGRES_TEST_TMPFS_SIZE_BYTES,
} from './postgres-test-container';

// These assertions are the regression guard for a confirmed disk leak: a
// 2026-08-23 audit of the development machine found 671 orphaned anonymous
// Docker volumes, 613 of them (49.47GB) allocated by this repository's
// PostgreSQL integration containers.  They run without a Docker daemon on
// purpose, so the invariant stays enforced in environments that skip the
// Docker-backed suites entirely.
const spec = {
    containerName: 'beta-apify-credit-test',
    password: 'postgres',
    database: 'beta_credit_test',
};

describe('postgres test container arguments', () => {
    it('mounts a tmpfs over the image-declared data directory', () => {
        const args = buildPostgresRunArgs(spec);
        const mountIndex = args.indexOf('--mount');
        expect(mountIndex).toBeGreaterThanOrEqual(0);
        const mount = args[mountIndex + 1]!;
        expect(mount).toContain('type=tmpfs');
        expect(mount).toContain(`destination=${POSTGRES_TEST_DATA_DIR}`);
        expect(mount).toContain(`tmpfs-size=${POSTGRES_TEST_TMPFS_SIZE_BYTES}`);
    });

    // `postgres:16-alpine` declares `VOLUME /var/lib/postgresql/data`.  Docker only
    // allocates an anonymous volume for a declared VOLUME path that has no explicit
    // mount, so covering exactly that path is what prevents the allocation.
    it('covers the exact path postgres:16-alpine declares as a VOLUME', () => {
        expect(POSTGRES_TEST_DATA_DIR).toBe('/var/lib/postgresql/data');
        expect(POSTGRES_TEST_IMAGE).toBe('postgres:16-alpine');
        expect(buildPostgresRunArgs(spec)).toContain(POSTGRES_TEST_IMAGE);
    });

    // Docker's default tmpfs size is 64MB; a fresh initdb cluster plus WAL needs more.
    it('requests a tmpfs large enough for an initdb cluster', () => {
        expect(POSTGRES_TEST_TMPFS_SIZE_BYTES).toBeGreaterThanOrEqual(256 * 1024 * 1024);
    });

    it('never binds a named or host volume that could outlive the container', () => {
        const args = buildPostgresRunArgs(spec);
        expect(args).not.toContain('-v');
        expect(args).not.toContain('--volume');
        expect(args.filter(arg => arg.startsWith('type=')))
            .toEqual([expect.stringContaining('type=tmpfs')]);
    });

    it('binds the published port to loopback and names the container', () => {
        const args = buildPostgresRunArgs(spec);
        expect(args.slice(0, 2)).toEqual(['run', '-d']);
        expect(args).toContain('--rm');
        expect(args[args.indexOf('--name') + 1]).toBe(spec.containerName);
        expect(args[args.indexOf('-p') + 1]).toBe('127.0.0.1::5432');
        expect(args).toContain(`POSTGRES_PASSWORD=${spec.password}`);
        expect(args).toContain(`POSTGRES_DB=${spec.database}`);
    });

    // `docker rm -f` without `-v` orphans the anonymous volume of a container that
    // was force-removed before it could exit on its own.  Teardown must always pass
    // `-v` so a partially failed run cannot strand storage.
    it('removes associated volumes on teardown even under force removal', () => {
        const args = buildPostgresRemoveArgs(spec.containerName);
        expect(args).toEqual(['rm', '-f', '-v', spec.containerName]);
    });
});
