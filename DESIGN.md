---
name: ASTRAX
description: Operations console for a timed, auditable insurance validation workflow.
colors:
  amber: "oklch(0.8 0.145 80)"
  amber-deep: "oklch(0.78 0.15 78)"
  on-amber: "oklch(0.21 0.04 258)"
  navy: "oklch(0.19 0.03 255)"
  card: "oklch(0.235 0.031 256)"
  raised: "oklch(0.29 0.033 257)"
  muted: "oklch(0.28 0.03 257)"
  foreground: "oklch(0.96 0.006 250)"
  muted-foreground: "oklch(0.72 0.02 255)"
  border: "oklch(0.33 0.028 257)"
  input: "oklch(0.3 0.03 257)"
  red: "oklch(0.68 0.19 24)"
  on-red: "oklch(0.98 0.005 250)"
  green: "#059669"
typography:
  display:
    fontFamily: "Space Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "Space Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Space Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.7rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.22em"
  body:
    fontFamily: "DM Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "DM Sans, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.66rem"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "0.04em"
rounded:
  sm: "calc(0.55rem - 4px)"
  md: "calc(0.55rem - 2px)"
  lg: "0.55rem"
  xl: "calc(0.55rem + 4px)"
  full: "999px"
spacing:
  tight: "0.5rem"
  base: "0.75rem"
  loose: "1rem"
  panel: "0.85rem 1rem 1rem"
components:
  button-primary:
    backgroundColor: "{colors.amber}"
    textColor: "{colors.on-amber}"
    rounded: "{rounded.full}"
    padding: "0.5rem 1.4rem"
    typography: "{typography.label}"
  chip:
    backgroundColor: "color-mix(in oklab, oklch(0.19 0.03 255) 70%, black 6%)"
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.full}"
    padding: "0.3rem 0.62rem"
  chip-active:
    backgroundColor: "{colors.amber}"
    textColor: "{colors.on-amber}"
    rounded: "{rounded.full}"
    padding: "0.3rem 0.62rem"
  input:
    backgroundColor: "color-mix(in oklab, oklch(0.19 0.03 255) 70%, black 6%)"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "0.4rem 0.55rem"
  panel:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.xl}"
    padding: "{spacing.panel}"
  badge-accepted:
    backgroundColor: "{colors.green}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "0.125rem 0.625rem"
  badge-destructive:
    backgroundColor: "{colors.red}"
    textColor: "{colors.on-red}"
    rounded: "{rounded.md}"
    padding: "0.125rem 0.625rem"
  table-header:
    backgroundColor: "color-mix(in oklab, oklch(0.235 0.031 256) 92%, black 8%)"
    textColor: "{colors.muted-foreground}"
    typography: "{typography.label}"
---

# Design System: ASTRAX

## Overview

**Creative North Star: "The Night Desk"**

ASTRAX is worked from Pakistan while America is awake. That single fact is the
whole design: a warm amber light pooled on a dark desk, the rest of the building
quiet, one person concentrating on a queue for hours at a stretch. The ground is
a deep blue-leaning navy rather than a neutral charcoal, because a slightly warm
amber sitting on a slightly cool ground is what a lamp looks like at night — and
because eight hours of grey-on-grey is punishing in a way that a tinted ground is
not.

The console is dense on purpose. It shows queues of leads, and an operator's job
is to scan them, not to admire them. Type is small, gaps are tight, tables are
wide, and numbers are tabular so columns line up down the page. Confirmed: no
role works on a phone or a tablet, so nothing here is compromised to survive a
narrow viewport.

Colour is almost entirely absent, which is what makes the little of it that
exists carry meaning. Grey is waiting, amber is happening, red went wrong, green
is money in. Because the palette is so quiet, an operator learns to trust that a
coloured mark is telling them something rather than decorating something — and
the moment colour is spent on decoration, that trust is gone and every screen
gets a little harder to read.

**Key Characteristics:**

- Deep navy ground with a single warm amber accent, used sparingly
- Dense by default: small type, tight gaps, wide tables, tabular numerals
- Desktop-only; density is never traded away for small screens
- Depth from tone and hairlines first, shadow where a surface genuinely floats
- Controls that feel pressable: warmth, lift, visible response
- Colour is semantic — grey waits, amber works, red fails, green pays

## Colors

A near-monochrome navy field with one warm accent, one alarm, and one exception
for money.

### Primary

- **Amber** (`{colors.amber}`): The only accent in the system. It marks the
  thing that is happening or the thing to press — the primary action, an active
  filter chip, a lead currently in review, a focus ring. Its scarcity is the
  point: on a screen showing two hundred rows it should appear a handful of
  times.
