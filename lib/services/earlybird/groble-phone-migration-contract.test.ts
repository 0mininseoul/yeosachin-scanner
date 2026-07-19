import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migrationsDirectory = new URL('../../../supabase/migrations/', import.meta.url);
const MIGRATION_SUFFIXES = [
    'add_groble_phone_matching.sql',
    'activate_groble_phone_checkout.sql',
    'backfill_groble_phone_matching.sql',
    'validate_groble_phone_matching.sql',
    'activate_groble_phone_finalization.sql',
] as const;
const migrationFiles = readdirSync(migrationsDirectory)
    .filter(file => MIGRATION_SUFFIXES.some(suffix => file.endsWith(`_${suffix}`)))
    .sort();
const migrations = migrationFiles.map(file =>
    readFileSync(new URL(file, migrationsDirectory), 'utf8')
);

function migrationFor(suffix: typeof MIGRATION_SUFFIXES[number]): string {
    const index = migrationFiles.findIndex(file => file.endsWith(`_${suffix}`));
    return index >= 0 ? migrations[index] : '';
}

// 위 5개 rollout 파일과 달리 이 복구 migration 은 rollout 이후에 추가되므로 따로 읽는다.
const NORMALIZER_GRANT_SUFFIX =
    'restore_groble_phone_normalizer_service_role_execute.sql';
const normalizerGrantFile = readdirSync(migrationsDirectory)
    .filter(file => file.endsWith(`_${NORMALIZER_GRANT_SUFFIX}`))
    .sort()
    .at(-1) ?? '';
const normalizerGrantMigration = normalizerGrantFile
    ? readFileSync(new URL(normalizerGrantFile, migrationsDirectory), 'utf8')
    : '';

const ddlMigration = migrationFor('add_groble_phone_matching.sql');
const checkoutMigration = migrationFor('activate_groble_phone_checkout.sql');
const backfillMigration = migrationFor('backfill_groble_phone_matching.sql');
const validationMigration = migrationFor('validate_groble_phone_matching.sql');
const finalizationMigration = migrationFor('activate_groble_phone_finalization.sql');
const migration = migrations.join('\n');

const AUTHENTICATED_ORDER_COLUMNS = [
    'id',
    'user_id',
    'target_instagram_id',
    'plan_id',
    'actual_amount_krw',
    'status',
    'paid_at',
    'due_at',
    'plan_sequence',
    'result_request_id',
    'created_at',
];

function functionDefinition(name: string): string {
    return functionDefinitionIn(migration, name);
}

function functionDefinitionIn(source: string, name: string): string {
    const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    const end = source.indexOf('\n$$;', start);
    return start >= 0 && end >= 0 ? source.slice(start, end + 4) : '';
}

