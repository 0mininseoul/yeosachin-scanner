# 남친 맞팔 알리미 랜딩 작업 안내

새 워크트리는 최신 `origin/main`을 기준으로 만든다. Node 24에서 저장소 루트로 이동한 뒤 아래 명령으로 미리보기를 연다.

```sh
npm ci
node design/namchin-demand/preview.mjs
```

- [랜딩 미리보기](http://127.0.0.1:4327/namchin)에서 운영과 같은 HTML과 정적 파일을 확인한다. 기존 미리보기 주소 `/`도 사용할 수 있다.
- [로고 시안 비교](http://127.0.0.1:4327/logo-concepts/)에서 네 가지 원본 PNG와 32px 미리보기를 확인한다. 선택된 원본은 [A안 알림 종](logo-concepts/a-bell.png)이다.
- [테스트 집계](http://127.0.0.1:4327/preview/stats)는 현재 미리보기 프로세스의 랜딩 조회수와 로컬 신청 건수를 반환한다.

## 수정 위치

| 작업 | 파일 |
| --- | --- |
| 문구, 마크업 | [public/namchin/index.html](../../public/namchin/index.html) |
| 레이아웃과 스타일 | [public/namchin/landing.css](../../public/namchin/landing.css) |
| 타이머, 리포트 예시 탭, 폼 | [public/namchin/landing.js](../../public/namchin/landing.js) |
| 예약 마감 시각 | [public/namchin/campaign.mjs](../../public/namchin/campaign.mjs) |
| 접수 API | [app/api/namchin/reservations/route.ts](../../app/api/namchin/reservations/route.ts) |
| 운영 명단 | [app/admin/console/namchin-waitlist-console.tsx](../../app/admin/console/namchin-waitlist-console.tsx) |

미리보기는 테스트용 연락처를 로컬 SQLite에 저장한다. 동일한 이메일 또는 휴대폰 번호는 최초 신청을 유지한다. 서버가 시작할 때 SQLite 파일 경로를 표시한다. `NAMCHIN_PREVIEW_DB`에 그 경로를 지정하면 기존 로컬 테스트 기록을 다시 열 수 있다. 포트가 이미 사용 중이면 `NAMCHIN_PREVIEW_PORT`로 바꿀 수 있다. 개인정보처리방침 링크는 공개 정책 페이지로 연결된다.

마감 이후에도 신청 폼을 검토하려면 미리보기 시작 시각을 한국시간으로 지정한다. 타이머는 지정한 시각에서 시작해 실제 시간처럼 진행된다.

```sh
NAMCHIN_PREVIEW_NOW=2026-11-22T12:00:00+09:00 node design/namchin-demand/preview.mjs
```

운영 경로는 [yeosachin.com/namchin](https://yeosachin.com/namchin)이다. Next 앱의 운영자 명단은 Supabase를 사용한다. [서비스 기획서](../../docs/superpowers/specs/2026-11-18-namchin-mutual-alert-design.ko.md)에 사전 예약 운영과 정식 서비스 계획을 정리했다.
