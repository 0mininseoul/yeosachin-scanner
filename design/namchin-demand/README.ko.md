# 체리(남친 맞팔 알리미) 랜딩 작업 안내

새 워크트리는 최신 `origin/main`을 기준으로 만든다. Node 24에서 저장소 루트로 이동한 뒤 아래 명령으로 미리보기를 연다.

```sh
npm ci
node design/namchin-demand/preview.mjs
```

- [랜딩 미리보기](http://127.0.0.1:4327/cherry)에서 운영과 같은 HTML과 정적 파일을 확인한다. 기존 미리보기 주소 `/`도 사용할 수 있다.
- 로고는 [체리 B안 ‘빼꼼’](cherry-logo-concepts/b.png)이다. `public/cherry/logo.png`는 이 원본을 192px로 줄이고 모서리를 둥글게 잘라 만든다. 이전 [알림 종 시안](http://127.0.0.1:4327/logo-concepts/)은 기록으로 남긴다.
- [테스트 집계](http://127.0.0.1:4327/preview/stats)는 현재 미리보기 프로세스의 랜딩 조회수와 로컬 신청 건수를 반환한다.

## 수정 위치

| 작업 | 파일 |
| --- | --- |
| 문구, 마크업 | [public/cherry/landing.html](../../public/cherry/landing.html) |
| 레이아웃과 스타일 | [public/cherry/landing.css](../../public/cherry/landing.css) |
| 타이머, 알림 예시 영상, 폼 | [public/cherry/landing.js](../../public/cherry/landing.js) |
| 첫 접속 장치 | [public/cherry/intro.js](../../public/cherry/intro.js)(재생 여부), `landing.css`의 Opening 구간(동작), `landing.js`(건너뛰기) |
| 예약 마감 시각 | [public/cherry/campaign.mjs](../../public/cherry/campaign.mjs) |
| 히어로·비밀 보장 3D 장면 원본 | [design/namchin-demand/three/](three/) (수정 후 `node design/namchin-demand/build-3d.mjs`로 `public/cherry/3d/`를 다시 만든다) |
| 공유 이미지(OG) | `public/cherry/og.jpg` (원본 [og/b.html](og/b.html)을 1200×630으로 캡처해 JPG로 저장, [시안 비교](http://127.0.0.1:4327/og/)). 공유 제목·설명은 `index.html`의 `og:`·`twitter:` 항목 |
| 히어로 영상 이미지 | `public/cherry/assets/hero/` ([생성 요청문](hero-image-prompts.ko.md)) |
| 체리 로고 시안 비교 (B안 선택) | [design/namchin-demand/cherry-logo-concepts/](cherry-logo-concepts/index.html) ([미리보기](http://127.0.0.1:4327/cherry-logo-concepts/)) |
| 첫 접속 장치 시안 비교 (B안 ‘눈을 뜬다’ 선택, 팔로잉 230→231 신호를 더해 적용) | [design/namchin-demand/intro-concepts/](intro-concepts/index.html) ([미리보기](http://127.0.0.1:4327/intro-concepts/)) |
| 프라이빗 오픈 목업 시안 비교 (A안 ‘보이는 사람, 안 보이는 사람’ 선택) | [design/namchin-demand/private-concepts/](private-concepts/index.html) ([미리보기](http://127.0.0.1:4327/private-concepts/)) |
| 타이머 시안 비교 | [design/namchin-demand/timer-concepts/](timer-concepts/index.html) ([미리보기](http://127.0.0.1:4327/timer-concepts/)) |
| 접수 API | [app/api/cherry/reservations/route.ts](../../app/api/cherry/reservations/route.ts) |
| 운영 명단 | [app/admin/console/namchin-waitlist-console.tsx](../../app/admin/console/namchin-waitlist-console.tsx) |

미리보기는 테스트용 연락처를 로컬 SQLite에 저장한다. 동일한 이메일 또는 휴대폰 번호는 최초 신청을 유지한다. 서버가 시작할 때 SQLite 파일 경로를 표시한다. `NAMCHIN_PREVIEW_DB`에 그 경로를 지정하면 기존 로컬 테스트 기록을 다시 열 수 있다. 포트가 이미 사용 중이면 `NAMCHIN_PREVIEW_PORT`로 바꿀 수 있다. 개인정보처리방침 링크는 공개 정책 페이지로 연결된다.

3D 장면은 랜딩 주소에 `?scene-t=초`를 붙이면 그 시점에 멈춘다(예: 팔로잉 +1 `?scene-t=1.1`, 푸시 알림 `?scene-t=2.6`, 프로필·계정 규모 `?scene-t=5.6`, 게시물·AI 요약 `?scene-t=9.6`). 두 번째 계정은 11초를 더한다. 움직임 줄이기 설정에서도 정지 화면으로 보인다.

히어로 영상은 두 계정의 리포트를 이어서 반복한다(팔로잉 230→231 `seoa`, 231→232 `rina`). 문구와 수치는 `three/hero.js`의 `PEOPLE`에 있다. ‘알림 예시’는 화면에 들어오면 알림톡 → 리포트 순서로 자동 재생하고, 스크립트가 없거나 움직임 줄이기 설정이면 두 화면을 나란히 세워 보여준다.

사전 예약 구간의 초대장은 입력 중인 이메일·휴대폰을 가려서 보여준다. 화면 안에서만 쓰고 전송하지 않으며, 등록하면 ‘등록 완료’ 도장이 찍힌다. ‘프라이빗 오픈’ 구간과 초대장은 마감 뒤에는 숨는다.

첫 접속 장치는 브라우저 탭마다 한 번만 나온다. 장치가 걷히면 히어로 문구, 영상 무대 순서로 들어오고 무대가 자리를 잡으면 영상이 시작된다. 다시 보려면 새 탭에서 연다. 화면을 누르거나 스크롤하거나 아무 키를 누르면 건너뛴다. `#waitlist`처럼 특정 위치로 바로 들어오거나 움직임 줄이기 설정이면 나오지 않는다.

마감 이후에도 신청 폼을 검토하려면 미리보기 시작 시각을 한국시간으로 지정한다. 타이머는 지정한 시각에서 시작해 실제 시간처럼 진행된다.

```sh
NAMCHIN_PREVIEW_NOW=2026-11-22T12:00:00+09:00 node design/namchin-demand/preview.mjs
```

운영 주소는 [yeosachin.com/cherry](https://yeosachin.com/cherry)다. 정적 파일은 `/cherry/`, 예약 API는 `/api/cherry/reservations`를 사용한다. 이전 예약 API는 열린 탭의 요청을 위해 유지한다. Next 앱의 운영자 명단은 Supabase를 사용한다. [서비스 기획서](../../docs/superpowers/specs/2026-11-18-namchin-mutual-alert-design.ko.md)에 사전 예약 운영과 정식 서비스 계획을 정리했다.
