-- Run once in the Supabase SQL editor. Safe to re-run; existing games are retained.
BEGIN;
CREATE SCHEMA IF NOT EXISTS closeword_private;
REVOKE ALL ON SCHEMA closeword_private FROM PUBLIC, anon, authenticated, service_role;
CREATE TABLE IF NOT EXISTS closeword_private.documents (
 namespace text NOT NULL CHECK(namespace ~ '^[a-zA-Z0-9:_-]{1,80}$'),
 kind text NOT NULL CHECK(kind IN ('room','solo')), id text NOT NULL CHECK(length(id) BETWEEN 1 AND 128),
 version bigint NOT NULL CHECK(version>=0), payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
 expires_at timestamptz NOT NULL, PRIMARY KEY(namespace,kind,id)
);
CREATE INDEX IF NOT EXISTS documents_expiry ON closeword_private.documents(expires_at);
CREATE INDEX IF NOT EXISTS documents_capacity ON closeword_private.documents(namespace,kind,expires_at);
CREATE TABLE IF NOT EXISTS closeword_private.limits (
 namespace text NOT NULL, key text NOT NULL, count bigint NOT NULL, expires_at timestamptz NOT NULL,
 PRIMARY KEY(namespace,key)
);
CREATE INDEX IF NOT EXISTS limits_expiry ON closeword_private.limits(expires_at);
CREATE TABLE IF NOT EXISTS closeword_private.connections (
 namespace text NOT NULL, code text NOT NULL, player_id text NOT NULL, connection_id text NOT NULL,
 seen_at timestamptz NOT NULL, PRIMARY KEY(namespace,connection_id)
);
CREATE INDEX IF NOT EXISTS connections_expiry ON closeword_private.connections(namespace,seen_at);
CREATE TABLE IF NOT EXISTS closeword_private.presence (
 namespace text NOT NULL, code text NOT NULL, player_id text NOT NULL, seen_at timestamptz NOT NULL,
 PRIMARY KEY(namespace,code,player_id)
);
CREATE TABLE IF NOT EXISTS closeword_private.metadata (
 namespace text NOT NULL, key text NOT NULL, value text NOT NULL, expires_at timestamptz,
 PRIMARY KEY(namespace,key)
);
CREATE TABLE IF NOT EXISTS closeword_private.scores (
 namespace text NOT NULL, name text NOT NULL, points bigint NOT NULL, PRIMARY KEY(namespace,name)
);
CREATE TABLE IF NOT EXISTS closeword_private.daily_scores (
 namespace text NOT NULL, name text NOT NULL, day date NOT NULL, points bigint NOT NULL,
 PRIMARY KEY(namespace,name,day)
);
ALTER TABLE closeword_private.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE closeword_private.limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE closeword_private.connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE closeword_private.presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE closeword_private.metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE closeword_private.scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE closeword_private.daily_scores ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA closeword_private FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.closeword_doc_read(p_namespace text,p_kind text,p_id text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('version',version,'value',payload)
 FROM closeword_private.documents
 WHERE namespace=p_namespace AND kind=p_kind AND id=p_id AND expires_at>clock_timestamp();
$$;

CREATE OR REPLACE FUNCTION public.closeword_doc_commit(p_namespace text,p_kind text,p_id text,p_expected bigint,p_payload jsonb,p_max integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE current_row closeword_private.documents%ROWTYPE; old_status text; v_now timestamptz:=clock_timestamp(); p jsonb;
BEGIN
 IF p_kind NOT IN ('room','solo') OR p_max NOT BETWEEN 1 AND 20000 THEN RAISE EXCEPTION 'Invalid document configuration'; END IF;
 IF p_expected<0 THEN
  -- Serialize new-document capacity checks; existing-room updates use row locks.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_namespace||':'||p_kind||':capacity',0));
  DELETE FROM closeword_private.documents WHERE namespace=p_namespace AND kind=p_kind AND expires_at<=v_now;
 END IF;
 SELECT * INTO current_row FROM closeword_private.documents WHERE namespace=p_namespace AND kind=p_kind AND id=p_id FOR UPDATE;
 IF FOUND AND current_row.expires_at>v_now THEN
  IF p_expected<0 OR current_row.version<>p_expected THEN RETURN 0; END IF;
  old_status:=current_row.payload->>'status';
 ELSE
  IF p_expected>=0 THEN RETURN -1; END IF;
  IF (SELECT count(*) FROM closeword_private.documents WHERE namespace=p_namespace AND kind=p_kind AND expires_at>v_now)>=p_max THEN RETURN -2; END IF;
 END IF;
 INSERT INTO closeword_private.documents(namespace,kind,id,version,payload,expires_at)
 VALUES(p_namespace,p_kind,p_id,p_expected+1,p_payload,v_now+interval '7 days')
 ON CONFLICT(namespace,kind,id) DO UPDATE SET version=excluded.version,payload=excluded.payload,expires_at=excluded.expires_at;
 -- The room and its winner awards are one transaction, and a CAS retry cannot award twice.
 IF p_kind='room' AND old_status='playing' AND p_payload->>'status'='finished' THEN
  FOR p IN SELECT value FROM jsonb_array_elements(p_payload->'players') ORDER BY value->>'name',value->>'id' LOOP
   INSERT INTO closeword_private.scores(namespace,name,points)
   VALUES(p_namespace,p->>'name',CASE WHEN p->>'id'=p_payload->>'winner' THEN 10 ELSE 1 END)
   ON CONFLICT(namespace,name) DO UPDATE SET points=closeword_private.scores.points+excluded.points;
   INSERT INTO closeword_private.daily_scores(namespace,name,day,points)
   VALUES(p_namespace,p->>'name',(v_now AT TIME ZONE 'UTC')::date,CASE WHEN p->>'id'=p_payload->>'winner' THEN 10 ELSE 1 END)
   ON CONFLICT(namespace,name,day) DO UPDATE SET points=closeword_private.daily_scores.points+excluded.points;
  END LOOP;
 END IF;
 RETURN 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.closeword_limit(p_namespace text,p_key text,p_window integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE n bigint; until_at timestamptz; v_now timestamptz:=clock_timestamp();
BEGIN
 IF p_window NOT BETWEEN 1 AND 86400000 OR length(p_key)>256 THEN RAISE EXCEPTION 'Invalid limit configuration'; END IF;
 DELETE FROM closeword_private.limits WHERE namespace=p_namespace AND expires_at<=v_now;
 INSERT INTO closeword_private.limits(namespace,key,count,expires_at)
 VALUES(p_namespace,p_key,1,v_now+p_window*interval '1 millisecond')
 ON CONFLICT(namespace,key) DO UPDATE SET
  count=CASE WHEN closeword_private.limits.expires_at<=v_now THEN 1 ELSE closeword_private.limits.count+1 END,
  expires_at=CASE WHEN closeword_private.limits.expires_at<=v_now THEN excluded.expires_at ELSE closeword_private.limits.expires_at END
 RETURNING count,expires_at INTO n,until_at;
 RETURN jsonb_build_array(n,greatest(0,extract(epoch FROM until_at-v_now)*1000)::bigint);
END;
$$;

CREATE OR REPLACE FUNCTION public.closeword_presence(p_namespace text,p_code text,p_player text,p_connection text,p_window integer,p_max integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE document jsonb; online_ids jsonb; v_now timestamptz:=clock_timestamp(); cutoff timestamptz; existing boolean;
BEGIN
 IF p_window NOT BETWEEN 1000 AND 60000 OR p_max NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'Invalid presence configuration'; END IF;
 SELECT jsonb_build_object('version',version,'value',payload) INTO document FROM closeword_private.documents
 WHERE namespace=p_namespace AND kind='room' AND id=p_code AND expires_at>v_now;
 IF document IS NULL THEN RETURN jsonb_build_object('code','NOT_FOUND'); END IF;
 cutoff:=v_now-p_window*interval '1 millisecond';
 PERFORM pg_advisory_xact_lock(hashtextextended(p_namespace||':connections',0));
 DELETE FROM closeword_private.connections WHERE namespace=p_namespace AND seen_at<=cutoff;
 DELETE FROM closeword_private.presence WHERE namespace=p_namespace AND code=p_code AND seen_at<=cutoff;
 IF p_player<>'' THEN
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(document->'value'->'players') p WHERE p->>'id'=p_player) THEN RETURN jsonb_build_object('code','NOT_FOUND'); END IF;
  SELECT EXISTS(SELECT 1 FROM closeword_private.connections WHERE namespace=p_namespace AND connection_id=p_connection AND code=p_code AND player_id=p_player) INTO existing;
  IF NOT existing AND ((SELECT count(*) FROM closeword_private.connections WHERE namespace=p_namespace AND code=p_code AND player_id=p_player)>=2 OR
   (SELECT count(*) FROM closeword_private.connections WHERE namespace=p_namespace)>=p_max) THEN RETURN jsonb_build_object('code','LIMIT'); END IF;
  INSERT INTO closeword_private.connections(namespace,code,player_id,connection_id,seen_at) VALUES(p_namespace,p_code,p_player,p_connection,v_now)
  ON CONFLICT(namespace,connection_id) DO UPDATE SET seen_at=excluded.seen_at;
  INSERT INTO closeword_private.presence(namespace,code,player_id,seen_at) VALUES(p_namespace,p_code,p_player,v_now)
  ON CONFLICT(namespace,code,player_id) DO UPDATE SET seen_at=excluded.seen_at;
 END IF;
 SELECT coalesce(jsonb_agg(player_id),'[]'::jsonb) INTO online_ids FROM closeword_private.presence WHERE namespace=p_namespace AND code=p_code AND seen_at>cutoff;
 RETURN jsonb_build_object('record',document,'online',online_ids);
END;
$$;

CREATE OR REPLACE FUNCTION public.closeword_release(p_namespace text,p_code text,p_player text,p_connection text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 DELETE FROM closeword_private.connections WHERE namespace=p_namespace AND code=p_code AND player_id=p_player AND connection_id=p_connection;
 -- Keep the last-seen grace period during Vercel stream rotation.
 RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.closeword_meta(p_namespace text,p_key text,p_candidate text,p_ttl integer DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result text;
BEGIN
 IF length(p_key)>128 OR length(p_candidate)>1024 OR (p_ttl IS NOT NULL AND p_ttl<1) THEN RAISE EXCEPTION 'Invalid metadata configuration'; END IF;
 INSERT INTO closeword_private.metadata(namespace,key,value,expires_at)
 VALUES(p_namespace,p_key,p_candidate,CASE WHEN p_ttl IS NULL THEN NULL ELSE clock_timestamp()+p_ttl*interval '1 second' END)
 ON CONFLICT(namespace,key) DO UPDATE SET
 value=CASE WHEN closeword_private.metadata.expires_at<=clock_timestamp() THEN excluded.value ELSE closeword_private.metadata.value END,
 expires_at=CASE WHEN closeword_private.metadata.expires_at<=clock_timestamp() THEN excluded.expires_at ELSE closeword_private.metadata.expires_at END
 RETURNING value INTO result;
 RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.closeword_matches(p_namespace text,p_mode text,p_capacity integer)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(id),'[]'::jsonb) FROM (
  SELECT id FROM closeword_private.documents WHERE namespace=p_namespace AND kind='room' AND expires_at>clock_timestamp()
  AND payload->>'public'='true' AND payload->>'status'='waiting' AND payload->>'mode'=p_mode AND payload->>'maxPlayers'=p_capacity::text
  AND jsonb_array_length(payload->'players')<p_capacity ORDER BY expires_at,id LIMIT 20
 ) rooms;
$$;

CREATE OR REPLACE FUNCTION public.closeword_leaders(p_namespace text,p_period text DEFAULT 'all')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb; days integer;
BEGIN
 IF p_period IN ('week','month') THEN
  days:=CASE WHEN p_period='week' THEN 7 ELSE 30 END;
  SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]'::jsonb) INTO result FROM (
   SELECT name,sum(points)::bigint AS score FROM closeword_private.daily_scores WHERE namespace=p_namespace AND day>=(clock_timestamp() AT TIME ZONE 'UTC')::date-(days-1)
   GROUP BY name ORDER BY score DESC,name LIMIT 50
  ) s;
 ELSE
  SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]'::jsonb) INTO result FROM (
   SELECT name,points AS score FROM closeword_private.scores WHERE namespace=p_namespace ORDER BY points DESC,name LIMIT 50
  ) s;
 END IF;
 RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.closeword_health()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('ok',true,'schema',1);