describe('Groble phone matching migration contract', () => {
    it('is five ordered forward migrations after the applied presale migration', () => {
        expect(migrationFiles.map(file => file.replace(/^\d+_/, ''))).toEqual(
            MIGRATION_SUFFIXES
        );
        for (const file of migrationFiles) {
            expect(file.localeCompare(
                '20260717140000_add_groble_earlybird_presale.sql'
            )).toBeGreaterThan(0);
        }
    });

    it('isolates DDL, checkout transition, backfill, validation/indexes, and finalization', () => {
        for (const source of migrations) {
            expect(source).toContain("SET LOCAL lock_timeout = '5s'");
            expect(source).toContain("SET LOCAL statement_timeout = '2min'");

            const addsColumnsOrConstraints = /^ALTER TABLE[\s\S]*?\bADD (?:COLUMN|CONSTRAINT)\b/m
                .test(source);
            const backfillsRows = /^UPDATE public\.(?:users|earlybird_orders)\b/m.test(source);
            expect(addsColumnsOrConstraints && backfillsRows).toBe(false);
        }

        expect(ddlMigration).toContain('ADD COLUMN phone_number_normalized TEXT');
        expect(ddlMigration).toContain('ADD COLUMN phone_number_verification_source TEXT');
        expect(ddlMigration).toContain('ADD COLUMN phone_number_verified_at TIMESTAMP WITH TIME ZONE');
        expect(ddlMigration).toContain("ADD COLUMN buyer_match_policy TEXT DEFAULT 'legacy_email'");
        expect(ddlMigration).toContain('ADD COLUMN expected_buyer_phone_verification_source TEXT');
        expect(ddlMigration).toContain('ADD COLUMN expected_buyer_phone_verified_at TIMESTAMP WITH TIME ZONE');
        expect(ddlMigration).toMatch(
            /ALTER COLUMN buyer_match_policy DROP DEFAULT/
        );
        expect(ddlMigration.match(/NOT VALID/g)).toHaveLength(11);
        expect(ddlMigration).toContain(
            'CREATE OR REPLACE FUNCTION public.normalize_kr_mobile_e164'
        );
        expect(ddlMigration).toContain(
            'CREATE OR REPLACE FUNCTION public.enforce_user_phone_verification_provenance'
        );
        expect(ddlMigration).toContain(
            'CREATE TRIGGER enforce_user_phone_verification_provenance_before_write'
        );
        expect(ddlMigration).toContain(
            'CREATE OR REPLACE FUNCTION public.set_earlybird_order_phone_snapshot'
        );
        expect(ddlMigration).toContain(
            'CREATE TRIGGER set_earlybird_order_phone_snapshot_before_insert'
        );
        expect(ddlMigration).toContain(
            'CREATE TRIGGER protect_earlybird_order_buyer_match_snapshot_before_update'
        );
        expect(ddlMigration).not.toMatch(/^UPDATE public\./m);
        expect(ddlMigration).not.toContain('DUPLICATE_NORMALIZED_PHONE_REQUIRES_REVIEW');
        expect(ddlMigration).not.toContain('VALIDATE CONSTRAINT');
        expect(ddlMigration).not.toMatch(/^CREATE (?:UNIQUE )?INDEX/m);
        expect(ddlMigration).toContain(
            'RENAME TO create_earlybird_checkout_before_product_fence'
        );
        expect(ddlMigration).toContain(
            'CREATE OR REPLACE FUNCTION public.create_earlybird_checkout'
        );

        expect(checkoutMigration).toContain(
            'CREATE OR REPLACE FUNCTION public.create_earlybird_checkout'
        );
        expect(checkoutMigration).toMatch(
            /SELECT buyer\.provider, buyer\.phone_number,[\s\S]*?buyer\.phone_number_normalized,[\s\S]*?buyer\.phone_number_verification_source,[\s\S]*?buyer\.phone_number_verified_at/
        );
        expect(checkoutMigration).not.toMatch(
            /COALESCE\([\s\S]*?public\.normalize_kr_mobile_e164\(v_user_phone_number\)/
        );
        expect(checkoutMigration).toContain("v_user_provider <> 'kakao'");
        expect(checkoutMigration).toContain(
            "IS DISTINCT FROM 'kakao_rest_api'"
        );
        expect(checkoutMigration).toContain(
            'v_user_phone_number_verified_at IS NULL'
        );
        expect(checkoutMigration).toContain(
            "< pg_catalog.clock_timestamp() - INTERVAL '24 hours'"
        );
        expect(checkoutMigration).toContain(
            'v_user_phone_number_normalized IS NULL'
        );
        expect(checkoutMigration).toMatch(
            /normalize_kr_mobile_e164\(v_user_phone_number\)[\s\S]*?IS DISTINCT FROM v_user_phone_number_normalized[\s\S]*?CHECKOUT_PHONE_REQUIRED/
        );
        expect(checkoutMigration).toMatch(
            /REVOKE ALL ON FUNCTION public\.create_earlybird_checkout\([\s\S]*?GRANT EXECUTE ON FUNCTION public\.create_earlybird_checkout\(/
        );
        expect(checkoutMigration).not.toMatch(/^ALTER TABLE/m);
        expect(checkoutMigration).not.toMatch(/^UPDATE public\./m);
        expect(checkoutMigration).not.toMatch(/^CREATE (?:UNIQUE )?INDEX/m);
        expect(checkoutMigration).not.toContain('finalize_earlybird_groble_payment');

        expect(backfillMigration.match(
            /^UPDATE public\.(?:users|earlybird_orders)\b/gm
        )).toHaveLength(1);
        expect(backfillMigration).toContain('DUPLICATE_NORMALIZED_PHONE_REQUIRES_REVIEW');
        expect(backfillMigration).not.toMatch(/^ALTER TABLE/m);
        expect(backfillMigration).not.toMatch(/^CREATE (?:OR REPLACE FUNCTION|(?:UNIQUE )?INDEX)/m);
        expect(backfillMigration).not.toMatch(/^(?:GRANT|REVOKE)\b/m);

        expect(validationMigration.match(/VALIDATE CONSTRAINT/g)).toHaveLength(11);
        expect(validationMigration.match(/^CREATE (?:UNIQUE )?INDEX/gm)).toHaveLength(3);
        expect(validationMigration).not.toContain('ADD COLUMN');
        expect(validationMigration).not.toContain('NOT VALID');
        expect(validationMigration).not.toMatch(/^UPDATE public\./m);
        expect(validationMigration).not.toContain('CREATE OR REPLACE FUNCTION');
        expect(validationMigration).not.toMatch(/^(?:GRANT|REVOKE)\b/m);

        expect(finalizationMigration).toContain(
            'CREATE OR REPLACE FUNCTION public.finalize_earlybird_groble_payment'
        );
        expect(finalizationMigration).toContain(
            'CREATE OR REPLACE FUNCTION public.set_earlybird_refund_status'
        );
        expect(finalizationMigration).toMatch(/^GRANT SELECT \(/m);
        expect(finalizationMigration).not.toContain(
            'CREATE OR REPLACE FUNCTION public.create_earlybird_checkout'
        );
        expect(finalizationMigration).not.toMatch(/^ALTER TABLE/m);
        expect(finalizationMigration).not.toMatch(/^UPDATE public\./m);
        expect(finalizationMigration).not.toMatch(/^CREATE (?:UNIQUE )?INDEX/m);
        expect(finalizationMigration).not.toContain('normalize_kr_mobile_e164');
    });

    it('requires atomic Kakao REST provenance for every normalized user phone', () => {
        expect(migration).toContain('ADD COLUMN phone_number_normalized TEXT');
        expect(migration).toContain('ADD COLUMN phone_number_verification_source TEXT');
        expect(migration).toContain('ADD COLUMN phone_number_verified_at TIMESTAMP WITH TIME ZONE');
        expect(migration).toMatch(
            /phone_number_normalized IS NULL\s+OR phone_number_normalized ~ '\^\\\+8210\[0-9\]\{8\}\$'/
        );
        expect(ddlMigration).toMatch(
            /phone_number_verification_source IS NULL\s+OR phone_number_verification_source = 'kakao_rest_api'/
        );
        expect(ddlMigration).toMatch(
            /phone_number_normalized IS NULL[\s\S]*?phone_number_verification_source IS NULL[\s\S]*?phone_number_verified_at IS NULL[\s\S]*?OR[\s\S]*?provider = 'kakao'[\s\S]*?phone_number IS NOT NULL[\s\S]*?phone_number_normalized IS NOT NULL[\s\S]*?phone_number_verification_source[\s\S]*?IS NOT DISTINCT FROM 'kakao_rest_api'[\s\S]*?phone_number_verified_at IS NOT NULL[\s\S]*?normalize_kr_mobile_e164\(phone_number\)[\s\S]*?IS NOT DISTINCT FROM phone_number_normalized/
        );
        expect(ddlMigration).toMatch(
            /users_phone_number_provenance_check[\s\S]*?phone_number_verification_source\s+IS NOT DISTINCT FROM 'kakao_rest_api'/
        );
        expect(migration).toMatch(
            /CREATE OR REPLACE FUNCTION public\.normalize_kr_mobile_e164\(p_value TEXT\)[\s\S]*?IMMUTABLE[\s\S]*?(?:STRICT|RETURNS NULL ON NULL INPUT)[\s\S]*?SET search_path = ''/
        );
        expect(migration).toMatch(
            /regexp_replace\(p_value, '\[\^0-9\]', '', 'g'\)[\s\S]*?\^010\[0-9\]\{8\}\$[\s\S]*?\^8210\[0-9\]\{8\}\$/
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.normalize_kr_mobile_e164\(TEXT\)\s+FROM PUBLIC, anon, authenticated, service_role/
        );

        const backfill = migration.indexOf('SET phone_number_normalized = NULL');
        const duplicateGuard = migration.indexOf('DUPLICATE_NORMALIZED_PHONE_REQUIRES_REVIEW');
        const uniqueIndex = migration.indexOf('CREATE UNIQUE INDEX users_phone_number_normalized_unique');
        expect(backfill).toBeGreaterThanOrEqual(0);
        expect(backfillMigration).toContain(
            'SET phone_number_normalized = NULL,'
        );
        expect(backfillMigration).toContain(
            'phone_number_verification_source = NULL,'
        );
        expect(backfillMigration).toContain('phone_number_verified_at = NULL');
        expect(backfillMigration).toContain(
            'phone_number_normalized IS NOT NULL'
        );
        expect(backfillMigration).toMatch(
            /phone_number_verification_source\s+IS NOT DISTINCT FROM 'kakao_rest_api'/
        );
        expect(backfillMigration).not.toMatch(
            /SET phone_number_normalized = COALESCE|normalize_kr_mobile_e164\(phone_number\),/
        );
        expect(duplicateGuard).toBeGreaterThan(backfill);
        expect(uniqueIndex).toBeGreaterThan(duplicateGuard);
        expect(migration).toMatch(
            /CREATE UNIQUE INDEX users_phone_number_normalized_unique\s+ON public\.users\(phone_number_normalized\)\s+WHERE phone_number_normalized IS NOT NULL/
        );
    });

    it('uses the database clock and degrades stale provenance from old raw-phone writers', () => {
        const definition = functionDefinition(
            'enforce_user_phone_verification_provenance'
        );

        expect(definition).toContain('pg_catalog.clock_timestamp()');
        expect(definition).toContain(
            'NEW.phone_number IS DISTINCT FROM OLD.phone_number'
        );
        expect(definition).toMatch(
            /NEW\.phone_number_verified_at[\s\S]*?IS NOT DISTINCT FROM OLD\.phone_number_verified_at/
        );
        expect(definition).toContain('NEW.phone_number_normalized := NULL');
        expect(definition).toContain(
            'NEW.phone_number_verification_source := NULL'
        );
        expect(definition).toContain('NEW.phone_number_verified_at := NULL');
        expect(ddlMigration).toMatch(
            /CREATE TRIGGER enforce_user_phone_verification_provenance_before_write\s+BEFORE INSERT OR UPDATE ON public\.users/
        );
        expect(ddlMigration).toMatch(
            /REVOKE ALL ON FUNCTION public\.enforce_user_phone_verification_provenance\(\)\s+FROM PUBLIC, anon, authenticated, service_role/
        );
    });

    it('installs a mandatory verified Kakao phone snapshot trigger in the fast DDL phase', () => {
        const triggerFunction = functionDefinition(
            'set_earlybird_order_phone_snapshot'
        );

        expect(triggerFunction).toMatch(
            /RETURNS TRIGGER[\s\S]*?LANGUAGE plpgsql[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = ''/
        );
        expect(triggerFunction).toContain('FROM public.users AS buyer');
        expect(triggerFunction).toContain('buyer.id = NEW.user_id');
        expect(triggerFunction).toContain("buyer.provider = 'kakao'");
        expect(triggerFunction).toContain(
            "buyer.phone_number_verification_source = 'kakao_rest_api'"
        );
        expect(triggerFunction).toContain(
            'buyer.phone_number_verified_at IS NOT NULL'
        );
        expect(triggerFunction).toMatch(
            /normalize_kr_mobile_e164\(buyer\.phone_number\)[\s\S]*?IS NOT DISTINCT FROM buyer\.phone_number_normalized/
        );
        expect(triggerFunction).toContain('SELECT buyer.phone_number_normalized');
        expect(triggerFunction).not.toContain('COALESCE(');
        expect(triggerFunction).toContain("NEW.buyer_match_policy := 'verified_kakao_phone'");
        expect(triggerFunction).toContain(
            'NEW.expected_buyer_phone_verification_source := v_phone_verification_source'
        );
        expect(triggerFunction).toContain(
            'NEW.expected_buyer_phone_verified_at := v_phone_verified_at'
        );
        expect(triggerFunction).toContain("RAISE EXCEPTION 'CHECKOUT_PHONE_REQUIRED'");
        expect(triggerFunction).toMatch(
            /buyer\.phone_number_verified_at\s+>= pg_catalog\.clock_timestamp\(\) - INTERVAL '24 hours'/
        );
        expect(ddlMigration).toMatch(
            /CREATE TRIGGER set_earlybird_order_phone_snapshot_before_insert\s+BEFORE INSERT ON public\.earlybird_orders\s+FOR EACH ROW\s+EXECUTE FUNCTION public\.set_earlybird_order_phone_snapshot\(\)/
        );
        expect(ddlMigration).toMatch(
            /REVOKE ALL ON FUNCTION public\.set_earlybird_order_phone_snapshot\(\)\s+FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(ddlMigration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.set_earlybird_order_phone_snapshot/
        );
        const immutableFunction = functionDefinition(
            'protect_earlybird_order_buyer_match_snapshot'
        );
        expect(immutableFunction).toMatch(
            /OLD\.buyer_match_policy[\s\S]*?NEW\.buyer_match_policy[\s\S]*?OLD\.expected_buyer_phone_number_normalized[\s\S]*?NEW\.expected_buyer_phone_number_normalized[\s\S]*?OLD\.expected_buyer_phone_verification_source[\s\S]*?NEW\.expected_buyer_phone_verification_source[\s\S]*?OLD\.expected_buyer_phone_verified_at[\s\S]*?NEW\.expected_buyer_phone_verified_at[\s\S]*?EARLYBIRD_BUYER_MATCH_SNAPSHOT_IMMUTABLE/
        );
    });

    it('shares one namespaced product fence in payment-product-user lock order', () => {
        const bridge = functionDefinitionIn(
            ddlMigration,
            'create_earlybird_checkout'
        );
        const trigger = functionDefinitionIn(
            ddlMigration,
            'set_earlybird_order_phone_snapshot'
        );
        const checkout = functionDefinitionIn(
            checkoutMigration,
            'create_earlybird_checkout'
        );
        const wrapperStart = finalizationMigration.lastIndexOf(
            'CREATE OR REPLACE FUNCTION public.finalize_earlybird_groble_payment('
        );
        const wrapperEnd = finalizationMigration.indexOf('\n$$;', wrapperStart);
        const wrapper = finalizationMigration.slice(wrapperStart, wrapperEnd + 4);
        const productNamespace = 'earlybird:groble:product:';

        for (const definition of [bridge, trigger, checkout, wrapper]) {
            expect(definition).toContain(productNamespace);
            expect(definition).toContain('pg_advisory_xact_lock');
            expect(definition).toContain('pg_catalog.hashtextextended');
        }

        const bridgeValidation = bridge.indexOf('EARLYBIRD_PRODUCT_INVALID');
        const bridgeProductLock = bridge.indexOf(productNamespace);
        const bridgeDelegate = bridge.indexOf(
            'create_earlybird_checkout_before_product_fence'
        );
        expect(bridgeValidation).toBeGreaterThanOrEqual(0);
        expect(bridgeProductLock).toBeGreaterThan(bridgeValidation);
        expect(bridgeDelegate).toBeGreaterThan(bridgeProductLock);

        const triggerProductLock = trigger.indexOf(productNamespace);
        const triggerSnapshotRead = trigger.indexOf(
            'FROM public.users AS buyer'
        );
        expect(triggerProductLock).toBeGreaterThanOrEqual(0);
        expect(triggerSnapshotRead).toBeGreaterThan(triggerProductLock);

        const checkoutValidation = checkout.indexOf('EARLYBIRD_PRODUCT_INVALID');
        const checkoutProductLock = checkout.indexOf(productNamespace);
        const checkoutUserLock = checkout.indexOf('p_user_id::TEXT');
        expect(checkoutProductLock).toBeGreaterThan(checkoutValidation);
        expect(checkoutUserLock).toBeGreaterThan(checkoutProductLock);

        const wrapperValidation = wrapper.indexOf(
            'GROBLE_PAYMENT_EVIDENCE_INVALID'
        );
        const wrapperPaymentLock = wrapper.indexOf(
            'pg_catalog.hashtextextended(p_payment_id, 0)'
        );
        const wrapperProductLock = wrapper.indexOf(productNamespace);
        const wrapperUserLock = wrapper.indexOf('FOR v_lock_user_id IN');
        const wrapperPaymentOwner = wrapper.indexOf(
            'payment_order.payment_id = p_payment_id'
        );
        const wrapperUserSort = wrapper.indexOf(
            'ORDER BY potential_user.user_id::TEXT'
        );
        const wrapperDuplicateRead = wrapper.indexOf(
            'FROM public.earlybird_webhook_events AS existing_event'
        );
        const wrapperCanonicalCall = wrapper.indexOf(
            'FROM public.finalize_earlybird_groble_payment(',
            wrapperDuplicateRead
        );
        expect(wrapperPaymentLock).toBeGreaterThan(wrapperValidation);
        expect(wrapperProductLock).toBeGreaterThan(wrapperPaymentLock);
        expect(wrapperUserLock).toBeGreaterThan(wrapperProductLock);
        expect(wrapperPaymentOwner).toBeGreaterThan(wrapperUserLock);
        expect(wrapperUserSort).toBeGreaterThan(wrapperPaymentOwner);
        expect(wrapperDuplicateRead).toBeGreaterThan(wrapperUserSort);
        expect(wrapperCanonicalCall).toBeGreaterThan(wrapperDuplicateRead);
    });

    it('rejects NULL event types in both finalizer overloads before lock derivation', () => {
        const canonical = functionDefinitionIn(
            finalizationMigration,
            'finalize_earlybird_groble_payment'
        );
        const wrapperStart = finalizationMigration.lastIndexOf(
            'CREATE OR REPLACE FUNCTION public.finalize_earlybird_groble_payment('
        );
        const wrapperEnd = finalizationMigration.indexOf('\n$$;', wrapperStart);
        const wrapper = finalizationMigration.slice(wrapperStart, wrapperEnd + 4);

        for (const definition of [canonical, wrapper]) {
            expect(definition).toContain(
                "p_event_type IS DISTINCT FROM 'payment.completed'"
            );
            expect(definition).not.toContain(
                "p_event_type <> 'payment.completed'"
            );
            expect(definition.indexOf('GROBLE_PAYMENT_EVIDENCE_INVALID'))
                .toBeLessThan(definition.indexOf('pg_advisory_xact_lock'));
        }
    });

    it('keeps the Phase 1 legacy checkout body internal until a post-drain migration', () => {
        expect(ddlMigration).toContain(
            'RENAME TO create_earlybird_checkout_before_product_fence'
        );
        expect(ddlMigration).toMatch(
            /REVOKE ALL ON FUNCTION public\.create_earlybird_checkout_before_product_fence\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role/
        );
        expect(ddlMigration).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.create_earlybird_checkout_before_product_fence/
        );
        expect(migration).not.toMatch(
            /DROP FUNCTION public\.create_earlybird_checkout_before_product_fence/
        );
        expect(ddlMigration).toMatch(/post-drain migration/i);
    });

    it('bounds migration locks and defers table scans until constraint validation', () => {
        expect(migration).not.toContain('LOCK TABLE public.users');
        expect(validationMigration).toMatch(/row-count[\s\S]*?maintenance window/i);
        expect(migration).not.toContain('CREATE INDEX CONCURRENTLY');
    });

    it('adds bounded service-only snapshots and rolling-deploy compatibility columns', () => {
        expect(migration).toContain('expected_buyer_phone_number_normalized TEXT');
        expect(migration).toContain('buyer_match_policy TEXT');
        expect(ddlMigration).toContain('buyer_match_policy IS NOT NULL');
        expect(ddlMigration).toMatch(
            /buyer_match_policy = 'verified_kakao_phone'[\s\S]*?expected_buyer_phone_verification_source\s+IS NOT DISTINCT FROM 'kakao_rest_api'/
        );
        expect(migration).toMatch(
            /buyer_match_policy = 'legacy_email'[\s\S]*?expected_buyer_phone_number_normalized IS NULL[\s\S]*?expected_buyer_phone_verification_source IS NULL[\s\S]*?expected_buyer_phone_verified_at IS NULL[\s\S]*?OR[\s\S]*?buyer_match_policy = 'verified_kakao_phone'[\s\S]*?expected_buyer_phone_number_normalized IS NOT NULL[\s\S]*?expected_buyer_phone_verification_source[\s\S]*?IS NOT DISTINCT FROM 'kakao_rest_api'[\s\S]*?expected_buyer_phone_verified_at IS NOT NULL/
        );
        for (const column of [
            'groble_buyer_email TEXT',
            'groble_buyer_phone_number TEXT',
            'groble_buyer_display_name TEXT',
        ]) {
            expect(migration.match(new RegExp(column, 'g'))).toHaveLength(2);
        }
        expect(migration).toMatch(/groble_buyer_email[\s\S]*?char_length\(groble_buyer_email\) <= 320/);
        expect(migration).toMatch(/groble_buyer_phone_number[\s\S]*?char_length\(groble_buyer_phone_number\) <= 64/);
        expect(migration).toMatch(/groble_buyer_display_name[\s\S]*?char_length\(groble_buyer_display_name\) <= 100/);
        expect(migration).toMatch(
            /CREATE INDEX earlybird_orders_pending_phone_product_idx[\s\S]*?expected_buyer_phone_number_normalized, expected_groble_product_id[\s\S]*?WHERE status = 'payment_pending'/
        );
        expect(backfillMigration).not.toMatch(/^UPDATE public\.earlybird_orders\b/m);
    });

    it('preserves the exact authenticated order grant and excludes service-only matching columns', () => {
        const grant = migration.match(
            /GRANT SELECT \(([\s\S]*?)\)\s+ON public\.earlybird_orders TO authenticated/
        )?.[1];
        expect(grant).toBeDefined();
        const grantedColumns = grant
            ?.split(',')
            .map(column => column.trim())
            .filter(Boolean);
        expect(grantedColumns).toEqual(AUTHENTICATED_ORDER_COLUMNS);
        expect(grant).not.toMatch(/groble_buyer|expected_buyer_phone|buyer_match_policy/);
        expect(migration).not.toMatch(
            /GRANT SELECT[^;]*(?:groble_buyer|expected_buyer_phone|buyer_match_policy)[^;]*;/
        );
        expect(migration).not.toMatch(/GRANT SELECT ON TABLE public\.earlybird_webhook_events/i);
    });

    it('keeps canonical and rolling-deploy finalizers search-path safe and service-only', () => {
        for (const functionName of [
            'create_earlybird_checkout',
            'finalize_earlybird_groble_payment',
        ]) {
            const definition = functionDefinition(functionName);
            expect(definition).toContain('SECURITY DEFINER');
            expect(definition).toContain("SET search_path = ''");
        }
        expect(migration).toContain("RAISE EXCEPTION 'CHECKOUT_PHONE_REQUIRED'");
        expect(migration).not.toMatch(/DROP FUNCTION public\.finalize_earlybird_groble_payment/);
        expect(migration.match(
            /CREATE OR REPLACE FUNCTION public\.finalize_earlybird_groble_payment\(/g
        )).toHaveLength(2);
        expect(migration).toMatch(
            /CREATE OR REPLACE FUNCTION public\.finalize_earlybird_groble_payment\([\s\S]*?p_buyer_email TEXT,[\s\S]*?p_buyer_phone_normalized TEXT,[\s\S]*?p_buyer_phone_raw TEXT,[\s\S]*?p_buyer_display_name TEXT,[\s\S]*?p_product_id TEXT/
        );
        expect(migration).toMatch(
            /CREATE OR REPLACE FUNCTION public\.finalize_earlybird_groble_payment\(\s*p_event_id TEXT,[\s\S]*?p_buyer_email TEXT,[\s\S]*?p_product_id TEXT,[\s\S]*?p_paid_at TIMESTAMP WITH TIME ZONE\s*\)[\s\S]*?LANGUAGE plpgsql[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = ''[\s\S]*?GROBLE_CANONICAL_PHONE_REQUIRED[\s\S]*?p_buyer_phone_normalized => NULL::TEXT[\s\S]*?p_buyer_phone_raw => NULL::TEXT[\s\S]*?p_buyer_display_name => NULL::TEXT/
        );
        expect(migration).toMatch(/post-drain migration/i);
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.create_earlybird_checkout\([\s\S]*?FROM PUBLIC, anon, authenticated/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.create_earlybird_checkout\([\s\S]*?TO service_role/
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.finalize_earlybird_groble_payment\([\s\S]*?FROM PUBLIC, anon, authenticated/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.finalize_earlybird_groble_payment\([\s\S]*?TO service_role/
        );
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.finalize_earlybird_groble_payment\(\s*TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, INTEGER,\s*TIMESTAMP WITH TIME ZONE\s*\) FROM PUBLIC, anon, authenticated/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.finalize_earlybird_groble_payment\(\s*TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE, TEXT, TEXT, TEXT, INTEGER,\s*TIMESTAMP WITH TIME ZONE\s*\) TO service_role/
        );
    });

    it('keeps matching contacts transaction-local in the fresh canonical finalizer', () => {
        const definition = functionDefinition('finalize_earlybird_groble_payment');

        expect(definition).toContain('p_buyer_email');
        expect(definition).toContain('p_buyer_phone_normalized');
        expect(definition).not.toContain('groble_buyer_email');
        expect(definition).not.toContain('groble_buyer_phone_number');
        expect(definition).not.toContain('groble_buyer_display_name');
    });

    it('uses immutable order policy snapshots and limits email fallback to legacy orders', () => {
        const definition = functionDefinition('finalize_earlybird_groble_payment');

        expect(definition).not.toMatch(
            /buyer\.phone_number_normalized\s*=\s*p_buyer_phone_normalized/
        );
        expect(definition).toContain(
            "candidate.buyer_match_policy = 'verified_kakao_phone'"
        );
        expect(definition).toMatch(
            /candidate\.expected_buyer_phone_verification_source[\s\S]*?= 'kakao_rest_api'/
        );
        expect(definition).toContain(
            'candidate.expected_buyer_phone_verified_at IS NOT NULL'
        );
        expect(definition).toMatch(
            /candidate\.expected_buyer_phone_number_normalized[\s\S]*?= p_buyer_phone_normalized/
        );
        expect(definition).toContain(
            "candidate.buyer_match_policy = 'legacy_email'"
        );
        expect(definition).toContain(
            'pg_catalog.lower(pg_catalog.btrim(buyer.email))'
        );
        expect(definition).toContain(
            'pg_catalog.lower(pg_catalog.btrim(p_buyer_email))'
        );
    });

    it('makes the rolling wrapper rollback instead of poisoning verified-order idempotency', () => {
        const wrapperStart = finalizationMigration.lastIndexOf(
            'CREATE OR REPLACE FUNCTION public.finalize_earlybird_groble_payment('
        );
        const wrapperEnd = finalizationMigration.indexOf('\n$$;', wrapperStart);
        const wrapper = finalizationMigration.slice(wrapperStart, wrapperEnd + 4);

        expect(wrapper).toContain('LANGUAGE plpgsql');
        const duplicateRead = wrapper.indexOf('earlybird_webhook_events');
        const wrapperLock = wrapper.indexOf('FOR v_lock_user_id IN');
        expect(duplicateRead).toBeGreaterThanOrEqual(0);
        expect(duplicateRead).toBeGreaterThan(wrapperLock);
        expect(wrapper.slice(duplicateRead)).toContain(
            'earlybird_orders'
        );
        expect(wrapper.slice(duplicateRead)).toContain(
            'payment_id = p_payment_id'
        );
        const lockQuery = wrapper.slice(wrapperLock, wrapper.indexOf('LOOP', wrapperLock));
        expect(lockQuery).toContain('public.earlybird_orders');
        expect(lockQuery).toContain(
            "buyer_match_policy = 'verified_kakao_phone'"
        );
        expect(lockQuery).toContain(
            'expected_groble_product_id = p_product_id'
        );
        expect(lockQuery).toContain('ORDER BY potential_user.user_id::TEXT');
        expect(wrapper).toMatch(
            /buyer_match_policy = 'verified_kakao_phone'[\s\S]*?GROBLE_CANONICAL_PHONE_REQUIRED/
        );
        const productWideGuard = wrapper.indexOf(
            "WHERE candidate.buyer_match_policy = 'verified_kakao_phone'",
            wrapperLock
        );
        const verifiedGuard = wrapper.slice(
            productWideGuard,
            wrapper.indexOf("RAISE EXCEPTION 'GROBLE_CANONICAL_PHONE_REQUIRED'")
        );
        expect(productWideGuard).toBeGreaterThan(wrapperLock);
        expect(verifiedGuard).not.toContain('expected_amount_krw');
        expect(verifiedGuard).not.toContain('buyer.email');
        expect(verifiedGuard).not.toContain('p_buyer_email');
        expect(wrapper).toMatch(
            /buyer_match_policy = 'legacy_email'/
        );
        expect(wrapper.indexOf('GROBLE_CANONICAL_PHONE_REQUIRED')).toBeLessThan(
            wrapper.indexOf('RETURN QUERY')
        );
    });

    it('counts same-user cancelled legacy candidates instead of choosing the latest', () => {
        const definition = functionDefinition('finalize_earlybird_groble_payment');
        const cancelledFallback = definition.indexOf(
            'IF v_candidate_count = 0 THEN'
        );
        const cancelledLegacyStart = definition.indexOf(
            'SELECT pg_catalog.count(*)::INTEGER',
            cancelledFallback
        );
        const cancelledLegacyEnd = definition.indexOf(
            "p_amount_krw, 'unmatched'",
            cancelledLegacyStart
        );
        const cancelledLegacy = definition.slice(
            cancelledLegacyStart,
            cancelledLegacyEnd
        );

        expect(cancelledFallback).toBeGreaterThanOrEqual(0);
        expect(cancelledLegacyStart).toBeGreaterThan(cancelledFallback);
        expect(cancelledLegacy).toContain('pg_catalog.count(*)::INTEGER');
        expect(cancelledLegacy).toContain("'ambiguous_buyer'");
        expect(cancelledLegacy).not.toContain(
            'ORDER BY cancelled_order.updated_at DESC'
        );
        expect(cancelledLegacy).not.toContain('LIMIT 1');
    });

    it('locks every potential user deterministically before authoritative matching', () => {
        const definition = functionDefinition('finalize_earlybird_groble_payment');
        const lockLoop = definition.indexOf('FOR v_lock_user_id IN');
        const firstCandidateCount = definition.indexOf('INTO v_candidate_count');

        expect(lockLoop).toBeGreaterThanOrEqual(0);
        expect(definition).toContain('ORDER BY potential_user.user_id::TEXT');
        expect(definition).toContain(
            "phone_order.buyer_match_policy = 'verified_kakao_phone'"
        );
        expect(definition).toContain(
            "phone_order.expected_buyer_phone_verification_source"
        );
        expect(definition).toContain(
            'phone_order.expected_buyer_phone_verified_at IS NOT NULL'
        );
        expect(definition).toContain(
            'phone_order.expected_buyer_phone_number_normalized'
        );
        expect(definition).toContain('UNION');
        expect(definition).toContain(
            'pg_catalog.lower(pg_catalog.btrim(buyer.email))'
        );
        expect(definition).not.toMatch(
            /buyer\.phone_number_normalized = p_buyer_phone_normalized/
        );
        expect(definition.match(
            /expected_buyer_phone_verification_source\s*= 'kakao_rest_api'/g
        )?.length)
            .toBeGreaterThanOrEqual(6);
        expect(firstCandidateCount).toBeGreaterThan(lockLoop);
    });

    it('serializes profile snapshots and refund transitions with the user lock', () => {
        const checkout = functionDefinitionIn(
            checkoutMigration,
            'create_earlybird_checkout'
        );
        expect(checkout).toMatch(
            /SELECT buyer\.provider, buyer\.phone_number, buyer\.phone_number_normalized,[\s\S]*?buyer\.phone_number_verification_source,[\s\S]*?buyer\.phone_number_verified_at[\s\S]*?WHERE buyer\.id = p_user_id\s+FOR UPDATE/
        );

        const refund = functionDefinition('set_earlybird_refund_status');
        const userDiscovery = refund.indexOf('SELECT earlybird_order.user_id');
        const userLock = refund.indexOf('pg_advisory_xact_lock');
        const orderLock = refund.indexOf('FOR UPDATE');
        expect(refund).toContain('SECURITY DEFINER');
        expect(refund).toContain("SET search_path = ''");
        expect(userDiscovery).toBeGreaterThanOrEqual(0);
        expect(userLock).toBeGreaterThan(userDiscovery);
        expect(orderLock).toBeGreaterThan(userLock);
        expect(migration).toMatch(
            /REVOKE ALL ON FUNCTION public\.set_earlybird_refund_status\(UUID, TEXT\)[\s\S]*?FROM PUBLIC, anon, authenticated/
        );
        expect(migration).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.set_earlybird_refund_status\(UUID, TEXT\)[\s\S]*?TO service_role/
        );
    });
});

// `users_phone_number_provenance_check` 는 normalize_kr_mobile_e164 를 호출한다.
// CHECK 제약은 SECURITY DEFINER 가 아니라 DML 을 실행한 role 로 평가되므로,
// service_role 에서 EXECUTE 를 회수하면 /auth/callback 의 service-role users upsert 가
// 42501 로 실패한다. 이 복구 migration 은 그 EXECUTE 만 되돌린다.
describe('Groble phone normalizer service-role execute restore contract', () => {
    function executableStatements(source: string): string[] {
        return source
            .split('\n')
            .map(line => line.replace(/--.*$/, '').trim())
            .join(' ')
            .split(';')
            .map(statement => statement.replace(/\s+/g, ' ').trim())
            .filter(Boolean);
    }

    it('adds one forward migration ordered after the completed phone rollout', () => {
        expect(normalizerGrantFile).not.toBe('');
        expect(normalizerGrantFile).toMatch(
            new RegExp(`^\\d{14}_${NORMALIZER_GRANT_SUFFIX.replace(/\./g, '\\.')}$`)
        );
        expect(normalizerGrantFile.localeCompare(
            '20260719131500_stop_persisting_groble_buyer_contacts.sql'
        )).toBeGreaterThan(0);
        expect(normalizerGrantFile.localeCompare(
            '20260719160000_add_landing_leads.sql'
        )).toBeGreaterThan(0);
    });

    it('bounds its locks like every other phone migration', () => {
        expect(normalizerGrantMigration).toContain("SET LOCAL lock_timeout = '5s'");
        expect(normalizerGrantMigration).toContain(
            "SET LOCAL statement_timeout = '2min'"
        );
    });

    it('restores execute to service_role and nothing else', () => {
        expect(executableStatements(normalizerGrantMigration)).toEqual([
            "SET LOCAL lock_timeout = '5s'",
            "SET LOCAL statement_timeout = '2min'",
            'GRANT EXECUTE ON FUNCTION public.normalize_kr_mobile_e164(TEXT) TO service_role',
        ]);
    });

    it('never widens the normalizer to PUBLIC, anon, or authenticated', () => {
        for (const grantee of ['PUBLIC', 'anon', 'authenticated']) {
            expect(normalizerGrantMigration).not.toMatch(
                new RegExp(`GRANT[\\s\\S]*?\\b${grantee}\\b`)
            );
        }
    });

    it('carries no schema change, backfill, or function redefinition', () => {
        for (const forbidden of [
            'ALTER TABLE',
            'ALTER FUNCTION',
            'UPDATE public.',
            'INSERT INTO',
            'DELETE FROM',
            'CREATE OR REPLACE FUNCTION',
            'DROP FUNCTION',
            'CREATE TRIGGER',
            'DROP TRIGGER',
            'VALIDATE CONSTRAINT',
            'CREATE INDEX',
            'CREATE UNIQUE INDEX',
            'REVOKE',
        ]) {
            expect(normalizerGrantMigration).not.toContain(forbidden);
        }
    });

    it('keeps the original rollout revoke intact so the history stays forward-only', () => {
        expect(ddlMigration).toMatch(
            /REVOKE ALL ON FUNCTION public\.normalize_kr_mobile_e164\(TEXT\)\s+FROM PUBLIC, anon, authenticated, service_role/
        );
    });

    // 계약을 파일 하나에만 걸면 나중 migration 이 조용히 다시 회수해도 통과한다.
    // 디렉터리 전체에서 rollout 이후의 net ACL 을 확인한다.
    it('is the last word on the normalizer ACL across every later migration', () => {
        const laterRevokes = readdirSync(migrationsDirectory)
            .filter(file => /^\d{14}_.*\.sql$/.test(file))
            .filter(file => file.localeCompare(
                '20260719131000_add_groble_phone_matching.sql'
            ) > 0)
            .filter(file => {
                const source = readFileSync(
                    new URL(file, migrationsDirectory),
                    'utf8'
                );
                return /REVOKE[\s\S]{0,200}?normalize_kr_mobile_e164/.test(source);
            });

        expect(laterRevokes).toEqual([]);
    });
});
