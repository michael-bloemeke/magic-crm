-- notify-cron-setup.sql
-- SQL to make Magic CRM notifications always-on in the cloud (fires with the Mac off).
-- Pairs with the edge function supabase/functions/notify-cron/index.ts.
--
-- The main agent runs this via the Supabase connector AFTER deploying the notify-cron function.
-- It is idempotent where practical (IF NOT EXISTS / ON CONFLICT / unschedule-before-schedule).
--
-- NOTE ON SECRETS: the real VAPID keys and the generated cron_secret are inlined below so this file
-- is runnable as-is. They already live in the repo (push-vapid.json) and the service-role-only
-- push_config table; nothing new is exposed to the anon key. push_config has RLS on and NO policies,
-- so only the service role can read it.

-- ---------------------------------------------------------------------------
-- 1. tasks.notified_at  (when the cloud alarm last fired for a task; NULL = not yet)
-- ---------------------------------------------------------------------------
alter table public.tasks add column if not exists notified_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. push_config  (single row id=1; service-role only)
-- ---------------------------------------------------------------------------
create table if not exists public.push_config (
  id                integer primary key default 1,
  vapid_public      text not null,
  vapid_private     text not null,
  vapid_subject     text not null,
  app_url           text not null,
  cron_secret       text not null,
  constraint push_config_singleton check (id = 1)
);

alter table public.push_config enable row level security;
-- Intentionally NO policies: with RLS enabled and no policy, the anon/publishable key and any
-- authenticated user see nothing. Only the service role (used by the edge function) can read it.

-- Populate / refresh the single row. Values:
--   vapid_public / vapid_private / vapid_subject : from push-vapid.json (base64url, standard web-push)
--   app_url          : the phone PWA (web-push tap target)
--   cron_secret      : freshly generated 32-byte base64url shared secret (see report)
insert into public.push_config
  (id, vapid_public, vapid_private, vapid_subject, app_url, cron_secret)
values (
  1,
  'BJ-kKbuNb4748FiB5n4x2Y9f2B89QuyRMvxFt66iovJOG2xO1ADGCNA3srgky4UbZiISFrpquq5ae6AjWB86eoI',
  'vTs75YS-_XLKB8XA9xVHnAEdVdg5kJw5IK3eAxlB-ZU',
  'mailto:mchlbloemeke@gmail.com',
  'https://mobile-blond-alpha.vercel.app',
  'ZFZBYcg4Lk-vH-2HV1-NoDKsXB-iHC4SOhloN09P8-g'
)
on conflict (id) do update set
  vapid_public     = excluded.vapid_public,
  vapid_private    = excluded.vapid_private,
  vapid_subject    = excluded.vapid_subject,
  app_url          = excluded.app_url,
  cron_secret      = excluded.cron_secret;

-- Let PostgREST notice the new table immediately (harmless if already loaded).
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- 3. Extensions for scheduling + outbound HTTP from Postgres
-- ---------------------------------------------------------------------------
-- On Supabase these install into the `extensions` schema.
create extension if not exists pg_cron  with schema extensions;
create extension if not exists pg_net   with schema extensions;

-- ---------------------------------------------------------------------------
-- 4. Cron job: POST to the edge function every minute with the shared secret + service-role bearer.
-- ---------------------------------------------------------------------------
-- The service-role JWT below is the SUPABASE SERVICE ROLE KEY. The main agent must paste the real one
-- (from supabase-credentials.json `secretKey`, or the project's legacy service_role JWT) where the
-- placeholder <SERVICE_ROLE_KEY> is. Supabase's gateway accepts the service key as the bearer for
-- functions/v1; the edge function ALSO independently checks the x-cron-secret header.
--
-- pg_net's net.http_post signature can vary slightly by Postgres/pg_net version. The form below
-- (url, headers jsonb, body jsonb) is the current Supabase form. MAIN AGENT: confirm the exact
-- signature for this project's pg_net at deploy time and adjust if needed (see report).

-- Unschedule an old copy first so re-running this file doesn't stack duplicate jobs.
select cron.unschedule('notify-cron')
where exists (select 1 from cron.job where jobname = 'notify-cron');

select cron.schedule(
  'notify-cron',
  '* * * * *',  -- every minute
  $$
  select net.http_post(
    url     := 'https://yfmacqvcmkogvkcxfjkr.supabase.co/functions/v1/notify-cron',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', 'ZFZBYcg4Lk-vH-2HV1-NoDKsXB-iHC4SOhloN09P8-g',
      'Authorization', 'Bearer <SERVICE_ROLE_KEY>'
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- To inspect later:
--   select jobid, jobname, schedule, active from cron.job where jobname = 'notify-cron';
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname='notify-cron') order by start_time desc limit 10;
