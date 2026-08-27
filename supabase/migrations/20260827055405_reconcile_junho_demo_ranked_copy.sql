-- One-shot, forward-only correction for the already-published synthetic v2
-- fixture. This intentionally has no reusable RPC or dashboard write path.
-- The immutable-row trigger is disabled only around the single guarded UPDATE
-- and is restored before the migration finishes. Supabase runs migrations in
-- a transaction, so any failed guard rolls back both the data and trigger DDL.
DO $$
DECLARE
    v_current_payload JSONB;
    v_new_payload JSONB;
    v_actual_identities JSONB;
    v_expected_identities CONSTANT JSONB := '[
        {"instagramId":"violet.library","fullName":"류하늘"},
        {"instagramId":"dawn.garden","fullName":"김여울"},
        {"instagramId":"copper.postcard","fullName":"강새봄"},
        {"instagramId":"canvas.picnic","fullName":"한나래"},
        {"instagramId":"pocket.letter","fullName":"황마루"},
        {"instagramId":"horizon.window","fullName":"차라온"},
        {"instagramId":"tangerine.notebook","fullName":"박다온"},
        {"instagramId":"paper.weather","fullName":"윤가람"},
        {"instagramId":"porch.archive","fullName":"서이든"},
        {"instagramId":"mellow.terrace","fullName":"송누리"}
    ]'::JSONB;
    v_new_overviews CONSTANT TEXT[] := ARRAY[
        '류하늘님, 보랏빛 도서관을 자처하는 이름에 최근 맞팔 최전선까지 겹치니 감성 서재인지 비밀 회의실인지 알리바이가 제법 치밀하군요.',
        '김여울님, 새벽 정원 같은 고요함을 두른 채 최근 맞팔 앞줄에 서 있으니 산책 기록인지 야간 작전 브리핑인지 레이더가 먼저 켜집니다.',
        '강새봄님, 구리빛 엽서 한 장 같은 분위기로 최근 맞팔 상단에 올라와 우편함보다 비밀 연락망이 먼저 떠오릅니다.',
        '한나래님, 캔버스와 피크닉을 펼친 평온한 무드인데 최근 맞팔 상위권에 걸리니 소풍인지 위장 회의인지 돗자리를 다시 보게 됩니다.',
        '황마루님, 주머니 속 편지 같은 이름으로 최근 맞팔 앞쪽에 보여 봉투보다 알리바이가 먼저 열리는군요.',
        '차라온님, 지평선 창문을 열어둔 듯한 이름인데 최근 맞팔 목록 전면에 보여 전망대인지 관측소인지 경계가 흐려집니다.',
        '박다온님, 귤빛 공책을 펼친 듯한 이름으로 최근 맞팔 상단권에 포착돼 일기장인지 작전 노트인지 형광펜이 괜히 바빠집니다.',
        '윤가람님, 종이와 날씨를 적어둔 듯한 이름인데 최근 맞팔 앞줄에 보여 기상일지인지 분위기 조작 보고서인지 흐릿합니다.',
        '서이든님, 현관 아카이브를 연상시키는 이름으로 최근 맞팔 첫머리에 놓여 출입대장까지 상상하게 합니다.',
        '송누리님, 느긋한 테라스라는 이름과 달리 최근 맞팔 상위 줄에 보여 휴식처인지 은밀한 관측소인지 의심이 커집니다.'
    ];
    v_new_narrative CONSTANT JSONB := to_jsonb(ARRAY[
        '류하늘님은 보랏빛 도서관 같은 이름과 최근 맞팔 최전선의 위치가 겹치며, 평온한 서사 뒤에 별도 회의실 하나쯤 숨겨둔 듯한 인상을 남깁니다.',
        '류하늘님이 김도윤님 게시물에 남긴 좋아요와 댓글은 수집 범위에서 확인된 신호라 결정적 단서는 아니지만, 이 흔적은 우연치고는 알리바이가 제법 친절합니다.'
    ]::TEXT[]);
    v_expected_old_fingerprint CONSTANT TEXT := '02be7948243e998779f36a286f9aba6c';
    v_expected_new_fingerprint CONSTANT TEXT := '1356c7136125f4ec664e1fb33da96664';
    v_row_count INTEGER;
    v_index INTEGER;
