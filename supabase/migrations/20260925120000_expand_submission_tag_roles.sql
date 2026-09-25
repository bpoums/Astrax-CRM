-- Admin, manager, and general_manager can now also apply/remove submission
-- tags (in practice, this is the "Eligible For Second Policy" duplicate-SSN
-- exemption on an accepted lead they can already see and edit). admin was
-- already allowed; manager and general_manager are new. closing_manager is
-- deliberately not included -- no UI mount offers it to that role.

create or replace function public.add_submission_tag(p_sub uuid, p_tag uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if my_role() not in ('cxa','cxm','admin','manager','general_manager') then raise exception 'not authorized'; end if;

  perform 1 from submissions
   where id = p_sub and disposition = 'accepted' and archived_at is null;
  if not found then raise exception 'lead is not in the customer pipeline'; end if;

  insert into submission_tags (submission_id, tag_id, tagged_by)
  values (p_sub, p_tag, auth.uid())
  on conflict do nothing;

  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'tag_added',
          jsonb_build_object('tag', (select label from cx_tags where id = p_tag)));
end
$$;

create or replace function public.remove_submission_tag(p_sub uuid, p_tag uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if my_role() not in ('cxa','cxm','admin','manager','general_manager') then raise exception 'not authorized'; end if;
  delete from submission_tags where submission_id = p_sub and tag_id = p_tag;
  insert into form_events (submission_id, actor_id, event_type, detail)
  values (p_sub, auth.uid(), 'tag_removed',
          jsonb_build_object('tag', (select label from cx_tags where id = p_tag)));
end
$$;

drop policy if exists "tags readable" on cx_tags;
create policy "tags readable" on cx_tags
  for select
  using ((select my_role()) = any (array['admin','cxm','cxa','manager','general_manager']::app_role[]));

drop policy if exists "submission tags readable" on submission_tags;
create policy "submission tags readable" on submission_tags
  for select
  using ((select my_role()) = any (array['admin','cxm','cxa','manager','general_manager']::app_role[]));
