# Docker anonymous volume leak from PostgreSQL integration tests

Date: 2026-09-07 (Asia/Seoul)

## Executive finding

The confirmed leak of orphaned anonymous Docker volumes on the development machine is caused by a single test harness: `lib/services/analysis/beta-apify-credit-postgres-concurrency.test.ts`. It is the only file in the repository that starts a container (`grep -rln 'postgres:16' --include='*.ts'` returns exactly one match; every other `*postgres*` test uses PGlite or a caller-supplied URL).

`postgres:16-alpine` declares `VOLUME /var/lib/postgresql/data`. Docker allocates a fresh anonymous volume for any declared `VOLUME` path left without an explicit mount, so each run of the suite stranded one initdb cluster on the host. The audit arithmetic matches this mechanism exactly: 49.47GB across 613 volumes is approximately 82MB per volume, the size of a fresh PostgreSQL 16 cluster.

Confidence: high. The container-start path, the image's `VOLUME` declaration, the per-volume size, and the sole-caller grep all agree.

## Why teardown did not save it

The harness used `docker run -d --rm ...` and tore down with `docker rm -f <name>`. Both halves fail to reap the anonymous volume in the cases that mattered:

- `--rm` removes a container's anonymous volumes only when the container **exits on its own**. It does not cover a force removal.
- `docker rm -f` without `-v` **never** removes the anonymous volume, and it races the daemon's auto-remove routine for an `AutoRemove=true` container.
- Neither hook runs at all when the Vitest worker is killed by a suite timeout or a signal, or when `beforeAll` throws before reaching its teardown pair.

So every interrupted, timed-out, or force-removed run orphaned roughly 82MB, permanently.

## Fix

The fix removes the failure mode at the source rather than relying on teardown running. `lib/services/analysis/postgres-test-container.ts` now builds the run arguments with an explicit tmpfs over the declared path:

```
--mount type=tmpfs,destination=/var/lib/postgresql/data,tmpfs-size=536870912,tmpfs-mode=0700
```

Docker only auto-creates an anonymous volume for a `VOLUME` path that has **no** explicit mount, so with the tmpfs present no persistent storage is ever allocated — however the test process dies. The cluster is throwaway per suite, so holding it in RAM preserves test semantics exactly while removing the disk write entirely. tmpfs consumes only the pages actually written, so the 512MB figure is a ceiling, not an allocation; Docker's 64MB default is too small for an initdb cluster plus its 16MB WAL segments.

Defence in depth, all in the same change:

- Teardown now uses `docker rm -f -v`, so a caller that reintroduces a volume cannot silently reintroduce the leak.
- The removal flag is set **before** `docker run` is issued, so a container that is created and then fails mid-start is still torn down.
- The reaper is idempotent and additionally registered on `process.once('exit')`, covering the partial-failure paths where `afterAll` never runs.

External `BETA_APIFY_POSTGRES_TEST_URL` behavior is unchanged: when a URL is supplied no container is started, no exit hook is registered, and the reaper is a no-op.

## Regression guard

`lib/services/analysis/postgres-test-container.test.ts` asserts the tmpfs destination, size floor, the absence of any `-v`/`--volume` bind, and that teardown passes `-v`. These assertions run **without a Docker daemon** on purpose, so the invariant stays enforced in environments that skip the Docker-backed suite entirely — which is the normal case in CI and was the case on this machine during the fix.

## Verification status and residual risk

Verified: TypeScript (`tsc --noEmit`, clean), ESLint (clean), `git diff --check` (clean), and the 6 new regression assertions pass. The Docker-backed suite reports 23 skipped because the daemon was down.

**Not verified live.** The Docker daemon was not running and the task boundary forbade starting Docker Desktop, so the tmpfs-backed container was never actually booted. The residual risk is bounded: if the tmpfs mount were wrong, the container would fail to start and the suite would fail loudly in `beforeAll` — it cannot regress silently, and no volume would leak in that case either. The mount shape matches what the official entrypoint already expects (it runs as root, chowns `PGDATA` to `postgres`, then `chmod 00700` before dropping privileges via `gosu`), which is the same shape a volume mount presents to it.

Recommended next step: run the suite once with Docker up and confirm the container boots and that `docker volume ls -qf dangling=true | wc -l` is unchanged across the run.

## Pending operator decision: the existing orphans

This change stops **new** leakage. It does not reclaim the storage already stranded. The 671 pre-existing orphaned anonymous volumes were deliberately left in place — no Docker object was deleted or pruned during this work, per the task boundary.

Reclaiming them is an operator decision because a blanket prune would also remove unrelated dangling volumes belonging to other projects on this machine. A targeted review of `docker volume ls -qf dangling=true` before any removal is advised.
