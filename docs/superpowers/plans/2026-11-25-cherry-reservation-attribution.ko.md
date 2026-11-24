# 체리 사전 예약 유입 경로 및 완료 상태 구현 계획

**목표** · 채널별 예약을 운영 명단에서 확인하고 새로고침 후에도 완료 상태를 복원한다.

**구조** · 랜딩에서 허용된 채널 값을 분류해 접수 시 저장한다. 브라우저의 완료 표시는 접수 확인 뒤에 저장하며 개인정보는 포함하지 않는다.

**기술** · Next.js Route Handler, 정적 랜딩 JavaScript, Supabase, Vitest

- [x] `tests/cherry/landing-variant.test.ts`에서 짝남 배포 링크 렌더링, 채널 저장과 조회, migration 이전의 호환 동작을 검증한다.
- [x] `tests/cherry/landing-reservation.test.ts`에서 랜딩의 제출 본문, 접수 성공과 실패, 다른 컨셉에서 새로고침한 뒤의 완료 화면을 검증한다.
- [x] `app/cherry/route.ts`와 `lib/services/cherry/landing-variant.ts`에서 배포용 `concept=crush`를 렌더링하고 광고 A/B 변형을 구분한다. 분석 이벤트에는 광고 변형만 전달한다.
- [x] `public/cherry/landing.js`에서 채널과 완료 표시를 처리한다. 완료 이벤트는 최초 접수 확인에서만 발행한다.
- [x] `supabase/migrations/`, `app/api/namchin/reservations/route.ts`, `app/api/admin/namchin/reservations/route.ts`, `app/admin/console/namchin-waitlist-console.tsx`에서 채널 추가, 저장, 조회, 표시를 연결한다.
- [x] 체리 관련 테스트, 타입 검사, 브라우저 확인과 독립 리뷰를 마친다.
- [ ] 운영 DB에 해당 migration을 적용하고 앱을 배포한 뒤 공개 링크를 확인한다.
