# 체리 메타 광고 A/B 테스트 (남친 vs 짝남)

설계: [2026-11-23-cherry-meta-ab-design.md](../../superpowers/specs/2026-11-23-cherry-meta-ab-design.md)

같은 타겟에게 '남친 맞팔'(A)과 '짝남 맞팔'(B) 메시지를 나눠 보여주고, 어느 쪽이 예약과 결제로 더 이어지는지 비교한다.

## 시안

- 원본: `ad.html`, `ad.css`, `copy.js`(문구 표)
- 렌더: 저장소 루트에서 `node docs/marketing/cherry-meta-ab/render.mjs` → `out/`에 PNG 16장(설치된 Google Chrome 사용)
  - 일부만 렌더할 때: `render.mjs c=2 v=crush`
- 검토 보드: `index.html`을 브라우저로 연다.

| 파일 | 용도 |
|---|---|
| `c{N}-{slug}_{bf\|crush}_4x5.png` (1080×1350) | 인스타그램 피드·탐색 탭 |
| `c{N}-{slug}_{bf\|crush}_9x16.png` (1080×1920) | 스토리·릴스(위 260px·아래 350px에는 글자 없음) |

컨셉은 C1 질문 헤드라인, C2 카톡 알림, C3 팔로잉 +1, C4 친구 대화. 같은 컨셉의 A/B는 대상 단어와 그에 딸린 표현만 다르다.

## 광고 링크

광고마다 `utm_content`만 소재에 맞게 바꾼다. `v` 값이 빠지면 변형이 기록되지 않는다.

```
A: https://yeosachin.com/cherry?v=bf&utm_source=meta&utm_medium=paid_social&utm_campaign=cherry_ab_1124&utm_content=c1_bf
B: https://yeosachin.com/cherry?v=crush&utm_source=meta&utm_medium=paid_social&utm_campaign=cherry_ab_1124&utm_content=c1_crush
```

## 광고 텍스트

| 필드 | A (남친) | B (짝남) |
|---|---|---|
| 기본 문구 | 남친 인스타 팔로잉, 이제 몰래 뒤지지 마세요. 남친이 새로 맞팔하면 누군지 카톡으로 바로 알려드려요. 남친에게는 절대 알림이 가지 않아요. 🍒 선착순 300명 사전예약, 11/30 자정 마감 | 짝남 인스타 팔로잉, 이제 몰래 뒤지지 마세요. 짝남이 새로 맞팔하면 누군지 카톡으로 바로 알려드려요. 짝남에게는 절대 알림이 가지 않아요. 🍒 선착순 300명 사전예약, 11/30 자정 마감 |
| 제목 | 남친 맞팔 알리미 체리 사전예약 | 짝남 맞팔 알리미 체리 사전예약 |
| 버튼 | 신청하기 | 신청하기 |

## 광고를 켜기 전에 (사용자 작업)

1. **메타 픽셀 만들기.** 메타 이벤트 관리자 → 데이터 소스 연결 → 웹 → 픽셀을 만들고 픽셀 ID(숫자)를 복사한다.
2. **Vercel 환경변수 등록.** 운영(Production) 환경에 `CHERRY_META_PIXEL_ID`=픽셀 ID를 넣고 다시 배포한다.
3. **자동 고급 매칭 끄기.** 이벤트 관리자 → 픽셀 → 설정 → '자동 고급 매칭'을 끈다.
   - 켜져 있으면 예약 폼의 이메일·번호가 메타로 전송될 수 있다. 코드에서도 `autoConfig`를 꺼 두었지만, 이 설정을 끄는 게 기본 방어선이다.
4. **도메인 확인.** 비즈니스 설정 → 브랜드 가치 보호 → 도메인에서 `yeosachin.com`을 확인하고, 웹 이벤트 설정에서 `Lead`를 우선 이벤트로 둔다.
5. **배포 확인 후 켜기.** 광고를 켜기 전에 아래를 모두 확인한다.
   - `?v=bf`와 `?v=crush` 화면이 맞게 나온다.
   - 테스트 예약 1건의 `Lead` 픽셀 요청(`facebook.com/tr`)에 `ud[`로 시작하는 매개변수가 **없다**. 있으면 자동 고급 매칭이 켜져 있는 것이니 광고를 켜지 않는다(개인정보처리방침에 이메일·번호를 보내지 않는다고 적었다).
   - 운영 콘솔 사전예약 화면에서 테스트 예약의 변형이 기록된다.

