# Dev DB 초기화 자료

이 디렉터리는 2026-10-09 승인된 별도 Dev UI 환경의 초기 기준점이다. 운영 migration 목록을 재생하거나 원격 이력을 수정하는 자료가 아니다. 적용 대상은 등록된 Dev 프로젝트 `bgamojfpkxnnumfvkron`뿐이다.

`production-baseline.sql`은 canonical main의 linked production을 읽기 전용으로 조회한 PostgreSQL 17 schema-only 기준점이다. public 150개 테이블과 private 함수 1개를 포함하며 업무·Auth·Storage·vault·migration 이력 행은 포함하지 않는다. Production DB나 연결 설정은 변경하지 않았다.

이 schema-only dump는 적용한 파일 hash와 기존 함수 본문 fingerprint를 유지하기 위해 원본 공백도 보존한다. `.gitattributes`의 whitespace 검사 예외는 이 파일 하나에만 적용하며 코드·control SQL·문서의 diff 검사는 유지한다.

## 검토한 환경 예외

- 운영 주문/요청에 고정된 사고 복구 함수 4개는 signature·owner·권한을 보존하고 Dev에서 예외를 반환하도록 본문만 비활성화했다. 고정 UUID와 원본 본문은 저장하지 않으며 원본 본문 hash만 manifest에 남긴다.
- `auth.users.on_kakao_auth_user_created_discord_outbox`는 Dev 로그인 알림을 만들지 않도록 복제하지 않았다.
- Auth/Storage/Realtime/vault/GraphQL 시스템 schema는 새 프로젝트의 관리 정의를 유지한다. 과거 partition·credential·업무 데이터·cron/webhook 대상은 복사하지 않는다.
- 관리 역할 `supabase_admin`의 public default ACL 12문장은 source와 fresh Dev의 동일 권한을 확인한 뒤 기존 관리 설정을 유지했다. postgres가 관리 역할의 구성원이 아니므로 해당 역할의 ACL을 다시 쓰지 않는다.
- fresh public default grants는 객체 생성 전에 중립화하고 source 객체 ACL과 default ACL을 복원했다. 실제 테이블·열·함수 권한 비교로 추가 권한이 없는지 확인한다.
- source `pg_graphql` 1.5.11과 fresh Dev 1.6.2는 관리형 확장 버전 예외다. 앱의 GraphQL 호출은 없고 사용자 정의 schema 및 권한은 별도로 비교한다. 관리 확장을 강제 downgrade하거나 시스템 schema를 덮어쓰지 않는다.

## 비교 자료

- `baseline-manifest.safe.json`: 기준점 hash, 데이터 미복제, 개별 예외와 적용 전제.
- `catalog.sql` / `production-catalog.safe.json` / `dev-baseline-parity.safe.json`: 테이블·열·제약·index·view·함수·policy·trigger·타입·sequence·schema·default grants·Realtime membership·확장 fingerprint.
- `security-catalog.sql` / `*-security-catalog.safe.json` / `security-parity.safe.json`: view SQL과 함수 본문에 독립적인 signature·반환형·언어·volatility/strict/parallel·인수 기본값과 owner·테이블/열/함수 권한·RLS·security-definer/search-path 설정, global default ACL, replica identity, publication operation flags와 view 열/옵션, 제약 validation, index valid/ready 상태 비교.
- `schema-reparse-diffs.safe.json`: PostgreSQL이 재파싱하며 달리 출력한 schema 표현식만 보관한다. 업무 행을 포함하지 않는다.
- `verify-reparse-equivalence.py` / `reparse-equivalence.safe.json`: 같은 순서를 유지한 동일 AND/OR flatten과 literal unbounded varchar 배열의 text cast 분배만 허용한다. 그 외 차이는 자동 승인하지 않는다.
- `control-plane.sql`: 별도 Dev 모의 주문/실행용 추가 schema와 service-only RPC. Production 기준점과 구분해 검증하며 production migration으로 적용하지 않는다.
- `control-plane-permissions.safe.json` / `control-plane-remote.safe.json`: 실제 Dev의 service-only 권한과 서로 다른 PostgreSQL 세션의 row lock·미커밋 실행 비가시성·주문당 실행 1개·동일 시작 replay·TTL 분리·취소/실패 실행 0개 검증. 생성한 합성 행은 정리했다.
- `post-control-security-parity.safe.json`: 기존 보안 metadata 3,775개 불변, 추가 wrapper 9개의 security/shape 항목 18개만 증가. 기존 global/public default ACL을 변경하지 않았다.
- `security-advisors.safe.json`: 기준 정의의 WARN 26개와 새 Dev control 경고 0개를 구분한다. 전체 보안 PASS를 의미하지 않는다.
- `vercel-configuration.safe.json` / `kakao-configuration.safe.json`: non-secret 환경 identity와 별도 Dev 카카오 설정의 검증 결과. 실제 SSO·UI 결과는 배포 후 별도 영수증에 기록한다.

## 적용 경계

기준점에는 transaction과 빈 public 업무 테이블 전제가 있다. 실제 적용 전 대상 project ref·빈 DB·검토된 파일 hash를 확인한다. 운영 CLI 인증이 이 계정에서 SQL 권한을 거절해 root에 이미 있는 인증값을 메모리로만 주입한 읽기 연결과 Dev 관리 API를 사용했다. 비밀번호·키를 인수, 파일, 로그에 넣지 않았다.

관리 API의 본문 크기 제한으로 기준점 요청이 거절됐고, 첫 직접 연결의 시간 초과 뒤에는 public 테이블 0개로 rollback을 확인했다. 이후 Dev 전용 단기 CLI login role을 메모리에서 받아 전체 기준점을 단일 transaction으로 적용하고 COMMIT·public 150개·private 함수 1개를 확인했다. 관련 없는 migration을 push하거나 실패한 적용을 무조건 반복하지 않았다.

재생성·새 migration은 schema 자료 검토와 정확한 대상 allowlist를 거친다. 새로운 baseline을 운영 DB에 적용하거나 `history repair`·`--include-all`·production reset을 실행하지 않는다. 운영 계정 분석과 provider 품질은 이 자료의 검증 범위에 포함하지 않는다.
