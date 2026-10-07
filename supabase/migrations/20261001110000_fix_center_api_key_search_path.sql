-- 20261001100000 set search_path to 'public' only on the two functions that
-- call pgcrypto's gen_random_bytes()/digest(). On this project pgcrypto is
-- installed in the 'extensions' schema, not 'public' (confirmed live:
-- select extname, nspname from pg_extension ... -> extensions), so those
-- calls failed with "function gen_random_bytes(integer) does not exist".
-- Widening the search path to include extensions fixes both without
-- changing any logic.

alter function public.admin_generate_center_api_key(uuid)
  set search_path to 'public', 'extensions';

alter function public.submit_external_lead(text, jsonb)
  set search_path to 'public', 'extensions';
