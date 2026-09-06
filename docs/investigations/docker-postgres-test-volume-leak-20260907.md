# Docker anonymous volume leak from PostgreSQL integration tests

Date: 2026-09-07 (Asia/Seoul)

## Executive finding

The confirmed leak of orphaned anonymous Docker volumes on the development machine is caused by a single test harness: `lib/services/analysis/beta-apify-credit-postgres-concurrency.test.ts`. It is the only file in the repository that starts a container (`grep -rln 'postgres:16' --include='*.ts'` returns exactly one match; every other `*postgres*` test uses PGlite or a caller-supplied URL).

`postgres:16-alpine` declares `VOLUME /var/lib/postgresql/data`. Docker allocates a fresh anonymous volume for any declared `VOLUME` path left without an explicit mount, so a run that exits through an affected path could strand one initdb cluster on the host. The audit arithmetic matches this mechanism: 49.47GB across 613 volumes is approximately 82MB per volume, the size of a fresh PostgreSQL 16 cluster.

Confidence: high. The container-start path, the image's `VOLUME` declaration, the per-volume size, and the sole-caller grep all agree.

## Why teardown did not save it

The harness used `docker run -d --rm ...` and tore down with `docker rm -f <name>`. Both halves fail to reap the anonymous volume in the cases that mattered:

- `--rm` removes a container's anonymous volumes only when the container **exits on its own**. It does not cover a force removal.
- `docker rm -f` without `-v` **never** removes the anonymous volume, and it races the daemon's auto-remove routine for an `AutoRemove=true` container.
- Cleanup must not rely solely on `afterAll`: it does not provide cleanup when `beforeAll` throws before reaching its teardown pair. A `process.once('exit')` handler is only a best-effort normal-exit path; it cannot guarantee cleanup for `SIGKILL`, hard timeouts, or other abrupt worker termination.

Those interrupted, timed-out, or force-removed paths could orphan roughly 82MB per affected run; this does not mean every run leaked. The audit identified 613 matching orphaned volumes.

## Fix

The fix removes the failure mode at the source rather than relying on teardown running. `lib/services/analysis/postgres-test-container.ts` now builds the run arguments with an explicit tmpfs over the declared path:

```
--mount type=tmpfs,destination=/var/lib/postgresql/data,tmpfs-size=536870912,tmpfs-mode=0700
```

Docker only auto-creates an anonymous volume for a `VOLUME` path that has **no** explicit mount, so with the tmpfs present no persistent storage is ever allocated, regardless of how the test process terminates. The cluster is throwaway per suite, so holding it in RAM preserves test semantics exactly while removing the disk write entirely. Docker's default tmpfs maximum is 50% of host RAM; `64m` is the default `/dev/shm` size, not this data mount. The explicit 512MB ceiling gives initdb and its 16MB WAL segments room, while tmpfs consumes only the pages actually written.

Defence in depth, all in the same change:

- Teardown now uses `docker rm -f -v`, so a caller that reintroduces a volume cannot silently reintroduce the leak.
- An idempotent `rm -f -v` name fence runs before `docker run`, even though the generated name is UUID-based.
- The entire beforeAll lifecycle is inside one catch boundary. It closes any clients that connected, attempts removal, and rethrows the original readiness/setup/start failure.
- The reaper only marks the container reaped after a successful removal command. A transient removal failure remains retryable from afterAll or a later normal-process-exit cleanup attempt.
- The tmpfs mount independently prevents persistent-volume leakage. Explicit catch, afterAll, and normal-process-exit cleanup are best-effort container cleanup and cannot guarantee removal after `SIGKILL`, hard timeouts, or other abrupt termination.

External `BETA_APIFY_POSTGRES_TEST_URL` behavior is exact: when a URL is supplied, no container lifecycle is started, no exit hook is registered, and no Docker command is executed, including no `docker info` probe.

## Regression guard

`lib/services/analysis/postgres-test-container.test.ts` runs 14 daemon-free lifecycle and argument assertions with an injected fake command runner. It proves supplied URLs execute zero Docker calls, the cleanup fence precedes `run`, `run`/`port`/readiness/connect/setup failures reach `rm -f -v`, transient removal is retried, every removal call uses the full exact argument tuple, and the tmpfs covers the exact `PGDATA` path.

## Verification status and residual risk

Verified so far: TypeScript (`tsc --noEmit`, clean), focused ESLint (clean), `git diff --check` (clean), the 14 daemon-free lifecycle/argument assertions pass, and the Docker-backed suite reports 23 skipped because the daemon was down. No live Docker test was run and Docker Desktop remained stopped.

The full repository lint also completed with 0 errors and 17 existing warnings outside this change.

The full `lib/services/analysis` test set completed with 475 files passed and 1 skipped, covering 4,457 passed and 45 skipped tests; the Docker-backed PostgreSQL file was among the skipped integration files because Docker remained stopped.

**Not verified live.** The Docker daemon was not running and the task boundary forbade starting Docker Desktop, so the tmpfs-backed container was never actually booted. The residual risk is bounded: if the tmpfs mount were wrong, the container would fail to start and the suite would fail loudly in `beforeAll` — it cannot regress silently, and no volume would leak in that case either. The mount shape matches what the official entrypoint already expects (it runs as root, chowns `PGDATA` to `postgres`, then `chmod 00700` before dropping privileges via `gosu`), which is the same shape a volume mount presents to it.

Recommended next step: run the suite once with Docker up and confirm the container boots and that `docker volume ls -qf dangling=true | wc -l` is unchanged across the run.

## Pending operator decision: the existing orphans

This change stops **new** leakage. It does not reclaim the storage already stranded. The 671 pre-existing orphaned anonymous volumes were deliberately left in place — no Docker object was deleted or pruned during this work, per the task boundary.

Reclaiming them is an operator decision because a blanket prune would also remove unrelated dangling volumes belonging to other projects on this machine. A targeted review of `docker volume ls -qf dangling=true` before any removal is advised.
