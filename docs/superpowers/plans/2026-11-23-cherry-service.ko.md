# 체리 서비스 구현 계획

**목표:** 확정된 [체리 계획](../specs/2026-11-23-cherry-launch-plan.ko.md)을 판매를 끈 상태로 운영에 올리고, 설정만 바꾸면 12/1에 열 수 있게 한다.

**구조:** 화면과 API는 기존 Next.js 앱(`/cherry/*`, `/api/cherry/*`), 수집·발송·청구는 전용 Cloud Run `cherry-worker`가 처리한다. 작업 대기열은 `cherry_*` 표이며 1분 스케줄러가 깨운다. 원자성이 필요한 전이는 DB 함수로, 비교 규칙은 순수 함수로 둔다.

## 공통 제약

- 판매·감시·발송·자동 환불·AI는 `cherry_settings`에서 각각 켜고, 모두 꺼진 상태로 병합한다(AI만 기본 켬).
- 정가 9,900원. 사전 예약자는 첫 결제일부터 1년간 4,900원. 가격은 `cherry_offers`에서 읽는다.
- 팔로워·팔로잉 합계 1,500명 이하, 사용자당 1개, 인증 배지 제외. 공개 계정, 또는 이용자가 팔로우 중인 비공개 계정(이용자 인스타그램 로그인 연결, 11/24 결정).
- 이용자 인스타그램 비밀번호·세션은 Supabase Vault에만 저장하고 로그·응답·운영 콘솔에 남기지 않는다. 이용자 세션으로는 프로필·팔로워·팔로잉 읽기만 한다.
- `secondary`에서 판독기 몫 $15를 남기고 동시 실행 3개, 1인 월 6,000건. Vertex는 공유 원장에서 체리 하루 $3.
- 같은 변화의 중복 알림·중복 청구 0건. 결과가 모호한 유료 실행·발송·청구는 자동으로 반복하지 않는다.
- `/cherry` 첫 화면과 랜딩 문구는 바꾸지 않는다. 판독기 분석 DAG와 파이프라인 맵은 변경하지 않는다.

## 검증이 필요한 입력

1. 목록이 최신순이 아니거나 앞쪽에 예전 계정이 섞임 → 알리지 않고 기준 목록에 보충한다.
2. 첫 목록에서 빠진 계정이 나중에 나타남 → 새 맞팔로 알리지 않는다.
3. 작업이 실행 도중 끊기거나 두 번 깨어남 → 같은 Apify 실행을 이어받고 알림은 1건이다.
4. 결제 웹훅 재전달, 금액 불일치, 이미 취소된 주문의 늦은 입금 → 중복 활성화가 없고 운영자가 확인한다.
5. 비공개 전환을 일시 오류로 오인 → 한 번 더 확인한 뒤에만 중지·환불한다. 이용자 로그인이 연결돼 있고 팔로우 중이면 멈추지 않고 그 세션으로 계속 확인한다.
6. 이용자 세션 만료·로그인 확인 요구·팔로워에서 제외됨 → 새 맞팔로 오인하지 않고 알림을 멈춘 뒤 재연결을 요청한다. 7일 안에 복구되지 않으면 중지·환불한다.

## 작업

| 작업 | 파일 | 완료 확인 |
| --- | --- | --- |
| 1. 스키마와 DB 함수 | `supabase/migrations/20261123120000_create_cherry_service.sql` | `tests/cherry/service-pglite.test.ts`: 작업 점유, 결과 반영, 결제·환불 전이, 예산·동시 실행 거절 |
| 2. 비교·가격·기간 규칙 | `lib/services/cherry/{detection,pricing,schedule}.ts` | `tests/cherry/rules.test.ts`: 위 1·2번과 가격 잠금 |
| 3. Apify 수집과 실행 원장 | `lib/services/cherry/{instagram,provider-runs}.ts` | `tests/cherry/collection.test.ts`: 이어받기, 안정 ID, 한도 |
| 4. 확인 작업·리포트·AI·이미지 | `lib/services/cherry/{checks,reports,ai-summary,images}.ts` | `tests/cherry/checks.test.ts` |
| 5. 알림과 결제 | `lib/services/cherry/{notifications,solapi,toss,billing}.ts`, 그로블 웹훅 분기 | `tests/cherry/{notifications,payments}.test.ts` |
| 6. 워커와 공개 API | `app/api/cherry/**`, `lib/services/cherry/worker*.ts` | 인증 실패·중복 호출 검사 |
| 7. 화면 | `app/cherry/**` | 브라우저로 등록→결제 직전, 홈, 리포트 확인 |
| 8. 운영 콘솔·탈퇴 연동 | `app/admin/console/cherry-*`, `app/api/admin/cherry/**` | 운영자 권한 확인 |
| 9. 배포 스크립트와 순서 검증 | `scripts/deploy-cherry-worker.sh`, `scripts/canary-cherry-relationship-order.ts` | 판매를 끈 배포, 목록 순서 결과 기록 |
| 10. 비공개 계정 로그인 연결 (피클 방식) | Vault 비밀 저장 migration, `lib/services/cherry/instagram-session.ts`, 이용자별 클라우드 브라우저 로그인과 화면 넘겨주기, 자체 수집기 세션 주입, `app/cherry/start` 보안 로그인 카드, 내 서비스 접근 기록 | `tests/cherry/private-session.test.ts`: Vault 밖 저장 0건, 세션 만료 재로그인, 팔로우 관계 확인, 읽기 외 요청 차단, 해제 시 로그아웃·삭제 |