BEGIN
    SELECT fixture.payload
    INTO v_current_payload
    FROM public.demo_analysis_fixtures AS fixture
    WHERE fixture.version = 'operator-editable-fixture-v2'
      AND fixture.status = 'published'
    FOR UPDATE;

    IF v_current_payload IS NULL THEN
        RAISE EXCEPTION 'junho_dem demo copy correction requires one published v2 fixture';
    END IF;

    -- A second exact replay is a safe no-op. Any other non-old payload fails.
    IF md5(v_current_payload::TEXT) = v_expected_new_fingerprint THEN
        RETURN;
    END IF;
    IF md5(v_current_payload::TEXT) <> v_expected_old_fingerprint THEN
        RAISE EXCEPTION 'junho_dem demo copy correction payload fingerprint drifted';
    END IF;

    IF v_current_payload->'target'->>'username' <> 'junho_dem'
       OR v_current_payload->'summary'->>'targetInstagramId' <> 'junho_dem'
       OR v_current_payload->'summary'->>'targetFullName' <> '김도윤'
       OR v_current_payload->'summary'->>'planId' <> 'standard'
       OR v_current_payload->'summary'->>'detectedMutuals' <> '313'
       OR v_current_payload->'summary'->>'publicMutuals' <> '168'
       OR v_current_payload->'summary'->>'privateMutuals' <> '145'
       OR jsonb_array_length(v_current_payload->'public') <> 84
       OR jsonb_array_length(v_current_payload->'private') <> 145 THEN
        RAISE EXCEPTION 'junho_dem demo copy correction identity or aggregate guard failed';
    END IF;

    SELECT jsonb_agg(
        jsonb_build_object(
            'instagramId', account.value->>'instagramId',
            'fullName', account.value->>'fullName'
        ) ORDER BY account.ordinality
    )
    INTO v_actual_identities
    FROM jsonb_array_elements(v_current_payload->'public') WITH ORDINALITY AS account(value, ordinality)
    WHERE account.ordinality <= 10;
    IF v_actual_identities IS DISTINCT FROM v_expected_identities THEN
        RAISE EXCEPTION 'junho_dem demo copy correction ranked identity guard failed';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_current_payload->'public') WITH ORDINALITY AS account(value, ordinality)
        WHERE account.ordinality <= 10
          AND account.value->>'oneLineOverview' <> '공개 범위에서 최근 좋아요와 댓글 흐름을 함께 확인했습니다. 수집 범위 밖의 맥락은 포함하지 않아 단정할 수 없습니다.'
    ) OR v_current_payload->'public'->0->'highRiskNarrative' IS DISTINCT FROM to_jsonb(ARRAY[
        '공개 범위에서 최근 맞팔 흐름과 프로필 정보를 함께 확인했습니다.',
        '좋아요와 댓글 등 공개 상호작용은 수집 범위 밖의 맥락을 담지 않으므로 관계나 의도를 단정할 수 없습니다.'
    ]::TEXT[]) THEN
        RAISE EXCEPTION 'junho_dem demo copy correction source copy guard failed';
    END IF;

    v_new_payload := v_current_payload;
    FOR v_index IN 1..10 LOOP
        v_new_payload := jsonb_set(
            v_new_payload,
            ARRAY['public', (v_index - 1)::TEXT, 'oneLineOverview'],
            to_jsonb(v_new_overviews[v_index]),
            FALSE
        );
    END LOOP;
    v_new_payload := jsonb_set(v_new_payload, ARRAY['public', '0', 'highRiskNarrative'], v_new_narrative, FALSE);

    IF md5(v_new_payload::TEXT) <> v_expected_new_fingerprint THEN
        RAISE EXCEPTION 'junho_dem demo copy correction target fingerprint is invalid';
    END IF;

    ALTER TABLE public.demo_analysis_fixtures DISABLE TRIGGER prevent_immutable_demo_analysis_fixture;
    UPDATE public.demo_analysis_fixtures AS fixture
    SET payload = v_new_payload
    WHERE fixture.version = 'operator-editable-fixture-v2'
      AND fixture.status = 'published'
      AND md5(fixture.payload::TEXT) = v_expected_old_fingerprint;
    GET DIAGNOSTICS v_row_count = ROW_COUNT;
    ALTER TABLE public.demo_analysis_fixtures ENABLE TRIGGER prevent_immutable_demo_analysis_fixture;

    IF v_row_count <> 1 THEN
        RAISE EXCEPTION 'junho_dem demo copy correction compare-and-set updated % rows', v_row_count;
    END IF;
END;
$$;
