-- Stop re-evaluating my_role() and auth.uid() once per row.
--
-- Every policy below is recreated with its predicate UNCHANGED except that
-- each bare call is wrapped in a scalar subquery:
--
--     my_role()   ->  (select my_role())
--     auth.uid()  ->  (select auth.uid())
--
-- Both functions are STABLE and take no arguments, so the subquery returns the
-- identical value. What changes is WHEN Postgres evaluates it. A bare call in
-- a filter expression is executed per candidate row; an uncorrelated scalar
-- subquery becomes an InitPlan, executed once for the whole scan.
--
-- Why this matters here: my_role() is SECURITY DEFINER and runs
--   select role from profiles where id = auth.uid() and active
-- so every row scanned was costing a profiles lookup plus a JWT parse.
-- Measured on the manager queue query over 546 rows, changing one call site:
--
--     case my_role() ...          8.46 ms   (plan: CASE my_role())
--     case (select my_role()) ... 5.17 ms   (plan: CASE (InitPlan 1).col1)
--
-- ~6 us per row per call site. That is linear in table size, which is why the
-- app got slower as data grew: ~4 ms per call site at 633 submissions, but
-- ~360 ms at 60k. The database is 27 MB and entirely cached - the index scan
-- itself was 0.058 ms. Effectively all of the query time was this.
--
-- The rule is applied uniformly to every bare occurrence, including the one
-- inside the closing_manager center lookup where it was already hoisted. A
-- uniform rule makes the result machine-checkable: after this migration no
-- policy in public should contain a bare my_role() or auth.uid() at all.
--
-- This is Supabase's documented remedy for the auth_rls_initplan lint.
--
-- NOT a semantic change. Recreating each policy inside one transaction is safe
-- in both directions: a table whose policies are momentarily absent denies all
-- access rather than granting it, so the window is fail-closed. The migration
-- runner supplies that transaction, so there is deliberately no explicit
-- begin/commit here - adding one would nest and commit early.

-- card_access_log ----------------------------------------------------------
drop policy if exists "access log readable by admin" on public.card_access_log;
create policy "access log readable by admin" on public.card_access_log
  for select to public
  using ((select my_role()) = 'admin'::app_role);

-- carrier_declines ---------------------------------------------------------
drop policy if exists "declines readable" on public.carrier_declines;
create policy "declines readable" on public.carrier_declines
  for select to public
  using ((select my_role()) = any (array[
    'admin'::app_role, 'manager'::app_role, 'closing_manager'::app_role,
    'general_manager'::app_role, 'validator'::app_role]));

-- carriers -----------------------------------------------------------------
drop policy if exists "admin manages carriers" on public.carriers;
create policy "admin manages carriers" on public.carriers
  for all to public
  using ((select my_role()) = 'admin'::app_role)
  with check ((select my_role()) = 'admin'::app_role);

drop policy if exists "carriers readable" on public.carriers;
create policy "carriers readable" on public.carriers
  for select to public
  using ((select my_role()) = any (array[
    'admin'::app_role, 'manager'::app_role, 'closing_manager'::app_role,
    'general_manager'::app_role, 'validator'::app_role, 'cxm'::app_role,
    'cxa'::app_role, 'data_uploader'::app_role, 'closer'::app_role]));

-- centers ------------------------------------------------------------------
drop policy if exists "admin manages centers" on public.centers;
create policy "admin manages centers" on public.centers
  for all to public
  using ((select my_role()) = 'admin'::app_role)
  with check ((select my_role()) = 'admin'::app_role);

drop policy if exists "centers readable" on public.centers;
create policy "centers readable" on public.centers
  for select to public
  using ((select my_role()) = any (array[
    'admin'::app_role, 'manager'::app_role, 'closing_manager'::app_role,
    'general_manager'::app_role, 'closer'::app_role, 'validator'::app_role,
    'cxm'::app_role, 'cxa'::app_role, 'data_uploader'::app_role]));

-- cx_lead_status -----------------------------------------------------------
drop policy if exists "lead status readable" on public.cx_lead_status;
create policy "lead status readable" on public.cx_lead_status
  for select to public
  using ((select my_role()) = any (array[
    'admin'::app_role, 'cxm'::app_role, 'cxa'::app_role, 'manager'::app_role,
    'closing_manager'::app_role, 'general_manager'::app_role]));

-- cx_status_history --------------------------------------------------------
drop policy if exists "cx history readable" on public.cx_status_history;
create policy "cx history readable" on public.cx_status_history
  for select to public
  using ((select my_role()) = any (array[
    'admin'::app_role, 'cxm'::app_role, 'cxa'::app_role, 'manager'::app_role,
    'closing_manager'::app_role, 'general_manager'::app_role]));

-- cx_status_options --------------------------------------------------------
drop policy if exists "admin manages status options" on public.cx_status_options;
create policy "admin manages status options" on public.cx_status_options
  for all to public
  using ((select my_role()) = any (array['admin'::app_role, 'cxm'::app_role]))
  with check ((select my_role()) = any (array['admin'::app_role, 'cxm'::app_role]));

