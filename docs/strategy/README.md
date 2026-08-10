# 전략 문서 안내

이 디렉터리는 제품·매출 가설과 다음 의사결정을 관리한다. 기술 구현 방법은 `docs/superpowers/specs`, 실제 비용 숫자는 `docs/operations-cost-model.md`, 결제·환불·이행 사실은 Supabase 원장을 정본으로 쓴다.

## 현재 읽을 문서

| 질문 | 정본 | 상태 |
|---|---|---|
| 8월에 무엇을 어떤 순서·가격·중단 기준으로 운영하나 | [8월 매출 우선 운영 전략](./2026-08-08-revenue-first-operating-strategy.md) | **현재 실행 정본** |
| 어떤 고객·문제·수익 가설을 믿고 있나 | [린 캔버스](./2026-07-31-lean-canvas.md) | v7 |
| 어떤 가설을 어떤 증거로 채택·기각하나 | [검증 보드](./2026-07-31-validation-board.md) | rev.4 |
| 제품을 모르는 사람에게 무엇을 물어보나 | [인터뷰 가이드](./2026-07-31-interview-guide.md) | v6, **유효** |

현재 결론은 첫 외부 Basic 결제와 결과 열람을 근거로 판독기 제한 판매를 유지하면서, Apify Basic/Standard E2E를 먼저 복구하고 맞팔 알리미 concierge 파일럿을 병행해 8월 환불 차감 매출 목표를 달성하는 것이다. 정확한 가격·재고·원가·일정은 중복하지 않고 [8월 전략 §1](./2026-08-08-revenue-first-operating-strategy.md#1-업데이트된-최종-결정)을 참조한다.

## 구현 전 검토 문서

| 작업 | 설계 정본 |
|---|---|
| 실사용자/E2E 원장 분리, `is_paid_user`, 수명주기 | [계정 원장 분리와 paid-ever](../superpowers/specs/2026-08-10-account-ledger-paid-status-design.md) |
| `profile_pic_url + fullname` 라우팅, 100/200 상한, 미상·비용 gate | [성별 라우팅과 원가 상한](../superpowers/specs/2026-08-10-gender-routing-cost-control-design.md) |
| fresh E2E, R2 이미지, demo, 공유, Replay, 배포 | [유료 분석 E2E와 결과 관측](../superpowers/specs/2026-08-10-revenue-e2e-observability-design.md) |

세 설계는 2026-08-10 사용자 승인을 받았다. 별도 Orca worktree에서 account-ledger → revenue-e2e 순으로 구현하며, 현재 전략 worktree에는 구현 코드나 production migration을 섞지 않는다. `revenue-e2e`의 프론트 계획 전에는 승인된 외부 레퍼런스 관찰 gate를 먼저 수행한다.

## 인터뷰 가이드의 유효 범위

[2026-07-31 인터뷰 가이드](./2026-07-31-interview-guide.md)의 콜드 문제 인터뷰 질문과 `썸 3 + 연애 3` 표본은 그대로 유효하다. 첫 결제 한 건은 990원 지불 행동만 확인했으므로 문제 가설 전체를 대체하지 않는다.

다만 다음 용도로는 별도 질문지가 필요하다.

- 첫 구매자의 결제·결과 경험 디브리프
- 맞팔 알리미 가격·알림 가치 검증
- 제품을 이미 본 이탈자 조사

맞팔 여부는 판독기 인터뷰의 기술적 참가 조건이 아니라 관찰 맥락이다.

## 집계 규칙

- 외부 매출·퍼널에는 서버가 `external`로 확정한 lineage만 포함한다.
- `operator`, `e2e_test`, `internal_tester`, 로그인 전 `unknown`은 외부 KPI에서 제외한다.
- 과거 `checkout_started = 5`는 관리자와 내부 테스트 오염이 확인돼 현재 외부 사용자 수로 쓰지 않는다.
- 공유는 initiated, clipboard copy, OS handoff, Kakao webhook-confirmed, shared-result open을 서로 다른 사건으로 본다.
- 첫 결제 한 건과 팀이 만든 화면·로그를 시장 전체 수요나 모델 정확도의 증거로 확대 해석하지 않는다.
- 결제자 이름, UUID, 대상 계정, 인증정보는 전략 문서에 기록하지 않는다.

## 역사적 문서

| 문서 | 용도 |
|---|---|
| [전략 전면 재검토 rev.3](./2026-08-07-strategy-full-review.md) | 8월 7일 당시의 가격·원가 대안. 실행 결정은 8월 8일 문서가 대체 |
| [selfhosted_auth 전략 답변](./2026-08-06-selfhosted-auth-strategy-answer.md) | 가격·원가 시차와 당시 선택지 기록 |
| [selfhosted_auth 전략 재검토](./2026-08-06-selfhosted-auth-strategy-review.md) | 인증 수집 실측과 계정 풀 가설 기록 |
| [린 스타트업 관점 재정립](./2026-07-31-lean-restatement.md) | 최초 진단과 방법론 기록 |

## 갱신 규칙

1. 운영 순서·가격·재고·중단 기준은 8월 전략만 먼저 고친다.
2. 문제·세그먼트·UVP 가설은 린 캔버스, 실험 상태는 검증 보드에 반영한다.
3. 구현 불변식은 해당 설계 문서에만 두고 전략 문서에는 결론과 링크만 남긴다.
4. 실제 원가는 비용 모델, 실제 주문·환불·이행은 Supabase를 따른다.
5. 확정 랜딩 마케팅 카피는 소유자 승인 없이 바꾸지 않는다.
