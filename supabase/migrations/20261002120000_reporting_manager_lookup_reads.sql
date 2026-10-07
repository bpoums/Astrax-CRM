-- reporting_manager could read `submissions` but not the tables the reporting
-- RPCs join to. Those RPCs are SECURITY INVOKER, so each join runs under the
-- caller's RLS and silently came back empty: "Unnamed closer" (profiles),
-- an empty Validators Team Dashboard (profiles + form_events), "No active
-- centers" (centers), and By Carrier falling back to raw proposed-carrier
-- text (carriers). Read access only — every write policy is untouched.

alter policy "profiles readable" on public.profiles
using (
  (id = (select auth.uid()))
  or ((select my_role()) = any (array[
    'manager', 'admin', 'cxm', 'cxa', 'closing_manager', 'general_manager',
    'reporting_manager'
  ]::app_role[]))
);

alter policy "centers readable" on public.centers
using (
  (select my_role()) = any (array[
    'admin', 'manager', 'closing_manager', 'general_manager', 'closer',
    'validator', 'cxm', 'cxa', 'data_uploader', 'reporting_manager'
  ]::app_role[])
);

alter policy "carriers readable" on public.carriers
using (
  (select my_role()) = any (array[
    'admin', 'manager', 'closing_manager', 'general_manager', 'validator',
    'cxm', 'cxa', 'data_uploader', 'closer', 'reporting_manager'
  ]::app_role[])
);

alter policy "events readable" on public.form_events
using (
  (select my_role()) = any (array[
    'manager', 'admin', 'closing_manager', 'general_manager',
    'reporting_manager'
  ]::app_role[])
);
