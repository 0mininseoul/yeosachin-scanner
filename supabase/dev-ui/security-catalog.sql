-- Metadata only: isolates security and Realtime attributes from deparsed SQL.
SET search_path = pg_catalog;
WITH definitions AS (
  SELECT 'relation_security'::text AS kind, n.nspname || '.' || c.relname AS name,
    jsonb_build_object(
      'owner', pg_get_userbyid(c.relowner), 'rls', c.relrowsecurity,
      'forceRls', c.relforcerowsecurity, 'replicaIdentity', c.relreplident,
      'acl', (SELECT jsonb_agg(jsonb_build_object(
        'grantee', CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
        'grantor', pg_get_userbyid(x.grantor), 'privilege', x.privilege_type,
        'grantable', x.is_grantable
      ) ORDER BY x.grantee::regrole::text,x.privilege_type,x.is_grantable)
      FROM aclexplode(COALESCE(c.relacl,acldefault(
        CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) x),
      'columnAcls', (SELECT jsonb_agg(jsonb_build_object(
        'column', a.attname, 'acl', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'grantee', CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
          'grantor', pg_get_userbyid(x.grantor), 'privilege', x.privilege_type,
          'grantable', x.is_grantable
        ) ORDER BY x.grantee::regrole::text,x.privilege_type,x.is_grantable),'[]'::jsonb)
        FROM aclexplode(a.attacl) x)
      ) ORDER BY a.attnum) FROM pg_attribute a
      WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)
    )::text AS definition
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p','v','m','S')
  UNION ALL
  SELECT 'relation_shape', n.nspname || '.' || c.relname,
    jsonb_build_object('kind',c.relkind,'options',COALESCE(c.reloptions,ARRAY[]::text[]),
      'columns',(SELECT jsonb_agg(jsonb_build_object(
        'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
        'notNull',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,
        'default',pg_get_expr(d.adbin,d.adrelid),
        'collation',CASE WHEN a.attcollation=0 THEN NULL ELSE a.attcollation::regcollation::text END
      ) ORDER BY a.attnum) FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped))::text
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p','v','m','S')
  UNION ALL
  SELECT 'constraint_state', n.nspname || '.' || c.relname || '.' || k.conname,
    jsonb_build_object('type',k.contype,'validated',k.convalidated,
      'deferrable',k.condeferrable,'deferred',k.condeferred,
      'noInherit',k.connoinherit,'local',k.conislocal,'inheritCount',k.coninhcount)::text
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','private')
  UNION ALL
  SELECT 'index_state', n.nspname || '.' || c.relname,
    jsonb_build_object('owner',pg_get_userbyid(c.relowner),
      'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,
      'unique',i.indisunique,'primary',i.indisprimary,'immediate',i.indimmediate,
      'exclusion',i.indisexclusion,'nullsNotDistinct',i.indnullsnotdistinct,
      'replicaIdentity',i.indisreplident,'clustered',i.indisclustered)::text
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','private')
  UNION ALL
  SELECT 'function_security', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
    jsonb_build_object('owner', pg_get_userbyid(p.proowner),
      'securityDefiner',p.prosecdef,'config',p.proconfig,
      'acl', (SELECT jsonb_agg(jsonb_build_object(
        'grantee', CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
        'grantor', pg_get_userbyid(x.grantor), 'privilege', x.privilege_type,
        'grantable', x.is_grantable
      ) ORDER BY x.grantee::regrole::text,x.privilege_type,x.is_grantable)
      FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) x))::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname IN ('public','private') AND p.prokind IN ('f','p')
  UNION ALL
  SELECT 'function_shape', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
    jsonb_build_object('arguments',pg_get_function_arguments(p.oid),
      'result',pg_get_function_result(p.oid),'language',l.lanname,
      'kind',p.prokind,'returnsSet',p.proretset,'volatility',p.provolatile,
      'strict',p.proisstrict,'parallel',p.proparallel,'leakproof',p.proleakproof,
      'cost',p.procost,'rows',p.prorows,'support',p.prosupport::text,
      'argumentNames',p.proargnames,'argumentModes',p.proargmodes,
      'argumentCount',p.pronargs,'defaultArgumentCount',p.pronargdefaults,
      'binary',p.probin)::text
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_language l ON l.oid=p.prolang
    WHERE n.nspname IN ('public','private') AND p.prokind IN ('f','p')
  UNION ALL
  SELECT 'default_acl', pg_get_userbyid(d.defaclrole) || '.' || COALESCE(n.nspname,'GLOBAL') || '.' || d.defaclobjtype::text,
    (SELECT jsonb_agg(jsonb_build_object(
      'grantee', CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
      'grantor', pg_get_userbyid(x.grantor), 'privilege', x.privilege_type,
      'grantable', x.is_grantable
    ) ORDER BY x.grantee::regrole::text,x.privilege_type,x.is_grantable)
    FROM aclexplode(d.defaclacl) x)::text
    FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
    WHERE d.defaclnamespace=0 OR n.nspname IN ('public','private')
  UNION ALL
  SELECT 'publication_configuration', p.pubname,
    jsonb_build_object('owner',pg_get_userbyid(p.pubowner),'allTables',p.puballtables,
      'insert',p.pubinsert,'update',p.pubupdate,'delete',p.pubdelete,
      'truncate',p.pubtruncate,'viaPartitionRoot',p.pubviaroot)::text
    FROM pg_publication p WHERE EXISTS (
      SELECT 1 FROM pg_publication_tables t
      WHERE t.pubname=p.pubname AND t.schemaname IN ('public','private'))
)
SELECT COALESCE(jsonb_agg(jsonb_build_object('kind',kind,'name',name,
  'sha256',encode(extensions.digest(definition,'sha256'),'hex')) ORDER BY kind,name),'[]'::jsonb) AS catalog
FROM definitions;
