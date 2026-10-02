# 2026-10-03 통합 후속 상태판

기준: Asia/Seoul. 상위 Codex 세션이 의존성·공유 편집·PR·통합 검토를 담당한다.

- 시작 시 fetch 확인: `main = origin/main = 55483734b03f30e44d670892a4835d41fdb7e92b` (인계 PR #595).
- 작업 환경: Codex 관리 worktree `continuation-20261003`, 별도 `codex/` 브랜치. 운영 기준 디렉터리는 Git common dir의 부모인 root main이다.
- 사용자는 9월 16일 이후 실제 계정 분석/관리자 확인을 **아직 실행하지 않았다**고 답변했다. 에이전트는 실제 분석·결제·유료 provider 작업을 시작하지 않는다.
- 보존 원본·기존 refs/stash·root `.env.local`·`.playwright-mcp/`·보호 migration을 유지한다.
- 새 변경은 PR → 관련 검사와 독립 리뷰 → main 병합으로 반영한다. 운영 재활성화, history repair, include-all, 무근거 DDL은 실행하지 않는다.

| ID | 상태 | 담당·편집권 | 근거/다음 행동 |
| --- | --- | --- | --- |
| W00 보존 작업 분류 | 불필요확정 | `w00_w04_evidence`; 전용 조사 보고서 | [보존 분류](../reports/2026-10-03-w00-w04-evidence.ko.md) 완료. 자동 재적용 불필요, 원본 유지 |
| W01 owner 경로 | 병합완료 | `w01_owner_root`: resolver/기존 테스트; 상위: AGENTS/운영 문서 | [PR #596](https://github.com/0mininseoul/yeosachin-scanner/pull/596), merge `735fedeb`. root-only Supabase/Vercel 경계, 50검사·타입체크·CI·독립 리뷰 PASS |
| W02 현재 운영 | 불필요확정 | 상위 세션; 운영 조사 보고서 | [runtime](../reports/2026-10-03-w02-runtime.ko.md)·[web receipt](../reports/2026-10-03-w02-web.safe.json) 갱신·독립 리뷰 PASS. 재배포·재활성화 필요 drift 없음; 실제 계정 성공은 별도 |
| W03 사용자/관리자 경로 | 근거대기 | 상위 세션; 이후 독립 agent 검토 | [사용자 경로](../reports/2026-10-03-w03-w07-user-capacity.ko.md)·비인증 관리자 경계 및 관련 검사 PASS. 실제 분석 성공·allowlisted 운영자 조회는 사용자 결과 필요 |
| W04 Vertex 품질·비용 | 근거대기 | `w00_w04_evidence`; 전용 조사 보고서 | [품질 gate](../reports/2026-10-03-w00-w04-evidence.ko.md)는 실제 retained label 미검증으로 차단. 오늘 rollout도 TEST_ENTITLEMENT |
| W05 migration provenance | 근거대기 | `w05_w06_provenance`; 전용 조사 보고서 | 원본 6개와 현행 효과 대조 완료. 격리 source-set 392/392·zero-pending dry-run PASS. 실제 저장소의 6대6 차이는 유지하며, 고정 식별자를 새로 기록하지 않는 정확한 원본의 접근·source 정렬 방식이 필요. [상세](../reports/2026-10-03-w05-w06-provenance.ko.md) |
| W06 조건부 DB 후보 | 근거대기 | `w05_w06_provenance`; W05 보고서와 함께 관리 | 현재 public 150 tables/802 routines, bounded 후보 9개는 0행이나 routine/FK·reader/writer 유지. producer drain·보존·복구와 reader/writer 대체 및 최소 이득 근거 전 DROP allowlist는 빈 집합 |
| W07 용량 확장 | 불필요확정 | 상위 세션; W02/W03 근거 재사용 | [사용자·용량 경계](../reports/2026-10-03-w03-w07-user-capacity.ko.md), 현재 추가 확대 근거 없음, initial 32/8 유지. 보존행 기준 9/16 후 생성 0·비종결 요청 0; 오래된 pending 3개는 실패한 parent의 잔여 기록 |
| W08 독립 리뷰·통합 | 검증완료 | 구현자와 다른 agent + 상위 세션 | [통합 검증 기록](../reports/2026-10-03-w08-integration.ko.md)의 별도 reviewer 최종 PASS, 관련 기존 검사 167개·타입체크 및 보존 검증 PASS. 코드 PR #596 병합 완료; [evidence PR #597](https://github.com/0mininseoul/yeosachin-scanner/pull/597)의 CI·병합 기록과 최종 main 동기화는 GitHub 및 종료 보고로 확인 |

## 통합 규칙과 종료 기준

동시에 같은 파일을 편집하지 않는다. 각 담당자는 바꾼 파일·실행 검사·미검증 경계·blocker를 보고한다. source package·운영 상태는 읽기 전용으로 조사하며 민감값과 원시 행은 출력하거나 기록하지 않는다. 실제 수정이 필요 없는 작업에도 근거와 처리 결과를 남긴다.

모든 ID를 병합완료/불필요확정/근거대기로 판정하고, 근거대기에는 필요한 입력과 재개 조건을 명시한다. 마지막에 원격 main fetch, root main fast-forward, tracked diff 및 보호 파일 보존을 확인한다. 이 상태판은 진행에 맞춰 갱신한다.

## 남은 작업의 정확한 재개 조건

- **W03:** 사용자가 실제 분석 및 allowlisted 관리자 조회를 실행한 뒤 성공/실패 단계·시각·오류 코드만 공유한다. 확인된 오류가 있으면 해당 경로의 최소 수정과 별도 PR로 이어간다.
- **W04:** 실제 retained label과 baseline 비교, route mix·unknown usage·실측 비용이 갖춰져야 품질 gate와 승격을 다시 판정한다. fixture 수치만으로 TEST_ENTITLEMENT를 승격하지 않는다.
- **W05:** 원본·효과 및 격리 dry-run 검증은 끝났다. 고정 식별자가 있는 private 원본을 새로 저장·노출하거나 변조하지 않는 canonical source 관리 방식을 정한 뒤 별도 source PR을 검토한다. 현재 저장소 source와 원격 이력은 바꾸지 않았다.
- **W06:** 0행만으로 삭제하지 않는다. 살아 있는 호출·DB 의존성을 대체하고 보존/복구·producer drain과 실제 이득을 증명한 최소 allowlist가 있어야 재개한다. 현재 DROP-ready 대상은 없다.
- **W07:** 현재 추가 확장은 불필요하다. 실제 사용자 실행과 초기 실사용의 대기·지연·실패가 현재 상한 때문이라는 증거가 생기면 기존 단계적 확장 경로로 재평가한다.
