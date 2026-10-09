# 분석 중 화면 1안 · 시각 QA

한국어 검증 기록이다. 원본 시안과 실제 구현 캡처를 함께 열어 비교했다. 사용자 결정에 따라 단일 사진 대신 기존 수집 계정 이미지 슬라이딩을 유지한다. 결과 화면 재구성은 범위 밖이다.

## 비교 대상과 증거

- 원본: [proposal-1.png](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-progress-ux-audit/proposal-1.png), 생성 이미지 853×1844px, 의도된 CSS 비율 390×844. 실제 렌더링 증거가 아니다.
- 구현: [최종 모바일](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-progress-implementation/mobile-390-parallel-25-viewport.png), CSS/PNG 390×844, DPR 1, Chromium. 실제 페이지·hook·슬라이딩·CSS·Paperlogy를 사용한 사용자 승인 격리 하네스다. Dev 인증·서버를 통한 모바일 E2E는 아니다.
- [동일 입력 비교](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-progress-implementation/comparison-option1-mobile.png): 원본을 390×844로 정규화해 왼쪽, 최종 구현을 오른쪽에 둔 800×844 이미지다. Root가 두 화면을 이 이미지에서 직접 비교했다.
- 비교 상태: 어두운 테마, 전체 25%, 앞 두 작업 진행 중, 정리 대기. 실제 projector의 5→15→25% 응답으로 후보 이력이 누적된 상태다. 합성 사진 반복은 fixture이며 Production 중복 사진 오류로 단정하지 않는다.
- [실제 Dev 데스크톱](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-progress-implementation/02-dev-progress-parallel.png): Aside CSS 1440×900, PNG 2880×1800, DPR 2. 전체 54%의 병렬 진행과 같은 런타임 표현을 직접 확인했다. 25% 시안과 수치가 다른 실제 흐름 증거이며 모바일 픽셀 비교를 대체하지 않는다.
- 소스 기준 `309e181313f3408e964c78de49af918c81441247`. 자세한 측정·명령·소스 hash·콘솔 분류는 [모바일 검증 기록](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-progress-implementation/mobile-validation.ko.md)에 있다.

## 발견 사항과 수정 이력

1. **P2 해결 — 390px 첫 화면의 보관함 버튼 하단 절단.** 초기 CTA는 y796.5~846.5로 844px 화면에 일부 걸쳤다. [수정 전](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-progress-implementation/before-mobile-390-parallel-25-viewport.png)을 보존했다. 구현자가 여섯 곳의 세로 간격을 각각 4px 줄였다. 최종 CTA는 y772.5~822.5로 전체가 보이며 원형 184px·이미지 rail 84px·글자 크기는 유지했다. 수정 후 캡처와 위 최종 비교에서 해결을 확인했다.
2. **허용 차이 — 단일 사진에서 슬라이딩으로.** 사용자가 명시적으로 요청한 차이다. 기존 안전한 이미지 처리·현재 이미지 강조·84px 타일·연속 이동을 그대로 사용한다. 계정명은 별도 줄로 읽을 수 있게 배치했다.
3. **허용 차이 — 기존 브랜드와 서버 활동 문구.** 실제 Dev 배너·Paperlogy·브랜드 header와 서버의 현재 작업 설명을 유지한다. 원본 생성 이미지의 개별 글자·표현을 제품 전체에 덮어쓰지 않았다. 현재 작업명과 전체 진행률의 의미는 승인 요구와 일치한다.
4. **허용 차이 — 320px의 자연스러운 세로 스크롤.** 문서 폭은 정확히 320px이고 가로 넘침이 없다. 안내문 줄바꿈으로 CTA 하단은 845.25px이다. Tab 포커스·ArrowDown으로 전체 버튼이 표시되고 Enter로 보관함 경로가 선택된다. 고정 요소가 버튼을 덮지 않는다. 모든 작은 viewport에서 세로 스크롤 제거를 약속하지 않는다.

## 필수 시각 항목

| 항목 | 판정과 실제 근거 |
| --- | --- |
| 글꼴·위계 | 실제 로컬 Paperlogy 로딩 확인. h1 20px, 작업명15px, 설명·상태14px, CTA16px. 전체 값52px와 제목 위계가 명확하고 긴 안내는 자연스럽게 줄바꿈된다. |
| 간격·배치 | 원형184×184·rail84px·본문 max-width460 구조 유지. 390 CTA 전체 표시, 320 가로 넘침 없음. 단일사진보다 커진 중앙 영역은 승인된 슬라이딩 차이다. |
| 색상·토큰 | 기존 따뜻한 검정·격자·혈색 빨강·jade 안내 사용. 모형의 더 밝은 jade와 실제 토큰은 차이가 있으나 안내가 읽히며 상태는 글자로도 구별된다. 전체 WCAG 적합 판정은 하지 않았다. |
| 이미지·아이콘 | 기존 로컬 합성 아바타와 브랜드 자산 재사용. 사진 blur는 원본 fixture 의도이며 깨진 이미지가 아니다. 새 Check/Archive/ChevronRight는 설치된 lucide 아이콘 사용. |
| 문구·내용 | 전체 진행률을 명시하고 작업별 중복 %·단위 불명 n/100을 숨겼다. Dev45초와 Production 가변 시간 안내를 분리한다. 현재 순번은 두 계약 값이 있을 때만 표시한다. |

같은 입력의 390px 비교에서 14~20px 본문·아이콘·상태를 읽을 수 있고 중요 영역은 별도로 계측했다. 글자가 판독 불가능할 정도로 축소되지 않아 추가 부분 확대 비교는 필요하지 않았다.

## 행동·콘솔·한계

격리 브라우저에서 0/25/55/80/95/100%, 병렬·마지막 단계, 명시적 순번, 키보드 CTA, 실패·404, 초기/간헐503·네트워크 오류 뒤 같은 요청 GET 복구를 확인했다. 900ms 슬라이딩 11→34px, 모션 감소 시 0→0과 레이더 정지를 측정했다. 같은 revision 재조회에서 h1 mutation 0회, progressbar 이름·값·범위와 h1 polite/atomic 속성을 확인했다. 의도한 오류 주입에 따른 콘솔10건 외 예상하지 않은 콘솔 오류·warning은 없다.

모바일의 Next navigation/image 및 인증/telemetry는 격리 double이다. 실제 목적지 화면·Dev 인증·실물 기기·iOS Safari·스크린리더 낭독·장시간 지연·실제 provider/AI·결제·운영 egress/청구는 이 시각 검수로 검증하지 않았다. 전체 UX·접근성·Production 실분석 성공을 뜻하지 않는다.

## 구현 점검

- [x] 승인 시안 및 사용자 슬라이딩 수정 방향 반영
- [x] 실제 렌더링과 같은 입력에서 비교
- [x] P2 CTA 절단 수정 및 재캡처
- [x] 390/320 반응형·핵심 상태·키보드·모션 감소 확인
- [x] 구현자와 별도 agent의 모바일 검증, Root 시각 통합 검토

남은 P0/P1/P2 시각 수정 요청은 없다. P3 추가 재구성은 제안하지 않는다.

final result: passed
