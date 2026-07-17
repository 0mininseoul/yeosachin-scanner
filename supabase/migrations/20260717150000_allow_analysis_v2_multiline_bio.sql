-- Keep profile bios multiline while rejecting control characters other than CR and LF.
-- Names and public result copy remain single-line.

ALTER TABLE public.analysis_v2_candidate_feature_rows
    DROP CONSTRAINT analysis_v2_candidate_feature_text_check;
ALTER TABLE public.analysis_v2_candidate_feature_rows
    ADD CONSTRAINT analysis_v2_candidate_feature_text_check CHECK (
        (full_name IS NULL OR (
            pg_catalog.char_length(full_name) BETWEEN 1 AND 200
            AND full_name !~ '[[:cntrl:]]'
        ))
        AND (
            bio IS NULL
            OR pg_catalog.translate(
                bio,
                pg_catalog.chr(10) || pg_catalog.chr(13),
                ''
            ) !~ '[[:cntrl:]]'
        )
        AND public.analysis_v2_result_valid_image_path(profile_image_url)
    );

ALTER TABLE public.analysis_v2_female_results
    DROP CONSTRAINT analysis_v2_female_result_text_check;
ALTER TABLE public.analysis_v2_female_results
    ADD CONSTRAINT analysis_v2_female_result_text_check CHECK (
        (full_name IS NULL OR (
            pg_catalog.char_length(full_name) BETWEEN 1 AND 200
            AND full_name !~ '[[:cntrl:]]'
        ))
        AND (
            bio IS NULL
            OR pg_catalog.translate(
                bio,
                pg_catalog.chr(10) || pg_catalog.chr(13),
                ''
            ) !~ '[[:cntrl:]]'
        )
        AND public.analysis_v2_result_valid_image_path(profile_image_url)
        AND public.analysis_v2_result_valid_public_copy(one_line_overview, 180)
    );

DO $migration$
DECLARE
    v_definition TEXT;
    v_validation_old TEXT := $validation_old$               OR pg_catalog.jsonb_typeof(item.value->'bio') NOT IN ('string', 'null')$validation_old$;
    v_validation_new TEXT := $validation_new$               OR pg_catalog.jsonb_typeof(item.value->'bio') NOT IN ('string', 'null')
               OR (
                    pg_catalog.jsonb_typeof(item.value->'fullName') = 'string'
                    AND item.value->>'fullName' <> ''
                    AND (
                        pg_catalog.char_length(item.value->>'fullName') NOT BETWEEN 1 AND 200
                        OR item.value->>'fullName' ~ '[[:cntrl:]]'
                    )
               )
               OR (
                    pg_catalog.jsonb_typeof(item.value->'bio') = 'string'
                    AND (
                        pg_catalog.char_length(item.value->>'bio') > 2200
                        OR pg_catalog.translate(
                            item.value->>'bio',
                            pg_catalog.chr(10) || pg_catalog.chr(13),
                            ''
                        ) ~ '[[:cntrl:]]'
                    )
               )$validation_new$;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.analysis_v2_checkpoint_candidate_features_complete(uuid,text,uuid,text,integer,integer,jsonb)'
            ::pg_catalog.regprocedure
    ) INTO v_definition;
    IF pg_catalog.strpos(v_definition, v_validation_old) = 0
       OR pg_catalog.strpos(
            pg_catalog.substr(
                v_definition,
                pg_catalog.strpos(v_definition, v_validation_old)
                    + pg_catalog.char_length(v_validation_old)
            ),
            v_validation_old
       ) > 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_BIO_CHECKPOINT_MIGRATION_DRIFT',
            ERRCODE = 'P0001';
    END IF;
    EXECUTE pg_catalog.replace(v_definition, v_validation_old, v_validation_new);
END;
$migration$;
