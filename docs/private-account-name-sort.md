# 비공개 계정 "여자 이름순" AI 정렬 — 스펙 & 프롬프트

## 구현 상태 (2026-07-11)

- `private_accounts`에 `name_female_score`, `name_is_name`, `name_confidence`를 저장한다.
- `lib/services/ai/private-name-analysis.ts`가 최대 100개씩 Gemini 텍스트 배치로 분석하고, 기존 AI 동시성 한도 안에서 청크를 병렬 처리한다.
- 실패한 청크는 중립값 `(0.5, false, 0)`으로 저장해 이미 수행한 유료 관계 수집을 반복하지 않는다.
- 일반/공유 결과 API 모두 점수 내림차순, confidence 내림차순, username 오름차순으로 정렬한다.
- 이름 기반 결과는 실제 성별 판정이 아닌 확률적 텍스트 정렬이며 결과 화면에 오차 가능성을 고지한다.

비공개(private) 계정은 게시물·상호작용을 분석할 수 없으므로, **username / full_name(표시 이름) 텍스트만으로** 계정 주인이 여성일 가능성을 추정해 **여성 이름에 가까운 순으로 정렬**한다. (프론트 결과 화면의 "비공개 계정" 탭이 이 정렬 순서를 그대로 렌더한다.)

> 이 작업은 백엔드(파이프라인 + 스키마 + 결과 API)에서 진행. 아래는 연동 스펙과 Gemini 프롬프트.

## 접근 (선택 A: 파이프라인 1회 계산·저장)

1. **스키마** — `private_accounts`에 컬럼 추가:
   ```sql
   ALTER TABLE private_accounts
     ADD COLUMN IF NOT EXISTS name_female_score REAL,   -- 0.0(남성형) ~ 1.0(여성형)
     ADD COLUMN IF NOT EXISTS name_is_name BOOLEAN;      -- 이름형 username 여부
   ```
2. **파이프라인** — 비공개 계정을 수집한 직후, 전체 username/full_name을 **한 번의 Gemini 배치 호출**로 판정(=병렬 효과, 계정당 개별 호출 금지). 결과 점수를 위 컬럼에 저장.
3. **결과 API** (`app/api/analysis/result/[requestId]/route.ts`, `app/api/share/[token]/route.ts`) — 정렬 추가:
   ```ts
   .from('private_accounts')
   .select('instagram_id, profile_image, full_name, name_female_score')
   .eq('request_id', requestId)
   .order('name_female_score', { ascending: false, nullsFirst: false });
   ```
   (프론트 `PrivateAccount` 타입엔 이미 `bio?`가 있고, 정렬만 반영하면 됨. bio 노출은 별도 후속.)
4. **모델/포맷** — 기존 `@google/genai` 클라이언트 + JSON 응답 모드. Gemini Flash 계열로 충분(단순 텍스트 분류, 저비용).

## Gemini 프롬프트

```text
당신은 인스타그램 계정의 사용자명(username)과 표시 이름(full_name)이라는 '텍스트'만 보고,
그 계정 주인이 여성일 가능성을 이름의 형태만으로 추정하는 한국어 온라인 네이밍 분석 전문가입니다.
사진·게시물·팔로워는 볼 수 없습니다. 오직 아래 텍스트만으로 판단하세요.

[판단 기준]
- 한국어 이름(예: 지민, 수현, 하은, 서연 = 여성형 / 민준, 도현, 성호 = 남성형)과
  영문 이름(예: suzy, jenny, yuna = 여성형 / minjun, jaehyun = 남성형)을 모두 고려합니다.
- username 안에 실제 이름이 섞여 있으면 그 이름을 우선합니다. (예: suzy_kim_02 → 여성형 'suzy')
- full_name이 있으면 username보다 신뢰도 높은 근거로 사용합니다.
- 브랜드/상점/사물/취미/무의미한 문자열 등 '사람 이름이 아닌' 경우 femaleScore=0.5, isName=false로 둡니다.
- 한쪽으로 단정하기 애매하면 0.5 근처 값과 낮은 confidence를 줍니다.

[출력]
아래 입력의 각 항목에 대해 JSON 배열로만 답하세요. 그 외 설명·마크다운 금지.
각 원소: { "id": string, "femaleScore": number(0.0~1.0), "isName": boolean, "confidence": number(0.0~1.0) }
- femaleScore: 0.0=남성 이름에 가까움, 1.0=여성 이름에 가까움, 0.5=중성/이름 아님
- 입력 순서와 개수를 그대로 유지합니다.

[입력]
{{JSON.stringify(accounts) 예:
[
  { "id": "acc_1", "username": "suzy_kim_02", "fullName": "김수지" },
  { "id": "acc_2", "username": "seoul_coffee_lab", "fullName": "" },
  { "id": "acc_3", "username": "minjun_1030", "fullName": "박민준" }
]
}}
```

**기대 출력 예:**
```json
[
  { "id": "acc_1", "femaleScore": 0.95, "isName": true, "confidence": 0.9 },
  { "id": "acc_2", "femaleScore": 0.5, "isName": false, "confidence": 0.8 },
  { "id": "acc_3", "femaleScore": 0.05, "isName": true, "confidence": 0.88 }
]
```

## 정렬 규칙
- 1차: `femaleScore` 내림차순(여성형 우선).
- 2차(동점): `confidence` 내림차순.
- `isName=false`(이름 아님)는 femaleScore 0.5로 중간에 모이며, 필요 시 리스트 하단으로 밀어도 됨.

## 주의
- 이름 기반 추정은 확률적이며 오류가 있을 수 있음(면책 문구 유지).
- 배치 호출로 비용/지연 최소화. 계정 수가 많으면 100개 단위 청크로 분할 호출.
