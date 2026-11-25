# Dev Standard 수집본의 별도 QA 보관

등록된 대상 한 건의 암호화 수집본을 별도 승인일부터 90일 동안 같은 Dev 담당자가 격리 QA에서 재생하는 절차다. 운영자가 대상, 보존 기한, 접근 주체와 목적을 확인하고 승인 시간을 UTC로 고정한다. 원본 수집 승인 시각에서 24시간이 지나면 새 사본을 만들 수 없다. 승인한 단일 수집본에 한해 집행한다.

## 준비와 집행

1. 등록된 Dev 프로젝트에서 원본과 같은 리전의 전용 Standard 버킷 `*-dev-qa-copy`와 전용 대칭 KMS 키와 32바이트 난수만 담은 별도 Secret Manager 버전 1을 준비한다. 이 시크릿은 버킷과 같은 리전의 regional secret 또는 해당 리전 한 곳에만 복제하는 user-managed secret이어야 한다. `expireTime`을 승인 시각에서 정확히 90일 후로 설정한다. 버킷에 uniform bucket-level access, public access prevention, soft delete 비활성화, 버전 관리 비활성화, 객체 보류 없음과 승인 일수에 맞는 단일 Delete 수명 주기 규칙을 적용한다. 가입된 구성원뿐 아니라 프로젝트·폴더·조직에서 상속된 GCS 및 KMS 역할과 서비스 계정 위임 권한을 대조해 원래 Dev 접근 주체만 자료를 열 수 있는지 검증한다. 신규 QA 권한에는 승인 종료 시각의 IAM 조건을 건다. 사본 평문 접근은 객체 읽기, KMS 복호화, 90일 보조 시크릿 읽기 권한을 모두 가진 주체로 판정한다. 서버에서 보조 시크릿과 그 버전이 만료 삭제되면 보관된 암호문과 KMS 래핑 키만으로는 본문 키를 도출할 수 없다.
2. 승인된 작업 프로세스 안에서 설정을 전달한다. `DEV_STANDARD_QA_COPY_APPROVAL`에는 새 승인 식별자, `DEV_STANDARD_QA_COPY_SOURCE_APPROVAL`에는 원 수집 승인 식별자, `DEV_STANDARD_QA_COPY_APPROVED_AT`에는 밀리초까지 기재한 UTC 승인 시각, `DEV_STANDARD_QA_COPY_DAYS`에는 90을 지정한다. `DEV_STANDARD_QA_COPY_PROJECT`, `DEV_STANDARD_QA_COPY_PROJECT_NUMBER`는 등록된 `DEV_LIVE_GCP_PROJECT`, `DEV_LIVE_GCP_PROJECT_NUMBER`, `GOOGLE_CLOUD_PROJECT`와 맞춘다. 전용 버킷 이름은 `DEV_STANDARD_QA_COPY_BUCKET`, KMS CryptoKey 리소스명은 `DEV_STANDARD_QA_COPY_KMS_KEY`, 별도 만료 시크릿의 정확한 버전 1 리소스명은 `DEV_STANDARD_QA_COPY_EXPIRY_SECRET_VERSION`, 승인 대상은 `DEV_LIVE_STANDARD_TARGET`으로 전달한다. 원래 허용한 버킷 이름은 `DEV_STANDARD_QA_COPY_APPROVED_SOURCE_BUCKET`에 고정한다. 원본 슬롯·키·버킷은 내보낼 때만 기존 시크릿 주입 경로로 전달한다. 운영자 기록에는 대상값, 키, 식별자, 객체명, 토큰, 행을 남기지 않는다.
3. 정책 감사 권한을 가진 별도 ADC 주체로 `--verify-iam`을 먼저 실행한다. `DEV_STANDARD_QA_COPY_APPROVED_PRINCIPALS`에는 기존 승인 주체를 쉼표로 구분하여 전달한다. 원본 AES 키를 담은 Secret Manager의 리소스명은 `DEV_STANDARD_QA_COPY_SOURCE_KEY_SECRET`으로 전달한다. 이 검사는 프로젝트·폴더·조직의 상속과 원본 버킷 및 시크릿, 사본 버킷·키링·키·만료 시크릿 역할의 권한 목록을 비교한다. 원본에서 객체와 시크릿을 함께 읽는 승인 주체가 사본의 세 권한을 갖는지, 추가 평문 열람자가 있는지, 시크릿 서버 만료 시각과 리전이 일치하는지 확인한다. 기존 암호문 전용 접근자는 평문 접근 권한으로 집계하지 않는다. 조건이나 그룹 중첩 때문에 권한을 확정할 수 없으면 실패한다. 원 승인 주체의 그룹 변경·서비스 계정 위임 가능자도 대조해 별도 운영 기록에는 통과 여부만 남긴다. 권한 관리자는 집행 직전까지 결과를 확인한 후 복사 작업을 실행한다. 실행 프로세스와 감사 프로세스는 각자 필요한 ADC 권한을 사용한다.
4. 등록된 Dev의 격리 프로세스에서 아래 명령으로 내보낸다. CLI는 승인된 16종의 정규화 조각을 원본의 봉인 및 논리적 입력 목록과 비교한다. KMS로 감싼 새 난수와 90일 만료 시크릿을 HKDF-SHA256으로 결합해 독립 AES 키를 만들고 스트리밍 재암호화한다. 객체명에 쓰는 입력 해시도 별도 파생키로 감싼다. 중단된 복사에는 동일 승인·대상·기한·버킷·키를 사용해 원본 만료 전에 재개할 수 있다. 완료 전 사본을 열면 실패한다. 사본 본문이나 DB 행을 로컬 파일로 내보내는 단계는 없다.

