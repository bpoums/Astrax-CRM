-- A picked color per center, shown as a badge wherever a center name is
-- rendered. Fixed palette (6 pre-approved, muted tones), not a free color
-- picker — deliberately clear of amber (the app's one accent) and of the
-- red/emerald already reserved for destructive/positive outcomes. Same
-- constrained-vocabulary pattern already used for cx_status_options.tone.

alter table public.centers
  add column color text not null default 'slate'
  check (color in ('slate', 'teal', 'violet', 'clay', 'sky', 'sage'));