$$;
CREATE OR REPLACE FUNCTION public.closeword_preflight(p_namespace text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE probe text:='probe-'||gen_random_uuid()::text;
BEGIN
 INSERT INTO closeword_private.documents(namespace,kind,id,version,payload,expires_at) VALUES(p_namespace,'solo',probe,0,'{"probe":true}',clock_timestamp()+interval '1 minute');
 IF NOT EXISTS(SELECT 1 FROM closeword_private.documents WHERE namespace=p_namespace AND kind='solo' AND id=probe) THEN RAISE EXCEPTION 'Preflight failed'; END IF;
 DELETE FROM closeword_private.documents WHERE namespace=p_namespace AND kind='solo' AND id=probe;
 RETURN jsonb_build_object('ok',true,'schema',1);
END;
$$;
CREATE OR REPLACE FUNCTION public.closeword_cleanup()
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 DELETE FROM closeword_private.documents WHERE expires_at<=clock_timestamp();
 DELETE FROM closeword_private.limits WHERE expires_at<=clock_timestamp();
 DELETE FROM closeword_private.connections WHERE seen_at<clock_timestamp()-interval '1 minute';
 DELETE FROM closeword_private.presence WHERE seen_at<clock_timestamp()-interval '1 minute';
 DELETE FROM closeword_private.metadata WHERE expires_at<=clock_timestamp();
 DELETE FROM closeword_private.daily_scores WHERE day<(clock_timestamp() AT TIME ZONE 'UTC')::date-35;
 RETURN true;
END;
$$;

-- Restrict only this application's RPCs; do not change other project functions.
DO $$ DECLARE f record;
BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname IN ('closeword_doc_read','closeword_doc_commit','closeword_limit','closeword_presence','closeword_release','closeword_meta','closeword_matches','closeword_leaders','closeword_health','closeword_preflight','closeword_cleanup') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
 END LOOP;
END $$;
NOTIFY pgrst, 'reload schema';
COMMIT;