```sh
node --conditions=react-server --import tsx scripts/dev-standard-private-qa-copy.ts --verify-iam
node --conditions=react-server --import tsx scripts/dev-standard-private-qa-copy.ts --export
node --conditions=react-server --import tsx scripts/dev-standard-private-qa-copy.ts --verify
```

`--verify`가 통과하면 봉인과 구성 조각의 무결성, 수집 및 미디어 입력 목록을 검증한 것이다. 별도 프로세스의 `withCloudStandardQaFixture`는 KMS·사본 버킷·만료 시크릿 권한으로 읽기 전용 입력을 제공한다. 라이브 웹·워커·DB 재생 승인은 기존 24시간 규칙을 따른다. 실제 수집물을 다루는 도구에 디버그·요청 본문 로깅, 메모리 덤프, 작업 파일, 실패 원문 저장을 활성화하지 않는다.

## 재생으로 검증한 범위

네트워크를 차단한 테스트가 합성 원본 DB를 종료하고, 독립된 PGlite의 새 사용자·승인·영수증과 별도 보관본으로 Standard를 재생한다. KMS와 객체 저장소는 메모리 대역을 쓴다. 보관된 타깃 프로필의 원 입력 해시와 작업 키를 로컬 영수증에 맞춘 후 실제 사전 점검·B-lite·접수·워커·DB 발행·소유자 페이지·WebP 열람, 다른 사용자 및 로그아웃 사용자의 거절을 확인한다. 재생에서 Apify와 원본 이미지 요청은 0회다.

실측 원본에는 후보 프로필 238명의 8개 배치와 봉인 조각 2,381개가 있다. 결과 이미지 조각은 225개, AI 이미지 조각은 1,725개다. 사본은 승인된 범위 내에서 실제 저장된 선택 입력을 보존한다. 고정 Vertex 대역이 원본에서 선택되지 않은 특징을 요구하지 않으면 원 시나리오를 재생할 수 있다. 새 Vertex 응답이 다른 특징이나 사진을 요청하면 보관본 조회가 실패할 수 있다. 이 경우 추가 판독의 전 모집단 재현 여부를 별도로 기록한다. 실제 238명 전체의 종단 재생에는 원 요청이나 사용자 정보를 복원하지 않고 봉인된 영수증과 배치별 증명을 새 격리 DB의 참조 이력에 넣는 로컬 도구가 필요하다. 이 검사의 합성 대상은 후보 1명이며 실제 238명의 종단 결과는 별도 실측 대상이다.

## 만료와 삭제 확인

새 승인 만료 시각부터 앱의 모든 보관본 읽기가 실패한다. GCS 수명 주기 삭제는 객체 생성 시각을 기준으로 비동기 실행되므로 접근 종료와 공급자 삭제를 각각 확인한다.