drop policy if exists "status options readable" on public.cx_status_options;
create policy "status options readable" on public.cx_status_options
  for select to public
  using ((select my_role()) = any (array[
    'admin'::app_role, 'cxm'::app_role, 'cxa'::app_role, 'manager'::app_role,
    'closing_manager'::app_role, 'general_manager'::app_role]));

-- cx_tags ------------------------------------------------------------------
drop policy if exists "admin manages tags" on public.cx_tags;
create policy "admin manages tags" on public.cx_tags
  for all to public
  using ((select my_role()) = any (array['admin'::app_role, 'cxm'::app_role]))
  with check ((select my_role()) = any (array['admin'::app_role, 'cxm'::app_role]));

drop policy if exists "tags readable" on public.cx_tags;
create policy "tags readable" on public.cx_tags
  for select to public
  using ((select my_role()) = any (array[
    'admin'::app_role, 'cxm'::app_role, 'cxa'::app_role, 'manager'::app_role]));

-- form_events --------------------------------------------------------------
-- 3,555 rows and read by every timeline and history view, so this one is
-- second only to submissions for payoff.
drop policy if exists "events readable" on public.form_events;
create policy "events readable" on public.form_events
  for select to public
  using ((select my_role()) = any (array[
    'manager'::app_role, 'admin'::app_role, 'closing_manager'::app_role,
    'general_manager'::app_role]));

-- lead_imports -------------------------------------------------------------
drop policy if exists "imports readable" on public.lead_imports;
create policy "imports readable" on public.lead_imports
  for select to public
  using (
    uploaded_by = (select auth.uid())
    or (select my_role()) = any (array['manager'::app_role, 'admin'::app_role])
  );

-- payload_edits ------------------------------------------------------------
drop policy if exists "payload edits readable" on public.payload_edits;
create policy "payload edits readable" on public.payload_edits
  for select to public
  using ((select my_role()) = any (array[
    'admin'::app_role, 'manager'::app_role, 'closing_manager'::app_role,
    'general_manager'::app_role]));

-- profiles -----------------------------------------------------------------
drop policy if exists "admin manages profiles" on public.profiles;
create policy "admin manages profiles" on public.profiles
  for all to public
  using ((select my_role()) = 'admin'::app_role)
  with check ((select my_role()) = 'admin'::app_role);

drop policy if exists "profiles readable" on public.profiles;
create policy "profiles readable" on public.profiles
  for select to public
  using (
    id = (select auth.uid())
    or (select my_role()) = any (array[
      'manager'::app_role, 'admin'::app_role, 'cxm'::app_role, 'cxa'::app_role,
      'closing_manager'::app_role, 'general_manager'::app_role])
  );

-- settings_audit -----------------------------------------------------------
drop policy if exists "settings audit readable by admin" on public.settings_audit;
create policy "settings audit readable by admin" on public.settings_audit
  for select to public
  using ((select my_role()) = 'admin'::app_role);

-- submission_tags ----------------------------------------------------------
drop policy if exists "submission tags readable" on public.submission_tags;
create policy "submission tags readable" on public.submission_tags
  for select to public
  using ((select my_role()) = any (array[
    'admin'::app_role, 'cxm'::app_role, 'cxa'::app_role, 'manager'::app_role]));

-- submissions --------------------------------------------------------------
-- The hot one: the main table, and the CASE means my_role() was evaluated for
-- every candidate row on every queue, reporting and desk query in the app.
-- Predicate is otherwise byte-for-byte the existing policy.
drop policy if exists "submissions read scoped" on public.submissions;
create policy "submissions read scoped" on public.submissions
  for select to public
  using (
    case (select my_role())
      when 'admin'::app_role then true
      when 'manager'::app_role then (status <> 'parked'::sub_status)
      when 'closing_manager'::app_role then (
        submitted_by_role = 'closer'::app_role
        and archived_at is null
        and center_id is not null
        and center_id = (
          select p.center_id from profiles p where p.id = (select auth.uid())
        )
      )
      when 'general_manager'::app_role then (
        submitted_by_role = any (array['closer'::app_role, 'validator'::app_role])
        and archived_at is null
      )
      when 'validator'::app_role then (
        assigned_to = (select auth.uid())
        and archived_at is null
        and status = any (array['assigned'::sub_status, 'in_review'::sub_status])
        and (claimed_at is null or claimed_at > (now() - review_window()))
      )
      when 'data_uploader'::app_role then (uploaded_by = (select auth.uid()))
      when 'cxm'::app_role then (
        archived_at is null and cx_removed_at is null
        and (disposition = 'accepted'::disposition_t or reopened_from_cx_at is not null)
      )
      when 'cxa'::app_role then (
        archived_at is null and cx_removed_at is null
        and (disposition = 'accepted'::disposition_t or reopened_from_cx_at is not null)
      )
      else false
    end
  );
