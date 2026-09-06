import { describe, expect, it } from 'vitest';
import {
    buildPostgresRemoveArgs,
    buildPostgresRunArgs,
    createPostgresTestContainerLifecycle,
    initializePostgresTestContainer,
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

    // Docker's default tmpfs maximum is 50% of host RAM; 64m is `/dev/shm`, not this
    // mount.  The explicit ceiling gives initdb and WAL ample room.
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

interface FakeDockerCall {
    command: string;
    args: string[];
}

function fakeDockerRunner(input: {
    failAction?: string;
} = {}): { calls: FakeDockerCall[]; runner: (command: string, args: string[]) => string } {
    const calls: FakeDockerCall[] = [];
    return {
        calls,
        runner: (command, args) => {
            calls.push({ command, args: [...args] });
            if (args[0] === input.failAction) {
                throw new Error(`FAKE_${args[0]!.toUpperCase()}_FAILURE`);
            }
            if (args[0] === 'run') return 'fake-container-id\n';
            if (args[0] === 'port') return '127.0.0.1:54321\n';
            return '';
        },
    };
}

const lifecycleSpec = {
    containerName: 'beta-apify-credit-fake',
    password: 'postgres',
    database: 'beta_credit_test',
};

describe('postgres test container lifecycle', () => {
    it('runs the cleanup fence before Docker run and reaps with -f -v', () => {
        const fake = fakeDockerRunner();
        const lifecycle = createPostgresTestContainerLifecycle({
            ...lifecycleSpec,
            commandRunner: fake.runner,
        });

        expect(lifecycle.start()).toBe('postgres://postgres:postgres@127.0.0.1:54321/beta_credit_test');
        lifecycle.cleanup();

        expect(fake.calls.map(call => call.args)).toEqual([
            buildPostgresRemoveArgs(lifecycleSpec.containerName),
            buildPostgresRunArgs(lifecycleSpec),
            ['port', lifecycleSpec.containerName, '5432/tcp'],
            buildPostgresRemoveArgs(lifecycleSpec.containerName),
        ]);
    });

    it('executes zero Docker commands when a URL is supplied', async () => {
        const fake = fakeDockerRunner();
        const suppliedUrl = 'postgres://supplied.example/db';
        const lifecycle = createPostgresTestContainerLifecycle({
            ...lifecycleSpec,
            suppliedUrl,
            commandRunner: fake.runner,
        });
        const closed: boolean[] = [];

        await expect(initializePostgresTestContainer({
            lifecycle,
            suppliedUrl,
            waitForDatabase: async url => expect(url).toBe(suppliedUrl),
            connectClients: async url => expect(url).toBe(suppliedUrl),
            setupDatabase: async () => undefined,
            closeClients: async () => { closed.push(true); },
        })).resolves.toBe(suppliedUrl);
        lifecycle.cleanup();

        expect(fake.calls).toEqual([]);
        expect(closed).toEqual([]);
    });

    for (const failure of ['run', 'port', 'readiness', 'connect', 'setup'] as const) {
        it(`reaps after a ${failure} failure`, async () => {
            const fake = fakeDockerRunner({
                failAction: failure === 'run' || failure === 'port' ? failure : undefined,
            });
            const lifecycle = createPostgresTestContainerLifecycle({
                ...lifecycleSpec,
                commandRunner: fake.runner,
            });
            let connected = false;
            let closed = false;

            await expect(initializePostgresTestContainer({
                lifecycle,
                waitForDatabase: async () => {
                    if (failure === 'readiness') throw new Error('FAKE_READINESS_FAILURE');
                },
                connectClients: async () => {
                    connected = true;
                    if (failure === 'connect') throw new Error('FAKE_CONNECT_FAILURE');
                },
                setupDatabase: async () => {
                    if (failure === 'setup') throw new Error('FAKE_SETUP_FAILURE');
                },
                closeClients: async () => { closed = true; },
            })).rejects.toThrow(`FAKE_${failure.toUpperCase()}_FAILURE`);

            expect(closed).toBe(true);
            expect(connected).toBe(failure === 'connect' || failure === 'setup');
            const removals = fake.calls.filter(call => call.args[0] === 'rm');
            expect(removals).toHaveLength(2);
            expect(removals.map(call => call.args)).toEqual([
                buildPostgresRemoveArgs(lifecycleSpec.containerName),
                buildPostgresRemoveArgs(lifecycleSpec.containerName),
            ]);
        });
    }

    it('retries removal after a transient command failure', () => {
        const calls: FakeDockerCall[] = [];
        let removalAttempts = 0;
        const runner = (command: string, args: string[]): string => {
            calls.push({ command, args: [...args] });
            if (args[0] === 'rm') {
                removalAttempts += 1;
                if (removalAttempts === 2) throw new Error('FAKE_TRANSIENT_REMOVE_FAILURE');
            }
            if (args[0] === 'run') return 'fake-container-id\n';
            if (args[0] === 'port') return '127.0.0.1:54321\n';
            return '';
        };
        const lifecycle = createPostgresTestContainerLifecycle({
            ...lifecycleSpec,
            commandRunner: runner,
        });

        lifecycle.start();
        lifecycle.cleanup();
        lifecycle.cleanup();

        const removals = calls.filter(call => call.args[0] === 'rm');
        expect(removals).toHaveLength(3);
        expect(removals.map(call => call.args)).toEqual([
            buildPostgresRemoveArgs(lifecycleSpec.containerName),
            buildPostgresRemoveArgs(lifecycleSpec.containerName),
            buildPostgresRemoveArgs(lifecycleSpec.containerName),
        ]);
    });
});
