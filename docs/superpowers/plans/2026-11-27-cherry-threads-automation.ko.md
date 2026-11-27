# 체리 Threads 자동화 구현 계획

**목표** 승인한 글을 20분 단위로 서버에서 발행하고, 모바일 운영 콘솔에서 저장한 교정을 다음 초안에 반영한다.

**구성** Next.js 관리자 화면과 Vercel 워커, Supabase 저장소와 Cron, OpenAI Responses API 및 Threads API를 사용한다. Google Cloud와 로컬 Mac의 실행 환경에서 독립적으로 동작한다.

1. `20261127210000_cherry_threads_automation.sql`에 회차, 초안, 버전, 교정, 발행 상태를 추가한다. 작업 청구와 교정 저장을 SQL 트랜잭션으로 처리하고 실행 권한을 서비스 역할로 제한한다.
2. `lib/services/cherry/threads/`에서 교정 사례를 골라 Responses API에 전달하고 구조화된 결과를 저장한다. 승인한 동일 버전만 발행하며, 발행 결과가 불분명하면 운영자 확인으로 넘긴다. Meta 연결, 장기 토큰 갱신, 기존 글과 발행 후 지표 조회를 테스트한다.
3. `app/api/admin/cherry/threads/`와 `app/admin/console/cherry-threads-console.tsx`에 회차 작성, 수정 전후 문장과 이유, 검토, 20분 슬롯 승인, 모바일 조작을 연결한다.
4. `app/api/internal/cherry-threads/route.ts`에 전용 워커를 두고 Supabase Cron에서 20분마다 대기 작업이 있을 때 호출한다. 비밀 설정과 검증 순서는 설계 문서에 기록한다.
5. `npm test -- tests/cherry/threads-automation.test.ts`로 실제 SQL 교정 저장부터 다음 모델 요청과 생성 결과까지 확인한다. 발행 슬롯의 중복 호출, 승인 버전 변경, 누락된 승인 버전, 첫 답글 복구를 검증한다. 타입 검사와 작은 화면 검증을 실행한 뒤 PR로 올린다.
