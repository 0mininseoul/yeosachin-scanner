# 체리 사전 예약 유입 경로 표시 제안

## 목적과 범위

체리 운영 콘솔의 사전 예약 명단에 예약 당시 확인된 유입 경로를 표시한다. 스레드, 에브리타임(에타), X에 배포하는 UTM 링크를 우선 지원한다. 기존 광고 변형 표시는 유지한다.

## 수집 및 저장

- 랜딩 페이지의 `utm_source`가 `threads`, `everytime`, `x` 중 하나이면 해당 채널로 기록한다. 다른 값은 임의로 해당 채널로 분류하지 않는다.
- UTM이 없는 경우 브라우저가 제공하는 유입 사이트 정보를 이용할 수 있으면 알려진 채널만 분류하고, 확인할 수 없으면 `확인 불가`로 표시한다. 앱 내 브라우저나 공유 방식에 따라 정보가 전달되지 않을 수 있다.
- 예약 제출 시 분류된 채널만 서버에 전달하고 예약 레코드에 선택적 필드로 저장한다. 전체 유입 URL, 검색어, 임의의 UTM 값은 저장하지 않는다.
- 같은 탭에서 새로고침하거나 예약하기 전에 페이지를 다시 열 때 채널이 사라지지 않도록 해당 탭의 세션 저장소에 분류 결과를 보관한다. 새로 유효한 UTM 링크로 방문하면 그 값으로 갱신한다.
- 기존 이메일 또는 전화번호와 중복된 제출은 현재와 같이 기존 예약을 변경하지 않는다. 수집 정보나 스키마가 일시적으로 없더라도 예약은 접수되어야 한다.
- 기존에 채널이 저장되지 않은 예약은 `확인 불가`로 표시한다. 기존의 광고 변형이 없다는 사실만으로 광고를 보지 않았다고 판단하지 않는다.
- 배포용 링크는 채널마다 기본 남친 페이지와 `concept=crush` 짝남 페이지를 제공한다. 짝남 배포 링크는 메타 광고 A/B 집계에 넣지 않는다.
- 예약 API가 접수를 확인하면 브라우저에 완료 표시만 저장한다. 두 컨셉에서 새로고침하거나 다시 열 때 동일한 완료 화면을 표시하며 연락처를 브라우저 저장소에 남기지 않는다. 완료 화면 복원은 예약 요청과 완료 이벤트를 다시 발생시키지 않는다.

## 운영 콘솔과 배포

- 명단에 `유입 경로` 열을 추가해 스레드, 에타, X, 확인 불가를 표시한다. 기존 이메일·전화번호·동의 일시·광고 변형 및 검색과 페이지 이동을 유지한다.
- 예약 페이지, 예약 API, DB migration, 관리자 API와 콘솔을 함께 변경한다. 실제 운영 반영은 관련 검사와 독립 리뷰를 거친 PR 병합 및 배포 이후에만 완료된다. 운영 DB는 저장소의 Supabase 운영 규칙에 따라 검증한다.
- UTM 링크는 변경사항이 운영에 반영된 뒤부터 예약자별 경로를 기록한다. 브라우저 또는 외부 앱이 매개변수를 제거하거나 다른 기기에서 예약하면 확인되지 않을 수 있다.

| 채널 | 남친 컨셉 | 짝남 컨셉 |
| --- | --- | --- |
| 스레드 | [링크](https://yeosachin.com/cherry?utm_source=threads&utm_medium=organic_social&utm_campaign=cherry_preorder) | [링크](https://yeosachin.com/cherry?concept=crush&utm_source=threads&utm_medium=organic_social&utm_campaign=cherry_preorder) |
| 에타 | [링크](https://yeosachin.com/cherry?utm_source=everytime&utm_medium=organic_social&utm_campaign=cherry_preorder) | [링크](https://yeosachin.com/cherry?concept=crush&utm_source=everytime&utm_medium=organic_social&utm_campaign=cherry_preorder) |
| X | [링크](https://yeosachin.com/cherry?utm_source=x&utm_medium=organic_social&utm_campaign=cherry_preorder) | [링크](https://yeosachin.com/cherry?concept=crush&utm_source=x&utm_medium=organic_social&utm_campaign=cherry_preorder) |

## 확인 기준

1. 각 UTM 링크에서 예약하면 해당 예약 행에 올바른 채널이 표시된다.
2. UTM이 없어도 인식 가능한 유입 정보가 있는 경우에만 해당 채널로 표시하고, 그렇지 않으면 확인 불가로 표시한다.
3. 기존 예약과 중복 예약, 광고 변형, 예약 접수, 명단 검색과 페이지 이동이 기존 방식대로 동작한다.
4. 저장 필드가 아직 없는 상황에서도 예약 접수와 기존 명단 조회가 계속 동작한다.
5. 여섯 배포 링크가 각각 의도한 컨셉으로 열리고 짝남 배포 링크는 광고 변형으로 기록되지 않는다.
6. 성공 후 새로고침하거나 컨셉을 바꿔도 같은 브라우저에서 완료 상태가 표시된다. 미접수 브라우저와 실패한 요청은 완료 상태로 표시되지 않는다.