## 캠페인 세팅

- **목표:** 잠재 고객 → 전환 위치는 웹사이트, 전환 이벤트는 `Lead`. 픽셀에 Lead가 아직 안 잡히면 '랜딩 페이지 조회'로 시작한다.
- **A/B 테스트:** 광고 세트 A(남친 소재 4개)를 만든 뒤 복제해 B(짝남 소재 4개)로 바꾼다. 캠페인의 'A/B 테스트'에서 변수 '크리에이티브'를 고른다. 예산, 타겟, 지면, 기간은 같게 둔다.
- **타겟:** 대한민국, 여성, 만 18~25세. Advantage+ 타겟 확장은 끈다. 관계 상태 같은 상세 타겟은 쓰지 않는다(같은 사람들에게 메시지만 바꿔 보여주는 실험이다).
- **지면:** 수동으로 인스타그램 피드·탐색 탭·스토리·릴스를 고른다. 광고마다 4:5와 9:16을 지면별 이미지로 함께 넣는다.
- **기간:** 배포 확인 직후(목표 11/24)부터 11/30 23:59까지. 12/1 0시에 사전예약이 닫힌다.
- **예산:** A/B 테스트 화면의 '검정력'(테스트 성공 가능성)이 80% 이상이 되도록 잡는다.

## 판정

1. **진행 중:** 변형별 예약 1건당 비용. 메타 보고서의 Lead와 운영 콘솔 사전예약 화면의 변형별 합계(A 남친 / B 짝남 / 변형 없음)를 함께 본다.
   - 이미 예약한 사람이 다시 제출해도 메타에는 Lead가 한 번 더 잡히지만 DB 행은 늘지 않는다. 그래서 메타 Lead가 DB보다 조금 많을 수 있고, 판단은 DB 합계 기준으로 한다.
   - 짝남 링크를 메타(페이스북·메신저)에 공유하면 미리보기는 기본(남친) 이미지로 나온다. `og:url`을 `/cherry`로 둬서 공유 유입이 짝남으로 섞이지 않게 한 의도된 동작이다.
2. **최종:** 변형별 **결제 1건당 광고비** = 그 변형의 광고비 ÷ 그 변형의 결제자 수.
   - 결제자: 예약자와 같은 계정(휴대폰 번호 우선, 없으면 이메일)이 판매를 켠 시각부터 7일 안에 체리를 처음 결제한 경우. 4,900원 예약가와 9,900원 정가를 모두 포함하고, 무상 지급(`grant`)은 뺀다.
   - 변형별 결제자가 30명 미만이면 결제율 차이는 참고용으로 보고, 예약 1건당 비용과 '예약 → 결제' 비율의 방향으로 판단한다.

### 결제 분석 쿼리

첫 줄의 `sale_open` 값을 실제로 판매 스위치를 켠 시각으로 바꿔서 Supabase SQL 편집기에서 실행한다.

```sql
with params as (
    select timestamptz '2026-12-01 00:00:00+09' as sale_open
), reservations as (
    select reservation.variant,
        coalesce(
            (select account.id from public.users as account
             where account.phone_number_normalized = reservation.phone
             order by account.created_at limit 1),
            (select account.id from public.users as account
             where lower(btrim(account.email)) = reservation.email
             order by account.created_at limit 1)
        ) as user_id
    from public.namchin_launch_reservations as reservation
)
select coalesce(reservations.variant, 'none') as variant,
    count(*) as reservations,
    count(*) filter (where exists (
        select 1 from public.cherry_subscriptions as subscription
        where subscription.user_id = reservations.user_id
          and subscription.payment_provider <> 'grant'
          and subscription.first_paid_at >= params.sale_open
          and subscription.first_paid_at < params.sale_open + interval '7 days'
    )) as payers
from reservations, params
group by 1
order by 1;
```
