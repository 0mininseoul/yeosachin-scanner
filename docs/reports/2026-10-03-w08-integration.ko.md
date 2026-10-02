# 2026-10-03 W08 독립 리뷰 및 통합 검증

상위 Codex 세션이 편집권·선행 관계·PR 반영을 조정했다. 첫 코드 PR은 [#596](https://github.com/0mininseoul/yeosachin-scanner/pull/596), 병합 commit은 `735fedebb9bc773508179622db8135ce515ecdd4`다. 직접 main push는 하지 않았다.

## 구현과 독립 리뷰

| 대상 | 작성/구현 | 독립 검토 | 결과 |
| --- | --- | --- | --- |
| W00 보존 분류 / W04 품질 gate | `w00_w04_evidence` | `w05_w06_provenance` | blocker 없음. receipt 관측 시간 표기 1건 정정 |
| W01 owner resolver·기존 검사 | `w01_owner_root` | `w00_w04_evidence` | 최초 리뷰에서 Vercel feature 연결 선택 문제 발견. root-only metadata와 해석용 cwd 수정 후 전체 diff 재리뷰 PASS |
| AGENTS·운영 문서·상태판 | 상위 세션 | `w00_w04_evidence` | root 운영 연결 계약, 한국어·PR 규칙, 실제 proxy와 접근 경계 일치 확인. 최종 상태판·통합 기록의 W05/W06/W07 판정 재리뷰도 PASS |
| W02 native runtime 및 web receipt | `w01_owner_root` / 상위 세션 | `w00_w04_evidence` | 이미지 annotation의 hash 계약 확인, source/archive 검증 범위 및 native build annotation 차이 구분 후 PASS |
| W03 사용자 경로 / W07 용량 조사 | `w00_w04_evidence` | `w05_w06_provenance`, 최신 집계는 `supabase_config_probe` | 실제 사용자 미실행, 관리자 인증 경계와 initial/expanded 구분 확인. pending 3건 생성일 단정을 oldest로 좁힌 뒤 최종 수치 리뷰 PASS |
| W05 원본·동등성 / W06 DB 후보 | `w05_w06_provenance` | `w01_owner_root` 예비 검토, `supabase_config_probe` 최종 검토 | 최종 PASS. 현행 효과와 역사적 패치 순서·현재 단독 재적용의 차이, 격리 dry-run과 실제 source 이력의 차이, private 원본 공개 경계 확인 |

## 검사 근거

- W01 최종 코드: owner-production 35개, owner-auth 15개 PASS. `npx tsc --noEmit --pretty false`, `git diff --check` PASS.
- 실제 Codex linked worktree에서 resolver가 Git common dir 부모 root main을 반환함을 boolean 결과만으로 확인했다.
- W03/W07: entry-policy 40개, presentation-policy 18개, console-model 4개, order-audit API 11개, operator-console-interaction 4개, capacity-extension-load-harness 5개, 합계 82개 PASS.
- W04: cost-gate·cost-policy·stage-policy 관련 4파일 35개 PASS. 별도 deterministic gate 실행은 실제 품질 증거가 없어 의도대로 exit 1 / `VERTEX_AI_HIGH_RISK_RECALL_EVIDENCE_UNVERIFIED`다. 이를 품질 PASS로 바꾸지 않았다.
- W05: 원본 SQL의 body·ACL·constraint 비교, 역사적 finalizer 패치 재현, private 원본 symlink를 이용한 source-set 392/392 exact parity 및 실제 `db push --dry-run --skip-vault` exit 0 / pending 0. 실제 저장소 migration source와 원격 history는 변경하지 않았다.
- 최종 문서의 상대 링크·JSON 파싱·UUID/JWT 형태 값 부재와 `git diff --check`를 확인했다.
- PR #596 최종 head `be3a4be857a0626828476fb56a7f210ca709fd55`: GitHub typecheck 및 Vercel preview PASS, 독립 리뷰 PASS 후 squash 병합했다.
- root main은 #596 병합 뒤 `origin/main`으로 fast-forward했다. feature 작업은 동일 Codex worktree의 새 `codex/continuation-evidence-20261003` 브랜치에서 이어갔다. 조사 보고서의 비추적 파일을 보존했다.

## 운영 및 보존 경계

Vercel CLI 인증은 처음 `Not authorized`였고 connector의 팀도 root 연결과 달랐다. 다른 팀을 운영 근거로 쓰지 않았다. 사용자가 직접 CLI 로그인을 갱신한 뒤 root 연결의 native production 프로젝트·source·READY와 Supabase URL 일치를 검증했다. 인증정보를 출력하거나 보고서에 저장하지 않았다.

Supabase 일반 DB 조회는 root `.env.local` 자동 파싱과 CLI의 DB 연결 사전 처리 때문에 처음 중단됐다. owner 인증의 `projects api-keys` 경로와 DB query 경로가 다름을 별도 explorer가 공식 버전 소스로 확인했다. 검증한 root의 비밀 없는 project-ref/pooler 연결 메타데이터만 소유자 전용 임시 디렉터리에서 사용했다. 기본 Keychain 인증은 프로젝트 권한 403이었으므로, 사용자가 안내한 root `.env.local`의 `SUPABASE_ACCESS_TOKEN` 한 개를 비실행 parser로 읽어 CLI 자식 프로세스 환경에만 전달했다. 토큰을 argv·파일·로그에 기록하거나 Keychain을 변경하지 않았다. 같은 root 프로젝트의 SELECT가 성공한 뒤 history/catalog/집계를 조회했다. 이 경로는 W01의 pinned owner 인증 계약을 변경하지 않는다.

root `.env.local`의 device/inode/size/mtime는 10월 3일 보존 inventory와 일치했다. 보호 migration SHA-256도 원본과 같으며 `.playwright-mcp/`와 보존 checkout 6개가 유지됐다. 보존 manifest의 archive refs 24개가 현재 ref와 모두 일치했다. 기존 non-main branch 9개의 tip도 그대로이며, 기존 stash commit 2개가 stash 목록에 남아 있다. 원본 SQL을 바꾸지 않았다.

운영 재활성화, 기존 epoch apply, 유료 provider·실제 분석·결제, migration history repair/include-all, DDL·행 변경은 실행하지 않았다. 사용자 실제 분석/운영자 실조회, Vertex 실측 label, 정확한 migration 원본의 source 정렬 경계 및 조건부 용량 확대의 남은 증거는 [통합 상태판](../operations/2026-10-03-continuation-status.ko.md)과 각 조사 보고서에 별도로 기록한다.