- **Amber Deep** (`{colors.amber-deep}`): A fractionally darker, more saturated
  amber registered as `--primary`. Used where a value is emphasised in text
  rather than filled — an accent-toned figure inside a panel.
- **On Amber** (`{colors.on-amber}`): The dark navy that sits on top of an amber
  fill. Never use white on amber; the contrast is worse and it reads as a
  different brand.

### Secondary

- **Red** (`{colors.red}`): Failure, and only failure. A review that timed out, a
  carrier that declined, a lead returned from CX, a destructive action. It is
  never used for emphasis, urgency, or "important".
- **Green** (`{colors.green}`): The one hardcoded colour in the system, Tailwind's
  emerald-600. It exists because a red/amber/green outcome scale was asked for
  and the palette has no green token. It marks an accepted lead and nothing else.

### Neutral

- **Navy** (`{colors.navy}`): The page ground. Blue-leaning, not neutral
  charcoal — see the North Star.
- **Card** (`{colors.card}`): Every panel and popover surface, one step lighter
  than the ground.
- **Raised** (`{colors.raised}`): Secondary surfaces and quiet badge fills.
- **Foreground** (`{colors.foreground}`): Primary text — near-white with a trace
  of blue so it belongs to the ground rather than sitting on top of it.
- **Muted Foreground** (`{colors.muted-foreground}`): Everything secondary:
  labels, timestamps, dashes, supporting figures. The majority of text in the
  app is this colour, not `foreground`.
- **Border** (`{colors.border}`): Hairlines, dividers, panel edges. This is the
  workhorse of the whole system — most separation is done with a 1px line, not
  with a shadow or a gap.
- **Input** (`{colors.input}`): Control edges, a shade darker than `border` so a
  field reads as recessed rather than drawn.

### Named Rules

**The One Amber Rule.** Amber is the only accent in the system, and a view gets
one emphasis. If two things on a screen are amber, one of them is wrong — decide
which is the action and mute the other.

**The Semantic Colour Rule.** Colour states a fact, never a mood. Grey is
waiting, amber is being worked, red went wrong, green paid. A mark that is
coloured for interest rather than for meaning is a bug.

**The Emerald Exception.** `#059669` is the single hardcoded colour in the
codebase, and it is deliberate. Leave it, or promote it to a real token — but do
not quietly "fix" it back to amber, and do not add a second exception beside it.

**The Root-Is-Dark Rule.** `:root` *is* the dark theme. The `.dark` block in
`styles.css` is an unused generic grey palette from the original scaffold and
does not match this identity. Never put `class="dark"` on any element or wrapper.

## Typography

**Display Font:** Space Grotesk (weights 500/600/700, with `ui-sans-serif`,
`system-ui` fallbacks)
**Body Font:** DM Sans (weights 400/500/600, same fallbacks)

**Character:** Space Grotesk is slightly mechanical and a little wide, which
suits numbers and short headings; DM Sans is quiet and disappears at small sizes,
which is what body text in a dense table needs to do. The pairing works because
only one of the two ever tries to have a personality.

### Hierarchy

- **Headline** (Space Grotesk 600, `1.875rem`, tight leading): Page titles in the
  app header. One per screen.
- **Display** (Space Grotesk 600, `1.5rem`, tabular): Standalone figures — the
  stage counts in the queue strip, a lifetime total. Numerals, not prose.
- **Title** (Space Grotesk 600, `0.7rem`, uppercase, `0.22em` tracking, muted):
  The `.panel-title` — every section heading in the app. The extreme tracking is
  what makes a 0.7rem heading read as a heading rather than as small text.
- **Body** (DM Sans 400, `0.75rem`–`0.82rem`, 1.5 leading): Table cells, form
  values, descriptions. `0.82rem` inside inputs, `0.75rem` in tables.
- **Label** (DM Sans 500, `0.66rem`, uppercase, `0.04em` tracking, muted): Field
  labels and table headers. Far less tracking than Title — these sit beside data
  and must not compete with it.

### Named Rules

**The Display-For-Headings Rule.** Space Grotesk is for headings and standalone
numerals. Body copy inherits DM Sans automatically and should never be given
`.font-display`.

**The Tabular Numeral Rule.** Any number that appears in a column, a countdown,
a duration, or beside another number gets `tabular-nums`. Proportional figures
make a column of counts jitter as it updates, which is exactly where the eye is
trying to hold still.

**The Two-Tracking Rule.** Uppercase in this system means one of two things:
`0.22em` is a section heading, `0.04em` is a data label. Never invent a third.

## Layout

A single centred column, `max-w-[1500px]`, with `px-4 py-4` rising to
`lg:px-8 lg:py-5`. Everything inside is a stack of `.panel` sections separated by
`gap-4`.

