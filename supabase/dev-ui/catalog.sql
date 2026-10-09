-- Metadata only. Fixed search_path makes deparsed definitions comparable.
SET search_path = pg_catalog;
WITH object_definitions AS (
    SELECT 'relation'::text AS kind, n.nspname || '.' || c.relname AS name,
      jsonb_build_object(
        'kind', c.relkind, 'owner', pg_get_userbyid(c.relowner),
        'rls', c.relrowsecurity, 'forceRls', c.relforcerowsecurity,
        'options', COALESCE(c.reloptions, ARRAY[]::text[]),
        'columns', (SELECT jsonb_agg(jsonb_build_object(
          'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
          'notNull', a.attnotnull, 'identity', a.attidentity, 'generated', a.attgenerated,
          'default', pg_get_expr(d.adbin, d.adrelid),
          'collation', CASE WHEN a.attcollation = 0 THEN NULL ELSE a.attcollation::regcollation::text END,
          'acl', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
            'grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
            'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable
          ) ORDER BY x.grantee::regrole::text,x.privilege_type,x.is_grantable),'[]'::jsonb) FROM aclexplode(a.attacl) x)
        ) ORDER BY a.attnum) FROM pg_attribute a
          LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
          WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
        'view', CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid, false) ELSE NULL END,
        'acl', (SELECT jsonb_agg(jsonb_build_object(
          'grantee', CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
          'grantor', pg_get_userbyid(x.grantor), 'privilege', x.privilege_type, 'grantable', x.is_grantable
        ) ORDER BY x.grantee::regrole::text, x.privilege_type, x.is_grantable)
          FROM aclexplode(COALESCE(c.relacl, acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) x)
      )::text AS definition
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p','v','m','S')
    UNION ALL
    SELECT 'constraint', n.nspname || '.' || c.relname || '.' || k.conname,
      jsonb_build_object('definition',pg_get_constraintdef(k.oid,false),'validated',k.convalidated)::text
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','private')
    UNION ALL
    SELECT 'index', n.nspname || '.' || c.relname,
      jsonb_build_object('definition',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid,'ready',i.indisready)::text
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','private')
    UNION ALL
    SELECT 'function', n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
      jsonb_build_object('definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),
        'acl',(SELECT jsonb_agg(jsonb_build_object(
          'grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
          'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable
        ) ORDER BY x.grantee::regrole::text,x.privilege_type,x.is_grantable)
          FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) x))::text
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname IN ('public','private') AND p.prokind IN ('f','p')
    UNION ALL
    SELECT 'policy', n.nspname || '.' || c.relname || '.' || p.polname,
      jsonb_build_object('command',p.polcmd,'permissive',p.polpermissive,
        'roles',(SELECT jsonb_agg(CASE WHEN role_oid=0 THEN 'PUBLIC' ELSE pg_get_userbyid(role_oid) END ORDER BY role_oid::regrole::text)
          FROM unnest(p.polroles) role_oid),
        'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid))::text
      FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','private','storage')
    UNION ALL
    SELECT 'trigger', n.nspname || '.' || c.relname || '.' || t.tgname,
      jsonb_build_object('definition',pg_get_triggerdef(t.oid,false),'enabled',t.tgenabled)::text
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE NOT t.tgisinternal AND n.nspname IN ('public','private','auth','storage')
    UNION ALL
    SELECT 'enum', n.nspname || '.' || t.typname,
      (SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid=t.oid)::text
      FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname IN ('public','private') AND t.typtype='e'
    UNION ALL
    SELECT 'domain', n.nspname || '.' || t.typname,
      jsonb_build_object('base',format_type(t.typbasetype,t.typtypmod),'notNull',t.typnotnull,'default',t.typdefault)::text
      FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname IN ('public','private') AND t.typtype='d'
    UNION ALL
    SELECT 'composite', n.nspname || '.' || t.typname,
      (SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod)) ORDER BY a.attnum)
        FROM pg_attribute a WHERE a.attrelid=t.typrelid AND a.attnum>0 AND NOT a.attisdropped)::text
      FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_class c ON c.oid=t.typrelid
      WHERE n.nspname IN ('public','private') AND t.typtype='c' AND c.relkind='c'
    UNION ALL
    SELECT 'type_acl', n.nspname || '.' || t.typname,
      (SELECT jsonb_agg(jsonb_build_object(
        'grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
        'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable
      ) ORDER BY x.grantee::regrole::text,x.privilege_type,x.is_grantable)
        FROM aclexplode(COALESCE(t.typacl,acldefault('T',t.typowner))) x)::text
      FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace LEFT JOIN pg_class c ON c.oid=t.typrelid
      WHERE n.nspname IN ('public','private') AND (t.typtype IN ('e','d') OR (t.typtype='c' AND c.relkind='c'))
    UNION ALL
    SELECT 'domain_constraint', n.nspname || '.' || t.typname || '.' || k.conname,
      jsonb_build_object('definition',pg_get_constraintdef(k.oid,false),'validated',k.convalidated)::text
      FROM pg_constraint k JOIN pg_type t ON t.oid=k.contypid JOIN pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname IN ('public','private') AND k.contypid<>0
    UNION ALL
    SELECT 'sequence', n.nspname || '.' || c.relname,
      jsonb_build_object('type',format_type(s.seqtypid,NULL),'start',s.seqstart,'increment',s.seqincrement,
        'min',s.seqmin,'max',s.seqmax,'cache',s.seqcache,'cycle',s.seqcycle,
        'ownedBy',(SELECT jsonb_build_object('table',dn.nspname || '.' || dc.relname,'column',a.attname)
          FROM pg_depend d JOIN pg_class dc ON dc.oid=d.refobjid JOIN pg_namespace dn ON dn.oid=dc.relnamespace
          JOIN pg_attribute a ON a.attrelid=dc.oid AND a.attnum=d.refobjsubid
          WHERE d.classid='pg_class'::regclass AND d.objid=c.oid AND d.deptype IN ('a','i') LIMIT 1))::text
      FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','private')
    UNION ALL
    SELECT 'schema', n.nspname,
      jsonb_build_object('owner',pg_get_userbyid(n.nspowner),'acl',(SELECT jsonb_agg(jsonb_build_object(
        'grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
        'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable
      ) ORDER BY x.grantee::regrole::text,x.privilege_type,x.is_grantable)
        FROM aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) x))::text
      FROM pg_namespace n WHERE n.nspname IN ('public','private')
    UNION ALL
    SELECT 'default_acl', pg_get_userbyid(d.defaclrole) || '.' || n.nspname || '.' || d.defaclobjtype::text,
      (SELECT jsonb_agg(jsonb_build_object(
        'grantee',CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
        'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable
      ) ORDER BY x.grantee::regrole::text,x.privilege_type,x.is_grantable) FROM aclexplode(d.defaclacl) x)::text
      FROM pg_default_acl d JOIN pg_namespace n ON n.oid=d.defaclnamespace WHERE n.nspname IN ('public','private')
    UNION ALL
    SELECT 'publication', pubname || '.' || schemaname || '.' || tablename,
      jsonb_build_object('attributes',attnames,'filter',rowfilter)::text
      FROM pg_publication_tables WHERE schemaname IN ('public','private')
    UNION ALL
    SELECT 'extension', e.extname,
      jsonb_build_object('schema',n.nspname,'version',e.extversion)::text
      FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace
)
SELECT COALESCE(jsonb_agg(jsonb_build_object('kind',kind,'name',name,
  'sha256',encode(extensions.digest(definition,'sha256'),'hex')) ORDER BY kind,name),'[]'::jsonb) AS catalog
FROM object_definitions;
