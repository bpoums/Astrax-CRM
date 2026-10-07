# 0009 — Placement rule: server-side, keyed on the customer's SSN, permanent, override by admin or general manager only

## Status
Current, added 2026-10-05. Built and live in the database but **switched off**
(`app_config.placement_rule_enabled = 'false'`) until the real agency/IMO/agent
mapping is entered and the new app is deployed.

## Context
Leads a carrier rejected were being re-submitted to the same carrier through
a different IMO, or to another carrier through the same IMO. That puts the
agency's licence at risk. Live data showed the practice, and it also showed
that "Decline" was being used for two different things: real carrier
rejections ("UNDERWRITING", "DUPE ON CORBRIDGE"), and fixable problems
("ACCOUNT ISSUE", "CARD"). In the fixable case the lead was corrected and
legitimately sent to the same carrier again, often within the hour.

## Decision
- **The rule.** A carrier rejection at IMO X → carrier C **blocks** carrier C
  under every other IMO, and **warns** about any different carrier under IMO X.
  Agency is recorded but plays no part in it.
  - *Revised 2026-10-06.* It first blocked every carrier under IMO X as well.
    That was relaxed to a warning: a different carrier under the same IMO is a
    legitimate separate application, and a hard block would have forced an
    admin override for each one.
  - **The warning needs "I understand".** The validator must tick it to save,
    and the database enforces that too (`p_acknowledge_warning`), so an edited
    browser can't skip it. The warning text and the acknowledgement are
    recorded on the lead's `validator_fields_set` event.
  - The warning is checked on save only, not again on accept: the hard block is
    the part that protects the licence; the warning is a prompt to confirm.
- **Keyed on the customer** (`ssn_normalized`), not the lead, so a re-upload
  or re-submission of the same person is caught. A lead with no SSN is matched
  only to itself.
- **Only `carrier_rejected` declines count.** The decline dialog makes the
  validator choose "Carrier rejected" or "Fixable issue". Old declines were
  classified from their reason text, and a blank or unclear reason doesn't
  block.
- **Permanent.** There's no expiry. The only exception is an **override by an
  admin or a general manager**, which applies to one lead and one IMO →
  carrier pair, with a required reason. The rejection itself is never deleted.
  - General managers were added on 2026-10-06 (there are several, against two
    admins) so approvals don't queue on a couple of people.
  - **No pass codes.** A generated code a validator enters was considered and
    rejected. The existing override already gives the same result with a
    named approver, the lead and the carrier it applies to, and a reason on the
    record. A code only proves someone held a string, it can be forwarded or
    reused, and it adds secrets to manage (expiry, single use, brute-force
    protection) for no new capability. If admins ever can't be reached fast
    enough, the next step is a "Request override" button with an approval list,
    not a code.
- **Enforced in the database:** `set_validator_fields` and
  `dispose_submission` call `placement_conflict`. The greyed-out dropdowns are
  a convenience over `placement_blocks`, and a stale or edited browser can't
  get past the RPCs.
- **Closed leads are history, not placements.** They're never re-checked, so
  mapping old accepted leads onto agencies/IMOs/agents can't be blocked by a
  rejection that came later.
- **Shipped behind a switch.** This is the one deliberate exception to "no
  feature flags". The live app calls the old 4-argument `set_validator_fields`
  and the carrier-only `decline_with_carriers`. Applying the new schema had to
  leave those working until the new app is deployed. The switch is a single
  `app_config` row, flipped by a migration in the same window as the deploy.
  Once it's on, the old overloads refuse with "refresh the page", and they can
  be dropped in a later migration.

## Consequences
- Validators can't accept until the mapping is complete: every agent must be
  appointed on the IMO → carrier pairs they actually write.
- On day one, ~13 open leads already had a final carrier that had previously
  declined that customer. They need a different carrier or an override.
- Validator self-submitted forms don't capture an IMO, so the rule doesn't see
  those placements (`docs/TODO.md`).