Spacing is on a tight rhythm: `gap-2` (0.5rem) inside a control cluster, `gap-3`
(0.75rem) between related blocks, `gap-4` (1rem) between panels. Panel padding is
`0.85rem 1rem 1rem` — slightly less on top than the bottom, so a `.panel-title`
optically centres against its own cap height.

Tables are the primary layout device and they are allowed to be wide. A table
that cannot fit declares a `min-w-[Nrem]` and scrolls sideways inside its panel
rather than compressing its columns; `.panel` hides its own scrollbar so this
reads as a surface that extends rather than as a broken box. Fixed-width columns
(`w-28`, `w-32`, `w-40`) carry the metadata and one unsized column absorbs the
slack — usually Customer. **Data cells truncate; headers never do.**

Responsive behaviour is deliberately shallow. Grids collapse `lg:grid-cols-5` →
`sm:grid-cols-3` → `grid-cols-2` so nothing breaks on a smaller laptop, but no
screen is designed for a phone and none should be.

### Named Rules

**The Dense-By-Default Rule.** This is a console someone works all day, not a
landing page. Reach for `gap-2`/`gap-3` and small type first; generous padding
has to be argued for.

**The Truncation Rule.** When a table runs out of room, the data ellipsises and
keeps its full value in a `title` or a tooltip. A header never truncates, because
a reader who cannot identify a column cannot use the row.

## Elevation & Depth

Depth is built from tone and hairlines before it is built from shadow. A panel is
a 1px border plus a barely-there 160° gradient (`card` mixed 4% toward white at
the top edge) — enough to lift it off the ground without a drop shadow. Table
headers recess instead of lifting: `.table-head-band` mixes the card 8% toward
black so the header reads as a groove cut into the surface.

Shadow is not banned. It is reserved for two jobs: an element that genuinely
floats above the page (sheets, dialogs, popovers, dropdowns — all inherited from
the shadcn primitives), and the primary action, which carries a soft amber glow
that reads as the light the interface is named after.

### Shadow Vocabulary

- **Action glow** (`box-shadow: 0 8px 24px -12px color-mix(in oklab, var(--color-accent) 80%, transparent)`):
  Under `.btn-submit` only. Amber-tinted, wide, and offset downward so the button
  appears lit rather than outlined.
- **Focus ring** (`box-shadow: 0 0 0 3px color-mix(in oklab, var(--color-ring) 25%, transparent)`):
  On focused inputs, paired with a border shift to the ring colour. Never remove
  it without an equally visible replacement.

### Named Rules

**The Tone-First Rule.** Separate surfaces with tone and a hairline before
reaching for a shadow. If two adjacent surfaces both need shadows to be told
apart, the tonal step between them is wrong.

## Shapes

Two radii, and the choice between them carries meaning.

**Surfaces are soft rectangles.** Everything built on the `--radius: 0.55rem`
scale: panels at `xl` (0.55rem + 4px), inputs and badges at `md` (0.55rem − 2px),
buttons at `md`. The scale is derived, not hand-picked per component, so changing
`--radius` moves the whole system together.

**Actions are pills.** A full `999px` radius is reserved for things you press or
toggle: `.chip`, `.chip-active`, `.btn-submit`, and the small status dots. The
pill is the system's signal for "interactive"; a pill that does nothing is a
mistake, and so is a square primary action.

Borders are 1px and everywhere. This is a bordered system, not a shadowed one:
panels, inputs, chips, badges and table dividers all resolve to a single hairline
in `border` or `input`.

## Components

### Buttons

- **Shape:** Pill for the primary action (999px); soft rectangle for everything
  else (`{rounded.md}`).
- **Primary** (`.btn-submit`): Amber fill, dark navy text, `0.5rem 1.4rem`
  padding, 600 weight. Carries the action glow.
- **Hover / Focus:** `brightness(1.06)` and a 1px lift (`translateY(-1px)`) over
  150ms. Disabled drops to 60% opacity and loses the lift entirely, so a dead
  button never appears pressable.
- **Secondary:** shadcn `outline` and `ghost` variants, or a `.chip` where the
  action is small and lives in a row of others.

### Chips

- **Style:** Pill, 1px `input` border, a background mixed slightly darker than
  the page, `0.72rem` muted text.
- **State:** `.chip-active` fills amber with dark text at 600 weight — the same
  treatment as the primary button, which is what makes a selected filter read as
  "on" rather than as merely highlighted.
- **Hover:** border shifts to the ring colour and text to full foreground.
- **Roles:** radio-style choices, filters, tabs, and any secondary action beside
  a primary one.

