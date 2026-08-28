# 프로덕션 preflight·결제 복구 핫픽스 핵심 설계

**상태:** 2026-08-28 전체 승인

## 무엇이 잘못됐나

이번 실패는 Apify가 단순히 느렸던 문제가 아닙니다.

1. 익명으로 끝낸 preflight를 카카오 로그인 계정으로 넘길 때, DB 함수가
   기존의 오래된 preflight를 정리할 권한이 없어 `409`로 실패했습니다.
2. 로그인 상태에서 새 preflight를 만들 때 대상 계정 식별 해시가 저장되지
   않아 B-lite 경로가 같은 오류를 반복했고, 결국 90초 timeout까지 갔습니다.
3. 주문을 만든 뒤 브라우저 JavaScript가 Groble 외부 URL로 직접 이동했기
   때문에 서버에서는 URL 발급까지만 확인할 수 있었고 실제 이동 경계는
   보장하지 못했습니다. 여기에 관리자 테스트용 대기 주문이 새 Standard
   주문을 막았습니다.

## 어떻게 고치나

- 로그인 완료 시 익명 preflight와 기존 로그인 preflight를 DB 트랜잭션
  하나에서 잠그고 정리·인계합니다. 사용자 전체 행을 수정할 수 있는 권한은
  열지 않고, 이 인계 동작만 수행하는 비공개 함수를 둡니다.
- 로그인 상태 preflight도 생성 시점에 대상 해시를 반드시 저장합니다.
  과거 데이터처럼 해시가 없는 건 B-lite 오류를 반복하지 않고 곧바로 일반
  수집 경로로 보냅니다.
- 결제 생성 API는 Groble URL 대신 우리 서비스 내부의 `nextUrl`만 줍니다.
  브라우저가 그 주소로 이동하면 서버가 로그인·주문·전화번호·금액·유효시간을
  다시 확인하고 `303`으로 Groble에 넘깁니다.
- 결제창 재진입은 주문 생성 후 24시간까지만 허용합니다.
  `SUPERSEDED_LINEAGE`와 24시간이 지난 주문에는 “결제 계속하기”를 보여주지
  않습니다.
- 현재 결제를 막는 `0_min._.00` 관리자 Standard 테스트 주문만 결제 증거가
  전혀 없다는 엄격한 조건을 만족할 때, universal migration과 분리된 명시적
  프로덕션 operation으로 정리합니다. 관리자 계정과 preflight는 보존합니다.

  operation은 이미 읽은 운영 주문의 id·`groble_seller_reference`·`created_at`을
  묶은 비가역 SHA-256 지문으로 대상을 고정합니다. 입력은
  `earlybird-admin-cleanup:v1|` + `id::text` + `|` + seller reference + `|` +
  UTC 기준 `YYYY-MM-DD"T"HH24:MI:SS.US"Z"` 형식의 생성 시각을 UTF-8로
  변환한 값이며, 비교값은 소문자 hex입니다. 세 원천 필드는 모두 NOT NULL이어야
  하고, 지문 조건은 최초 후보 해석·잠금 후 MATERIALIZED 후보·최종 증거 재확인·
  DELETE WHERE 네 경계에 반복해서 적용합니다. 고정된 operation advisory lock을
  먼저 잡고, 후보 행에서 bounded 형식의 Groble 상품을 동적으로 확인한 뒤 상품
  advisory → raw user advisory → `public.users` 행 → 주문 행 순서로 잠급니다.
  모든 결제·상품·확정된 seller reference·fulfillment·result·webhook 조건을
  다시 확인하고 정확히 한 건을 삭제하며, 발급됐지만 아직 확인되지 않은
  `groble_seller_reference`는 결제 증거로 보지 않습니다. 같은 operation의 즉시
  재실행이나 이후 새로 만든 겉보기 일치 주문은 지문이 다르므로 삭제하지 않고
  실패합니다. 명시적 BEGIN/COMMIT과 SET LOCAL을 사용하고, 커밋 뒤 민감하지 않은
  operation/count/timestamp 영수증만 출력합니다. 조건이 하나라도 다르면 아무것도
  바꾸지 않고 실패합니다.

  release owner만 다음처럼 `ON_ERROR_STOP`을 켜고 별도 실행합니다:
  `psql --set=ON_ERROR_STOP=1 --file
  supabase/operations/20260828_cleanup_confirmed_administrator_test_order.sql
  "$DATABASE_URL"`

## 외부 사용자 결제 대기 데이터는 어떻게 하나

외부 사용자 `payment_pending` 87건은 이번 핫픽스에서 상태를 바꾸거나
삭제하지 않습니다. 오래됐다는 사실만으로 실제 미결제를 확정할 수 없고,
현재 운영 규칙도 Groble 무매출 확인 없이 변경하지 못하게 되어 있기
때문입니다. 24시간은 “결제창을 다시 열 수 있는 기간”일 뿐, 결제 원장의
상태를 자동으로 바꾸는 시간이 아닙니다.

이 데이터는 나중에 기존 Groble 대시보드 무매출 검증 절차를 사용하거나,
결제사 조회 연동을 추가한 뒤 별도 정리합니다.

## 사용자가 다시 테스트할 때의 정상 화면 순서

1. 익명 preflight 완료
2. Standard 선택
3. 카카오 로그인 팝업
4. 로그인 전 preflight와 플랜이 그대로 복원된 분석 화면
5. 짧은 내부 결제 이동 화면
6. Groble 결제 화면
7. 결제 완료 후 결제 확인 화면
8. 자동 분석 진행 화면
9. 결과 페이지

로그인 후 처음 화면으로 돌아가 대상 계정을 다시 입력하는 동작은 더 이상
정상 흐름이 아닙니다.

## 출시 전 통과 조건

- 로그인 인계, 대상 해시, B-lite fallback, 303 결제 이동, 24시간 복구,
  superseded 차단 테스트 통과
- schema migration은 한 건만 적용하고 관리자 정리는 별도 operation으로
  dry-run·명시 실행하며, 빈 DB migration replay와 operation race를 확인
- Supabase migration dry-run과 원격 migration history 확인
- lint와 production build 통과
- 기존 `yeosachin-scanner` Vercel 프로젝트에 배포
- 관리자 계정으로 전체 흐름 canary 통과
- 외부 사용자 결제 대기 데이터가 한 건도 변경되지 않았음을 확인

이 조건을 모두 확인하기 전에는 프로덕션 실결제를 다시 시도해도 된다고
보고하지 않습니다.
