# Where to change things

A plain-language map of this app. Look up what you want to change, and it tells
you which file to open and roughly where.

**Two things to know before you start:**

1. **Line numbers drift.** As soon as anyone edits a file, the numbers below are
   slightly off. Every entry also names the thing you are looking for (like
   `STATUS_LABEL`) — search for that name in the file and you will always land
   in the right place, even a year from now.
2. **Some things are not in the code at all.** Carriers, CX statuses, the review
   timer, and users are all managed from the **Admin → Settings** screen in the
   running app. Changing those needs no code and no deploy. They are marked
   **[in the app]** below.

---

## Quick index

| I want to change…                                        | Go to                                                      |
| -------------------------------------------------------- | ---------------------------------------------------------- |
| The words on a status badge ("Unassigned", "Attempting") | [Status words](#1-status-words)                            |
| The words on an outcome badge ("Submitted", "Declined")  | [Outcome words](#2-outcome-words)                          |
| A badge's colour                                         | [Badge colours](#3-badge-colours)                          |
| Which badge wins when a lead has several problems        | [The badge order](#4-the-badge-order-manager-queue)        |
| Any colour anywhere                                      | [Colours in general](#5-colours-in-general)                |
| Fields on the closer's form                              | [Closer form fields](#6-closer-form-fields)                |
| Fields on the validator's form                           | [Validator form fields](#7-validator-form-fields)          |
| The warning notes under form fields                      | [Form warnings](#8-form-warnings)                          |
| Carrier names, order, spellings                          | [Carriers](#9-carriers-in-the-app) **[in the app]**        |
| CX statuses (Policy, Premium, Commission, Chargeback)    | [CX statuses](#10-cx-statuses-in-the-app) **[in the app]** |
| The review countdown, hold limit, retention              | [Settings](#11-settings-in-the-app) **[in the app]**       |
| Who can see which screen                                 | [Roles](#12-roles-and-permissions)                         |
| Columns the uploader can import into                     | [Import fields](#13-import-fields)                         |
| The look of panels, buttons, inputs                      | [Reusable styles](#14-reusable-styles)                     |
| Tabs on the Admin page                                   | [Admin tabs](#15-admin-tabs)                               |
| Centres (the call centres leads are taken in)            | [Centers](#16-centers-in-the-app) **[in the app]**         |
| Columns and filters on the closing desk                  | [The closing desk](#17-the-closing-desk)                   |

---

## 1. Status words

The five stages a lead moves through. The stored database values never change —
only what the screen calls them.

**File:** [src/components/ops.tsx:302](src/components/ops.tsx#L302) — `STATUS_LABEL`

```
pending_manager  →  "Unassigned"
assigned         →  "Assigned"
in_review        →  "Attempting"
returned_timeout →  "Returned"
closed           →  "Completed"
```

**Example — rename "Unassigned" to "Pending":** change the text on the
`pending_manager` line to `"Pending"`. That is the only edit. Every screen —
manager queue, admin table, closing desk, filter dropdowns — reads this one map,
so they all change together. Do **not** change the left-hand side
(`pending_manager`); that is the database value and changing it breaks things.

---

## 2. Outcome words

What a validator or manager decided about a lead.

**File:** [src/components/ops.tsx:33](src/components/ops.tsx#L33) — `DISPOSITION_LABEL`

```
accepted  →  "Submitted"
declined  →  "Declined"
pending   →  "Pending"
```

Same rule: change the right side only. `accepted` stays `accepted` in the
database forever — the app just shows the word "Submitted" for it.

**Other words in the same file:**

- Event names in timelines — `EVENT_LABEL`, [ops.tsx:222](src/components/ops.tsx#L222)
- "Live" vs the centre name for imported leads — `sourceLabel`, [ops.tsx:265](src/components/ops.tsx#L265)
- Role names shown to users — `ROLE_LABEL`, [src/lib/auth.tsx:59](src/lib/auth.tsx#L59)

---

## 3. Badge colours

All in [src/components/ops.tsx](src/components/ops.tsx):

| Badge                                                  | Where               | Line                               |
| ------------------------------------------------------ | ------------------- | ---------------------------------- |
| Outcome badges (Submitted / Declined / Pending)        | `DISPOSITION_BADGE` | [316](src/components/ops.tsx#L316) |
| "On Hold" badge                                        | `ON_HOLD_BADGE`     | [326](src/components/ops.tsx#L326) |
| Plain status badge                                     | `StatusBadge`       | [430](src/components/ops.tsx#L430) |
| Queue badges (Unassigned / Unassigned! / Rejected by…) | `QueueStatusBadge`  | [369](src/components/ops.tsx#L369) |

Use the named colours, not colour codes: `destructive` (red), `accent` (amber),
`muted-foreground` (grey), `secondary`. See
[Colours in general](#5-colours-in-general) below for why.

**One known exception:** the green on "Submitted" is a hard-coded `emerald`
because there is no green colour token in this app. It is deliberate — a
red/amber/green scale was asked for. Leave it, or add a proper green token; do
not quietly change it back to amber.

---

## 4. The badge order (manager queue)

When a lead has several things wrong at once, this decides which badge shows.
Highest wins:

1. On hold
2. Returned by timeout → "Unsubmitted by {name}"
3. Rejected by a validator → "Rejected by {name}"
4. Came back declined → **"Unassigned!"** in red, plus the carriers that said no
5. Never touched → "Unassigned" in grey
6. Anything else → the plain status badge

**File:** [src/components/ops.tsx:369](src/components/ops.tsx#L369) — `QueueStatusBadge`

This one component is used by the manager queue, the admin Submissions table and
the closing desk, so all three always agree. Change the order here and it
changes in all three.

---

## 5. Colours in general

**File:** [src/styles.css](src/styles.css)

- The actual colours live at [:root, line 64](src/styles.css#L64). Change
  `--accent` there and every amber thing in the app changes at once.
- **Never write a colour code** (`#ff9900`, `rgb(...)`) anywhere else. Always use
  a name: `bg-accent`, `text-destructive`, `border-border`.
- **Careful:** the `.dark` block at [line 100](src/styles.css#L100) is a leftover
  grey theme that does **not** match the brand. `:root` is already the dark
  theme. Never put `class="dark"` on anything.

---

## 6. Closer form fields

**File:** [src/components/closer-form.tsx:34](src/components/closer-form.tsx#L34) — `SECTIONS`

Three groups: Customer (line 36), Policy (line 67), Banking (line 90).

**To add a field**, add a line inside the right group:

```ts
{ label: "Middle Name", type: "text", required: true },
```

`type` can be `text`, `number`, `date`, `textarea`, `radio` (needs
`options: [...]`), or `carrier` (fills itself from the carriers table).
Add `span: "sm:col-span-2"` to make it double width.

> ### ⚠ The label is also the spreadsheet column
>
> Whatever you type as `label` becomes the key stored in the database **and the
> column heading in Google Sheets**. Renaming a label renames a Sheet column
> from that point on — old leads keep the old name. Rename only when you mean it.

**Bonus:** adding a field here automatically adds it as an import target for the
uploader — see [Import fields](#13-import-fields).

Do **not** touch the age-from-birthday, SSN formatting, star sign, or ZIP weather
logic further down the file. They are fiddly and working.

---

## 7. Validator form fields

This form changes shape depending on the carrier.

**File:** [src/components/validator-form.tsx](src/components/validator-form.tsx)

- **Line 37 — `F`**: the catalogue of every available field, written once.
- **Line 130 — `AGENCY_SECTIONS`**: which fields each carrier's form shows, in
  order. Four carriers have their own layout: TransAmerica, Amicable,
  Insta Brain, Corbridge.
- **Line 322 — `DEFAULT_SECTIONS`**: what a carrier with no layout of its own
  gets. Any new carrier added in Settings uses this until you give it a layout.

**To add a field to one carrier's form:** add it to `F` first if it does not
exist, then add `F.yourField` to that carrier's list in `AGENCY_SECTIONS`.

**To give a new carrier its own layout:** add a block to `AGENCY_SECTIONS` keyed
by the carrier's exact name as spelled in Settings.

Same spreadsheet-column warning as above applies to every `label` here.

---

## 8. Form warnings

The small notes under a field ("that ZIP is not in that state", etc.).

**File:** [src/lib/form-warnings.ts:50](src/lib/form-warnings.ts#L50) — `fieldWarning`

Used by the closer form, the validator form and the closing desk editor, so a
rule added here shows up in all three. Warnings are advice only — they never
stop someone submitting.

---

## 9. Carriers **[in the app]**

**No code change needed.** Go to **Admin → Settings → Carriers**.

There you can:

- **Add** a carrier
- **Rename** one
- **Reorder** them with the ↑ ↓ buttons — this order is the order the chips
  appear in on both forms and in the decline dialog
- **Deactivate** one — it disappears from the forms but all its history stays
- **Add spellings** (aliases) — the variants that show up in uploaded files, like
  `GW's` for `GWS`. Adding one stops the importer flagging that spelling.
  Capitals and punctuation are already ignored, so you only need an alias when
  the actual letters differ (`Trans America` → `TransAmerica`).

There is no delete, on purpose — declines point at these records.

> ### ⚠ Renaming a carrier starts a new Google Sheet tab
>
> The Sheet tab is named after the carrier stored on each lead. Rename a carrier
> and new submissions go to a new tab; leads already submitted stay on the old
> one. The warning is repeated on screen next to the Rename button.

**Code side** (rarely needed): the panel itself is
[src/components/carrier-admin.tsx](src/components/carrier-admin.tsx), and the
matching rules for uploaded files are in
[src/lib/normalize/carriers.ts](src/lib/normalize/carriers.ts).

---

## 10. CX statuses **[in the app]**

The four customer-lifecycle statuses (Policy, Premium, Commission, Chargeback)
and their options.

**No code change needed.** Go to **Admin → Settings → CX status options** — add,
rename, recolour, reorder or deactivate any option.

**Code side, only if you need a fifth category or a new colour tone:**
[src/lib/cx-status.ts](src/lib/cx-status.ts) — `CX_CATEGORIES` (line 17),
`CATEGORY_LABEL` (21), `STATUS_TONES` (29), `STATUS_TONE_CLASS` (67).
Changing the category list needs matching database work, so treat it as a real
project, not a tweak.

---

## 11. Settings **[in the app]**

**Admin → Settings → Operational settings.** All take effect immediately, no
deploy:

- **Review timeout on/off** and **review window (minutes)** — how long a
  validator has on a lead
- **Maximum holds** — how many times they can pause the timer (0 = unlimited)
- **Reporting retention (days)** — how long a closed lead stays in Reporting
  before it is auto-archived (0 = keep forever). Only closed, disposed leads age
  out; open work is never touched
- **CVV purge** and **card purge (days)** — when stored card data is wiped

**Code side:** [src/components/admin-settings.tsx:53](src/components/admin-settings.tsx#L53)
— `KEYS`. Adding a _new_ setting here also needs it added to two database
functions first, so it is not a code-only change.

---

## 12. Roles and permissions

**File:** [src/lib/auth.tsx](src/lib/auth.tsx)

- **Line 43 — `roleHome`**: which screen each role lands on after signing in.
- **Line 59 — `ROLE_LABEL`**: what each role is called on screen.
- **Line 76 — `requireRole`**: the guard each screen uses.

The nine roles, and what each one is for:

| Role                | Lands on     | Sees                                                       |
| ------------------- | ------------ | ---------------------------------------------------------- |
| **admin**           | `/admin`     | everything, plus Users and Settings                        |
| **manager**         | `/manager`   | the validation queue — assigns, disposes, archives         |
| **closing_manager** | `/closing`   | closer leads **in their own centre**                       |
| **general_manager** | `/closing`   | closer **and** validator leads, **across every centre**    |
| **closer**          | `/closer`    | the submission form, nothing else                          |
| **validator**       | `/validator` | only leads assigned to them, only inside the review window |
| **data_uploader**   | `/upload`    | that screen only, and only the leads they imported         |
| **cxm** / **cxa**   | `/cx`        | approved leads; they set the four CX statuses              |

**Closing manager and general manager share one screen.** They open the same
route and get the same edit controls — the only difference is how much the
database hands back, and that is decided by the database, not by the code. There
is no "if general manager" branch anywhere in the closing desk, and there should
not be one. See [The closing desk](#17-the-closing-desk).

### Adding a new role

The role has to exist in the database first; nothing below creates one.

1. Run `npm run types`. Every role map is typed off the generated list, so the
   compiler will then point at each place that has not accounted for the new
   role — you cannot forget steps 2 and 3.
2. `roleHome` and `ROLE_LABEL` in [src/lib/auth.tsx](src/lib/auth.tsx).
3. The `requireRole([...])` list at the top of **every route file the role may
   open** — for example
   [src/routes/_authenticated/closing.tsx:21](src/routes/_authenticated/closing.tsx#L21).
   This is the step the compiler cannot catch for you.
4. `ROLES` in
   [src/components/user-admin.tsx:26](src/components/user-admin.tsx#L26) — one
   list, driving both the Add User chips and the role dropdown in the user table.
5. Only if the role must be pinned to a single centre: `CENTER_ROLES` in
   [src/lib/centers.ts:46](src/lib/centers.ts#L46). This is what makes the Add
   User form demand a centre. A general manager is deliberately **not** in it —
   they span all centres.

**Important:** the real security is in the database, not here. `requireRole` only
stops someone opening a page that would be empty anyway. Adding a role to the
lists above does **not** grant it access to any data — that needs database work.

**To change who a user is:** Admin → Users. Invite people, change their role, or
deactivate them there. Deactivating removes all their access instantly.

---

## 13. Import fields

The list of things the uploader can map a spreadsheet column onto.

**File:** [src/lib/canonical-fields.ts](src/lib/canonical-fields.ts)

This list is **built automatically from the closer form**, so you usually change
nothing here — add a field to `SECTIONS` and it becomes an import target by
itself.

Open this file only when you want to:

- teach the importer other names for a column (`ANNOTATIONS`, line 30) — for
  example that a column headed "DOB" means Date of Birth
- change the card fields, which are the only ones written out by hand here
  (`CARD_FIELDS`, line 162)

The detection rules themselves live in [src/lib/normalize/](src/lib/normalize/)
and are covered by tests — run `npm test` after touching anything there.

---

## 14. Reusable styles

**File:** [src/styles.css](src/styles.css). Build screens out of these instead of
inventing new styling:

| Class                    | What it is                                               | Line                       |
| ------------------------ | -------------------------------------------------------- | -------------------------- |
| `.panel`                 | the standard card container                              | [167](src/styles.css#L167) |
| `.panel-title`           | small uppercase section heading                          | [190](src/styles.css#L190) |
| `.field-label`           | small uppercase label above a value                      | [238](src/styles.css#L238) |
| `.field-input`           | standard text input                                      | [249](src/styles.css#L249) |
| `.chip` / `.chip-active` | the pill buttons                                         | [273](src/styles.css#L273) |
| `.btn-submit`            | the amber main button                                    | [297](src/styles.css#L297) |
| `.font-display`          | heading typeface                                         | [163](src/styles.css#L163) |
| `.table-head-band`       | table header strip — styled once, applies to every table | [205](src/styles.css#L205) |

House style: dense and small. Amber is the only accent — one emphasis per screen.
Red is only for timeouts and declines.

---

## 15. Admin tabs

**File:** [src/routes/_authenticated/admin.tsx:18](src/routes/_authenticated/admin.tsx#L18) — `TABS`

Add, rename or reorder the tabs on the Admin page. Two are commented out
(Imports, Audit) and can be switched back on by uncommenting them in both the
`TABS` list and the matching block further down.

---

## 16. Centers **[in the app]**

The call centres leads are taken in.

**No code change needed.** Go to **Admin → Settings → Centers** to add, rename,
reorder or deactivate one. As with carriers there is no delete, on purpose —
people and leads both point at these records.

Two things a centre does, and they are not the same thing:

- **On a person** — a closer's centre is stamped onto every lead they submit; a
  closing manager's centre is what their whole desk is scoped to. A closing
  manager with no centre set sees **nothing at all**, and the closing desk says
  so in place of the usual "no leads yet".
- **On a lead** — the centre's name **as it stood when the lead was taken**, kept
  on the row itself.

> ### Renaming a centre is safe
>
> Unlike a carrier rename, this does not split any history. Each lead carries its
> own copy of the centre name from the day it was submitted, so a rename moves
> the label on the pickers and leaves what already happened alone.

**Code side** (rarely needed):
[src/components/center-admin.tsx](src/components/center-admin.tsx) is the panel,
[src/lib/centers.ts](src/lib/centers.ts) is the shared list and the
`centerRequired` rule.

---

## 17. The closing desk

The screen at `/closing`, shared by the closing manager and the general manager.

**File:** [src/components/closing-desk.tsx](src/components/closing-desk.tsx)

- **Who gets in** —
  [src/routes/_authenticated/closing.tsx:21](src/routes/_authenticated/closing.tsx#L21).
- **Line 101 — `BASE_SELECT`**: the fields fetched for each row. A column you
  want to show has to be listed here first, and added to the `ClosingRow` type
  just below it.
- **Around line 390 — the table header**: the columns, in order. Widths are
  fixed (`w-32`, `w-28`…), so if you add a column, raise the table's
  `min-w-[100rem]` by the same amount — otherwise the Customer column, the only
  one with no set width, gets squeezed instead. The empty-state row's `colSpan`
  counts columns too.
- **Around line 313 — the filter row**: Validation Status, Disposition and
  Center, all built from the same small `FilterSelect` at the bottom of the
  file. A new filter is one `FilterSelect`, one piece of state, and that state
  added to the query key, the page reset, `filtersActive` and `clearFilters`.

**The Center column** shows the name stamped on the lead. For a closing manager
it reads the same on every row — they only ever see one centre — which matches
how the manager queue and Reporting already show it. For a general manager it is
the column that tells their rows apart. The filter beside it matches on the
centre's **id**, not its name, so a rename cannot quietly empty a filter someone
left applied; retired centres stay in the list, marked `(inactive)`, because
leads taken in them are still on the desk.

**Not filtered here.** The desk asks the database for submissions and shows what
comes back. Which leads that is — one centre or all of them, closer leads only or
validator leads too — is decided entirely by the database. Do not add a filter
here to "help": it would duplicate a rule that lives in one place, and would
silently disagree with it the day that rule changes.

The four CX statuses are **read-only** on this screen. Moving a lead through the
customer lifecycle is the CX team's job, and the database refuses anyone else —
a control that always fails is worse than no control.

---

## Things that must change together

- **The app's web address** lives in **three** places and all three must match or
  the login emails silently break. See the "app address lives in THREE places"
  section in [CLAUDE.md](CLAUDE.md).
- **A form field label** = the database key = the Google Sheet column heading.
  One rename, three consequences.
- **A carrier name** = the Google Sheet tab name for validator submissions.

## Never edit these by hand

- [src/integrations/supabase/types.ts](src/integrations/supabase/types.ts) —
  generated. Run `npm run types` instead.
- [src/routeTree.gen.ts](src/routeTree.gen.ts) — generated. The dev server
  rebuilds it.
- Anything in the database — tables, columns, permissions. It is already set up
  and the app is built to match it.

## After you change something

```
npm run dev        # see it locally
npx tsc --noEmit   # check nothing broke
npm test           # only needed if you touched src/lib/normalize
npm run build
npx wrangler deploy --compatibility-date 2026-08-01
```

That `--compatibility-date` flag is required — see [CLAUDE.md](CLAUDE.md) for
why, and for the deploy details.