### Cards / Containers

- **Corner Style:** `{rounded.xl}` (0.55rem + 4px).
- **Background:** `card`, with a 160° gradient lifting the top edge 4% toward
  white.
- **Shadow Strategy:** none at rest — see Elevation & Depth.
- **Border:** 1px `border`.
- **Internal Padding:** `0.85rem 1rem 1rem`, children stacked at `gap-2`.
- **Behaviour:** `.panel` hides its own scrollbar, so a wide table inside it
  scrolls without a visible track.

### Inputs / Fields

- **Style:** Full width, `{rounded.md}`, 1px `input` border, background mixed 6%
  toward black so the field reads as cut into the surface. `0.82rem` text.
- **Focus:** border moves to the amber ring and a 3px 25%-opacity amber glow
  appears, over 150ms. This is the only place amber appears without the user
  having chosen something.
- **Labels:** always visible above the field in Label type. Placeholder-only
  fields are not used.
- **Date inputs:** the picker indicator is inverted 80% so it survives on a dark
  ground.

### Tables

- **Header:** `.table-head-band` recess plus Label typography, applied once in
  `components/ui/table.tsx` so every table in the app inherits it. Style it there,
  never per table.
- **Rows:** 1px bottom hairline, no zebra striping. Clickable rows take
  `cursor-pointer` and a faint `accent/5` hover wash.
- **Numeric cells:** right-aligned and `tabular-nums`.
- **Empty state:** a single full-width row that distinguishes loading, an error,
  a filtered-empty result, and a genuinely empty set — four different sentences,
  never one generic "No data".

### Badges

- **Status** (`StatusBadge`, `QueueStatusBadge`): `{rounded.md}`, filled or
  outlined by severity. A precedence chain decides which single badge shows when
  a lead has several problems at once — it is spelled in exactly one place.
- **Outcome** (`DispositionBadge`): green for accepted, red for declined, amber
  for pending, outlined amber for on-hold.
- **Origin** (`OriginBadge`): always outlined and muted. Provenance is never
  coloured; where a lead came from says nothing about whether it needs attention.

### Signature Component: the Queue Flow strip

A single 8px track split into proportional segments — one per workflow stage —
with a legend beneath giving each stage's count and the age of its oldest lead.
It replaces what were five identical stat cards, and it answers a question cards
cannot: *where is the work stuck*. Stage fills are separated by luminance rather
than by opacity of one hue, because two steps of the same grey merge at that
height. Every segment is also named and counted, so nothing depends on colour
alone.

### Signature Component: the Timeline

A lead's history, grouped into "passes" — one validator's tenure with a lead —
with the repetitive claim/hold churn collapsed behind a disclosure. The rail is
drawn only *inside* a group, where it means containment; standalone events sit
without one. Time is a right-aligned column rather than a suffix on a sentence,
so the eye can run down one edge.

### Signature Component: the Metric Bar

A neutral-grey proportional bar under a count, used wherever several counts are
compared. Deliberately not coloured: the chip beside it already carries meaning,
so the bar carries only magnitude. It is a comparison device, not a chart — no
axis, no legend, nothing to interpret.

## Do's and Don'ts

### Do:

- **Do** compose from the existing utilities — `.panel`, `.panel-title`,
  `.field-label`, `.field-input`, `.chip`, `.btn-submit`, `.table-head-band` —
  before writing new CSS.
- **Do** give every number that shares a column with another number
  `tabular-nums`.
- **Do** put separation in a 1px `border` hairline and a tonal step first.
- **Do** let a wide table scroll inside its panel with an explicit `min-w`,
  rather than squeezing its columns.
- **Do** write four distinct empty states — loading, error, filtered-empty,
  genuinely empty — wherever a list can be empty.
- **Do** state a colour's meaning in words as well as in hue. Every coloured
  badge, segment and dot in this system also says what it is.
- **Do** keep one amber emphasis per view.

### Don't:

- **Don't** write a hex or `rgb()` value. Every colour is a semantic token, and
  `#059669` is the one sanctioned exception that already exists.
- **Don't** add a `dark` class to any element. `:root` is already the dark theme
  and the `.dark` block is a generic grey palette that would override this
  identity.
- **Don't** introduce a third font, or apply `.font-display` to body copy.
- **Don't** use red for emphasis or urgency. Red means something failed.
- **Don't** distinguish two things by two opacities of the same colour — use a
  luminance step, a different hue, or a different shape.
- **Don't** trade density for a phone layout. No role works on one, and the
  wide tables are a decision rather than an oversight.
- **Don't** style a table header per table. It is set once in
  `components/ui/table.tsx` and inherited everywhere.
