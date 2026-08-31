# 자동 분석 용량 안정화 승인 요약

기준 커밋: `9645cde2db31c067d639fde953fba41ffc1623da`

이번 작업의 출시 경계는 이미 승인된 값으로 고정한다.

- 사전 점검 400건 burst를 유실·중복 terminal effect·소유권 오염 없이 durable하게 접수한다.
- 사전 점검은 별도 queue/service에서 처음 active concurrency 32로 canary하고, synthetic 검증 후에만 64로 확장한다.
- 유료 full analysis는 최소 200건을 durable하게 접수하되 provider 실행은 전역 DB budget으로 제한한다.
- 유료 분석 실행은 처음 8개 active로 canary하며, 측정된 canary/release gate 뒤에만 16 이상을 허용한다.
- preflight와 paid analysis는 Cloud Tasks queue와 Cloud Run worker service를 각각 분리해 서로 굶기지 않는다.
- 분석 엔진은 하나로 유지하고 workload role/gate만 추가한다.
- Gemini 기존 DB-global 8 lease를 유지하며, Apify도 fenced DB-global admission/rate budget으로 감싼다.
- preflight 새 작업의 credential pool은 정확히 `primary,quinary,senary`이고 tenth는 사용하지 않는다.
- full followers/following은 secondary credential을 유지하고 별도 provider budget으로 제한한다.

출시 핵심은 role-aware task contract, fail-closed worker gate, 분리된 queue/service
설정과 IAM 검증, provider admission migration/RPC, 중복 delivery·만료 lease 복구
idempotency, deterministic fake provider load harness, PGlite/EXPLAIN 근거와
영문·국문 rollout/rollback 문서다. Supabase legacy table 축소 및 과거 RPC 정리는
이번 작업을 막지 않는 후속 cleanup으로 분리한다.

테스트에서는 외부 네트워크와 유료 provider를 호출하지 않는다. fake-provider gate,
preflight 32→64, paid 8→16+ 순서와 zero-loss/zero-duplicate-terminal/
bounded-provider-concurrency/eventual-drain 기준을 모두 통과해야 production gate를
열 수 있다.