- 만료 후 원래 QA 열람 주체로 `--verify-revoked`를 실행한다. 감싼 키 객체의 메타데이터 접근 상태와 보조 시크릿 버전 1의 접근을 확인한다. 보조 시크릿 접근이 403 또는 404일 때 `revoked`가 나온다. 같은 권한 조건으로 승인된 각 주체가 대상이다.
- 본문 열람·KMS 복호화 권한이 없는 목록 점검 주체로 `--verify-deleted`를 실행한다. 만료 전 시크릿 메타데이터 읽기를 확인해 둔 감사 주체로, 만료 시크릿 자체가 404인지와 한 승인 접두사 아래 현행·비현행 버전과 soft-deleted 세대를 조회한다. 둘 다 비어야 `deleted`가 나온다. GCS는 soft delete 정책이 없는 버킷에서 soft-deleted 목록 요청을 400으로 거절할 수 있다. 이때 도구는 `versions_absent_soft_delete_unverified`와 종료 코드 2를 반환한다. 승인 기간 전체의 버킷 변경 감사 로그와 soft delete가 처음부터 비활성화된 증거를 대조한 뒤 복구 가능한 세대의 유무를 기록한다. Secret Manager는 설정한 시각에 시크릿과 버전을 복구 불가 삭제한다. 승인 기간 동안 별도 내보내기 또는 키 보관을 하지 않아야 한다. 공급자의 저장장치 내부 삭제 시각은 객체 API의 검증 범위를 벗어난다. [Secret Manager 만료](https://docs.cloud.google.com/secret-manager/docs/creating-and-managing-expiring-secrets) · [GCS 객체 목록 API](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/list) · [GCS 객체 수명 주기](https://docs.cloud.google.com/storage/docs/lifecycle)
- 기록에는 기한·확인 시각, 승인 범위 내 주체 수, 권한 검사 및 버전 확인 결과와 집계만 남긴다. 미확인 상태나 삭제 대기 건을 완료로 처리하지 않는다.

## 독립 PGlite에서 전체 Standard 재생

Node 24와 저장소의 개발 의존성이 있는 환경에서 저장소 루트를 작업 디렉터리로 쓴다. 아래 합성 검사는 메모리에서 사본을 만들어 봉인한 뒤, 독립 소유자와 새 PGlite 원장으로 사전 점검·접수·워커·DB 발행·소유자 결과와 이미지를 다시 읽는다.

```sh
node scripts/dev-standard-private90-full-replay.mjs --synthetic
```

승인된 사본은 전용 Dev Cloud Run Job에서 다음 명령으로 읽는다. 이 Job은 위의 사본 읽기 환경, `DEPLOYMENT_ROLE=dev`, Cloud Run이 주입한 `CLOUD_RUN_JOB`을 사용한다. 읽기 계정에는 승인된 버킷의 읽기, 지정된 KMS 키의 복호화, 지정된 만료 보조키의 메타데이터와 버전 1 읽기가 필요하다.

```sh
node scripts/dev-standard-private90-full-replay.mjs --read-copy
```

리더는 검증한 봉인 사본을 메모리에서 읽는다. 분석 호출은 메모리 PGlite, 고정 Vertex 응답, 메모리 R2와 로컬 큐로 연결한다. 결과 페이지의 공개·비공개 커서를 끝까지 읽고, 반환한 이미지 경로별 소유자 GET 및 WebP 형식을 검증하며, 후보 이미지 한 건으로 타인·익명 접근 상태를 확인한다. 결과 수치는 해당 고정 판독을 실행한 실측이다.

이 실행기의 보조키 읽기 허용 대상은 승인된 전역 Secret Manager 리소스 한 개의 메타데이터와 버전 1이다.

CLI는 자식의 표준출력과 표준오류를 폐기하고 별도 익명 파이프로 검증된 정수·상태만 출력한다. `status=verified`는 최종 접근 검증을 포함해 완료된 경우다. 실패하면 종료 코드 1과 마지막 단계·허용된 원인 분류·완료 수치만 반환한다. 공급자 계측이 설치되면 `providerCountersActive`가 1이 되고, 호출 시점부터 Apify 접근 시도·원천 이미지 다운로드 시도·고정 Vertex 호출을 집계한다. `--synthetic`은 OS 네트워크 차단 환경에서도 실행된다.

실패 진단에는 허용된 작업 단계·배치 번호, 전달 상태·오류 분류, SQLSTATE, 고정 모델 단계·오류 코드와 마지막 검사 이름을 남긴다. 최종 원장 대조는 고정 SDK 전송에 실제로 배정된 예약과 양수 정산을 대응시킨다. 전송 전 미사용으로 명시 해제된 0원 예약은 별도 집계한다.
