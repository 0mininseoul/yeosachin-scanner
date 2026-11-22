# 히어로 영상 이미지 생성 요청 (Codex용)

히어로 3D 영상(`design/namchin-demand/three/hero.js`)이 쓰는 이미지다. 타깃(10대 후반~20대 초반)에 맞춰 여성 계정을 **청순한 대학생** 분위기로 다시 만든다. 남자친구 사진(`maru-profile.jpg`)은 그대로 쓴다.

| 파일 | 쓰이는 곳 | 새 사진 태그 |
| --- | --- | --- |
| `seoa-profile.jpg` | 리포트 대표 사진 | – |
| `seoa-post-1.jpg` | 최근 게시물 1 | 캠퍼스 |
| `seoa-post-2.jpg` | 최근 게시물 2 | 카페 |
| `seoa-post-3.jpg` | 최근 게시물 3 | 한강 |
| `seoa-post-4.jpg` | 최근 게시물 4 | 전시회 |
| `seoa-post-5.jpg` | 최근 게시물 5 | 도서관 |
| `seoa-post-6.jpg` | 최근 게시물 6 | 벚꽃 |

## Codex에 붙여넣을 요청

```text
아까 만든 히어로 이미지 중 여성 계정(seoa) 7장을 새 콘셉트로 다시 만들어줘.
작업 폴더는 저장소 루트 기준 .claude/worktrees/namchin-landing-trust-20261122 이고, 새 워크트리나 브랜치는 만들지 마.
커밋, stash, reset, checkout은 하지 마.
public/namchin/assets/hero/ 에 같은 파일명으로 덮어써줘. maru-profile.jpg는 건드리지 마.

콘셉트
- 타깃이 10대 후반~20대 초반이라, 20대 후반의 화려한 느낌이 아니라 예쁘고 청순한 대학생으로 바꿔줘.
- 인물은 만 21세 성인 여자 대학생이야. 성인으로 보여야 하고 교복, 고등학생, 미성년자로 보이는 연출은 넣지 마.
- 맑은 피부, 거의 안 한 듯한 메이크업, 긴 생머리, 니트·카디건·셔츠·원피스 같은 단정한 캠퍼스 룩, 수수하지만 눈에 띄게 예쁜 인상.
- 호텔, 루프톱 바, 술, 수영장, 클럽, 몸매를 강조하는 옷과 포즈는 전부 빼줘.

공통 조건
- 실존 인물이 아닌 가상의 인물이어야 하고, 특정 연예인·인플루언서와 닮지 않게 해줘.
- 이전 seoa와 다른 새 얼굴로 만들고, 7장은 같은 사람으로 보이게 얼굴·헤어·분위기를 일관되게 유지해줘. 첫 장(seoa-profile)을 기준 이미지로 삼아 나머지를 만들어줘.
- 인스타그램에 실제로 올라올 법한 스마트폰 사진 느낌의 포토리얼 스타일. 맑고 밝은 자연광, 부드러운 필름 톤.
- 1080px 정사각형에서 작게 줄여도 얼굴이나 장소가 바로 알아보이게 구도를 단순하게 잡아줘.
- 이미지 안에 글자, 로고, 워터마크, UI 요소를 넣지 마(책 표지와 간판 글자도 보이지 않게).
- 출력: JPG, sRGB, 1080×1080 정사각형, 파일당 250KB 이하(품질 80 전후로 압축).
- public/namchin/assets/hero/ 외의 파일은 수정하지 마.

파일별 프롬프트
1) seoa-profile.jpg
Photorealistic close-up smartphone selfie of a fictional Korean female university student, clearly an adult, 21 years old, naturally beautiful with a pure and innocent look, long straight dark-brown hair with light see-through bangs, clear dewy skin, barely-there makeup with soft coral lips, gentle closed-mouth smile looking at the camera, ivory round-neck knit sweater, soft window daylight, pale neutral background, shallow depth of field, Instagram profile photo framing with the face centered, no text.

2) seoa-post-1.jpg  (캠퍼스)
The same woman walking on a Korean university campus path lined with golden ginkgo trees, wearing a beige cardigan over a white shirt and a long pleated skirt, carrying a canvas tote bag and holding two plain notebooks, turning back toward the camera with a bright natural smile, autumn afternoon sunlight, candid photo taken by a friend, Instagram feed photo, no text.

3) seoa-post-2.jpg  (카페)
The same woman sitting by a large cafe window with an iced latte on a wooden table, wearing a light-blue knit, resting her chin on her hand and smiling softly at the camera, bright airy daylight, small vase with a single flower, candid photo taken by a friend across the table, Instagram feed photo, no text.

4) seoa-post-3.jpg  (한강 피크닉)
The same woman sitting on a picnic mat on green grass by the Han River in Seoul, wearing a modest white long-sleeve cotton dress with a pale-yellow cardigan, holding a small bouquet of tulips, river and bridge softly blurred behind her, clear spring afternoon light, gentle laugh, Instagram feed photo, no text.

5) seoa-post-4.jpg  (전시회)
The same woman standing in a bright white art gallery, side profile looking at a large abstract pastel painting, wearing a light-gray blazer over a white tee and straight jeans, small crossbody bag, calm thoughtful mood, clean minimal composition, Instagram feed photo, no text.

6) seoa-post-5.jpg  (도서관)
The same woman studying at a warm wooden university library table, wearing a navy cardigan and thin round glasses, white headphones around her neck, pen in hand, looking up at the camera with a shy smile, warm lamp light and softly blurred bookshelves, Instagram feed photo, no text.

7) seoa-post-6.jpg  (벚꽃)
The same woman taking a close-up selfie under blooming cherry blossom trees, wearing a soft pink knit, a few petals in her hair, fresh radiant smile, bright spring daylight with pale pink bokeh, Instagram feed photo, no text.

완료하면 저장한 파일 7개의 이름, 해상도, 용량을 알려줘.
```

## 받은 뒤 할 일

1. 사진이 바뀌면 `design/namchin-demand/three/hero.js`의 리포트 문구도 함께 바꾼다. 지금 문구는 이전 사진(필라테스·루프톱 바·호캉스)에 맞춰져 있다.
   - 태그: 캠퍼스, 카페, 한강, 전시회, 도서관, 벚꽃
   - AI 요약: “캠퍼스, 카페, 전시회 사진이 많아요. 벚꽃과 한강 나들이 셀카를 자주 올리는 계정이에요.”
   - 계정 규모: 팔로워 1,284 / 팔로잉 612 / 게시물 94
2. `node design/namchin-demand/build-3d.mjs`로 `public/namchin/3d/`를 다시 만든다.
3. `node design/namchin-demand/preview.mjs` 실행 후 [랜딩](http://127.0.0.1:4327/namchin)을 연다. 리포트는 `?scene-t=8.7`로 멈춰 확인한다.
