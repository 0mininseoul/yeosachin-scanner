# Codex 앱 새 세션 시작

Codex 앱에서 `/Users/youngminpark/Desktop/개발/yeosachin_scanner`를 열고 최신 main을 기반으로 새 워크트리를 만든다. 아래 요청문을 새 상위 세션에 전달한다. Orca 실행은 필요하지 않다.

## 전달할 요청문

이 저장소의 미완료 작업을 종합적으로 이어서 진행해줘. 이 상위 세션이 전체 orchestration과 통합 검토를 맡고, 작업별로 Codex 서브 에이전트를 사용해줘.

먼저 다음 문서를 읽어줘.

1. `docs/operations/2026-10-03-consolidated-checkout.ko.md`
2. `/Users/youngminpark/.backups/yeosachin_scanner/worktree-cleanup/20261003-consolidated/`의 `verification-final.json`, `inventory-before.json`, `bundle-manifest.json`

핵심 맥락:

- 10월 3일 로컬 main 외 6개 워크트리를 원본 보존 후 해제했다. Git bundle과 미커밋/비추적/ignored 파일은 위 로컬 보존 폴더에 있고, 보호 migration·root `.playwright-mcp/`·`.env.local`은 보존했다.
- 정리 당시 코드 기준 main은 `4147318472cf3d9101e7ea8a87cf31b943124bed`이며 원격과 일치했다. 시작 시 최신 원격을 다시 확인해줘.
- 9월 16일에는 VERIFIED_OK와 운영 활성화까지 완료됐고 실제 계정 분석은 사용자에게 맡겼다. 10월 현재 운영 상태와 그 뒤 사용자 테스트 결과는 새로 확인해야 한다.
- 관리자 콘솔과 코드/DB 경량화는 완료됐다. 22-table 목표와 오래된 모든 체크박스를 백로그로 되살리지 마.
- 새 작업 환경은 **Codex 앱**이다. Orca task/worker/terminal이나 과거 특정 모델 설정에 의존하지 마.

인계 문서의 W00~W08을 상태판에 등록해 누락 없이 관리해줘.

1. W00 보존 작업/미반영 코드 분류.
2. W01 삭제된 canonical 경로를 root main으로 해석하도록 owner CLI·기존 검사·AGENTS·운영 문서 정비.
3. W02 현행 운영 증거 갱신.
4. W03 실제 사용자 경로/운영자 콘솔 확인과 확인된 오류만 최소 수정.
5. W04 Vertex 실제 품질 gate·비용 승격 판단.
6. W05 migration local-only/remote-only 6개씩의 정확한 원본과 동등성 검증.
7. W06 provenance 해결 후 조건부 DB 후보 평가.
8. W07 현재 사용량에 따른 용량 확장 후속 필요성 판단.
9. W08 각 변경의 독립 리뷰·통합 검증.

독립적인 읽기 전용 조사는 병렬로 진행하고, 공유 파일 편집권과 선행 의존성을 지켜줘. 각 worker는 바꾼 파일, 실행한 검사, 남은 blocker를 보고하고 구현자와 다른 agent가 검토하게 해줘. 실제 수정이 필요 없는 작업도 근거와 처리 결과를 남겨줘.

새 변경은 **반드시 PR 생성 → 관련 검사와 리뷰 → main 병합**으로 반영해줘. 직접 main push하지 마. main/origin/main 동기화로 마감하고, 과거 브랜치·stash를 통째로 자동 적용하지 마.

실제 계정 분석은 사용자 실행 경계를 유지하고, 토큰·쿠키·DB 비밀번호·사용자 UUID·원시 행을 출력/기록하지 마. 운영 활성화를 다시 수행하거나 6대6 이력 불일치를 임의 history repair/include-all로 덮지 마. 실행 가능한 작업은 끝까지 수행하고, 사용자 결과/실측 증거가 필요한 작업은 정확한 blocker와 재개 조건을 남겨줘.

한국어로 진행해줘. 승인용 영어 문서를 만들면 모든 요구사항·결정·미결 사항·수용 기준을 보존한 `.ko` 사본을 함께 만들어줘.
