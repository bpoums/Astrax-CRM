# ASTRAX CRM: Business Rules

Plain-language guide to the rules the CRM enforces. Checked against the app code and the live database on 2026-10-13.

## How to read this guide

- **Blocked** means the system refuses the action and shows a message.
- **Warning** means the system shows a notice but lets the person carry on.
- A **lead** is one customer's sale record. A **closer** takes the sale on the phone. A **validator** double-checks it with the customer.
- **Submit** is the app's word for an approved lead. The other two outcomes are **Declined** and **Pending**.
- The **queue** is the list of leads waiting for a manager to hand out.
- Each rule says who it applies to. Rules marked **Not active yet** are built but switched off, or only partly built. They are collected in section 7.

---

## 1. Forms and duplicate checks

### 1.1 Duplicate SSN (the most important form rule)

When a closer or validator enters an SSN, the system looks for other leads that already have the same SSN. Archived leads are ignored. What happens depends on the outcome of the existing lead:

| The existing lead is... | What happens |
|---|---|
| **Submitted** (approved) | **Blocked**, unless CX has cleared it (see below). The form shows a red notice as soon as the SSN is typed, and the server refuses the save even if that notice does not show. |
| **Declined** | **Warning only**, in amber. The person may continue, because a different carrier may accept the customer. |
| **In progress** (no outcome yet, or Pending) | **Warning only**, in amber. |

**How a blocked SSN is cleared:** a CX agent (or a CX manager, admin, manager or general manager) marks the original approved lead with the tag **"Eligible For Second Policy"**. After that the same SSN can be submitted again. One cleared approved lead is enough, even if the customer has several. The tag can only be put on a lead that is Submitted and not archived. Closing managers cannot add this tag.

The same block applies to the closer form, the validator's own form, External Transfer, and leads sent in by a center's own system (API).

*Example:* A closer enters an SSN that belongs to a customer whose policy was Submitted last month. The form shows "Submitting will be blocked" and the save is refused. CX tags the old policy as eligible for a second policy, and the closer can then submit.

### 1.2 Required fields

- The **closer form** will not submit while any required field is empty. The message names the missing field.
- Required on the closer form: Full Name, Gender, Date of Birth, Age, State, Birth Country, Birth State (only when Birth Country is USA; otherwise it is filled in as "Outside USA"), SSN, Phone, Height, Weight, Residential Address, Smoker or Non Smoker, Proposed Carrier, Coverage Amount, Premium, Plan Type, Beneficiary Name and Relationship, Draft Date, Bank Draft (Yes/No), Account Title, Bank Name, Bank Type, Routing Number, Account Number.
- Optional on the closer form: Email, Zip Code, Doctor details, Health Conditions, Medications, Future Draft Date, Card Number, Expiry, CVC, Notes.
- The **validator form** has its own required list. It adds Agent Name, Policy Number, Agency Name, IMO Name, and both Draft Date and Future Draft Date. The carrier is picked from a list, not typed.

### 1.3 Live warnings while typing (never block)

These warnings appear under the field. The form still submits, because the customer may be reading out something unusual but correct.

- **SSN:** warns if it is not nine digits, is all one repeated digit, starts with 000, 666 or 900-999, has group 00, or ends in 0000.
- **Routing number:** warns if it is not nine digits or fails the bank checksum. A valid number shows a green tick.
- **Zip code:** warns if it is not five digits, or if it does not belong to the state typed.
- **State:** warns if the two letters are not a real US state code.
- **Card number:** warns if it is not 15 or 16 digits or fails the card checksum. A valid card shows its brand (Visa, Mastercard, Amex, Discover).
- **Expiry:** warns if it is not MM/YY, the month is not real, or the card has already expired.
- **Draft date:** warns on a **Saturday**, and gives a stronger warning on a **Sunday**, because banks do not process drafts on weekends. It does not block.

### 1.4 What happens to a submitted lead

- A **closer's** lead goes to the manager's queue, waiting to be assigned.
- A **validator's** own form is approved (Submit) immediately. It never enters the queue and cannot be assigned.
- **External Transfer** (closer only): the closer must pick a client to transfer to. The client list is managed by the admin. A closer only sees clients for their own center (or clients set to any center). The lead is then **parked**: it is hidden from the managers' queue until a general manager or admin moves it to validation. If the client is missing or unavailable, nothing is saved.
- **Center leads (API):** a partner center's own system can send leads in. Each center has its own key, and the lead lands in the manager queue like a normal closer lead. It has no approval step.
- A lead is stamped with the **center** of the person who submitted it at that moment. Later changes to the person's center do not change old leads.
- The ID and "Submitted By Role" on a lead are set by the system and cannot be edited by anyone.

---

## 2. Review workflow

### 2.1 The path of a lead

1. The closer submits. The lead waits in the manager queue.
2. A manager (or admin) **assigns** it to a validator.
3. The validator confirms "I'm ready". The **20-minute review window** starts.
4. The validator records an outcome:
   - **Submit:** the lead is closed. This is the only final outcome.
   - **Declined** or **Pending:** the outcome is recorded and the lead goes **back to the manager's queue** to be handled again.
   - **Hold:** the validator steps away. See 2.3.
   - **Can't take this:** the validator hands the lead back to the manager. See 2.4.
5. If the 20 minutes run out, the lead goes back to the queue marked as timed out.

### 2.2 Assigning

- Only managers and admins can assign.
- A lead can be assigned only if it is waiting (never assigned, or timed out) and was submitted by a closer. Validator-submitted leads are never assigned.
- A lead that a validator currently has open cannot be reassigned or bulk-assigned.
- Bulk assigning goes one lead at a time. If one fails, the others still go through, and the message reports how many failed.

### 2.3 The 20-minute review window and holds

- The window is **20 minutes**, set by the admin, and can be switched off. It is enforced by the server in three places. The countdown on screen is only a display.
- After 20 minutes the lead is taken back **automatically within about a minute**. The validator no longer sees it and cannot record an outcome. It is counted as a timeout against that validator.
- **Hold** lets a validator step away. The lead stays assigned to them. Reopening it starts the **full 20 minutes again**, not the time that was left.
- A validator can hold a lead at most **5 times** (the admin sets this; 0 means unlimited). The sixth attempt is refused.
- Managers and admins are not bound by the window when recording an outcome.

### 2.4 Rejecting an assignment

A validator can hand an assigned lead back with "Can't take this" and an optional reason. It returns to the manager queue and the rejection is counted and shown on the lead.

### 2.5 What a validator must fill in before Submit

For a closer's lead, **Submit is refused** until all five are saved: **Agency, IMO, Final Carrier, Agent Name, Policy Number**. The Submit button is disabled with an explanation, and the server refuses it even if the button were bypassed. The Final Carrier can differ from the Proposed Carrier the closer pitched. Validator, manager, general manager and admin can save these details.

### 2.6 Declining

To decline, the validator picks **one or more carriers** that said no, and the screen **requires a written reason**. The lead goes back to the queue and each carrier decline is stored. The reason is used to label the decline as a real carrier rejection or a fixable issue.

### 2.7 Archiving

- Only managers and admins can archive or restore a lead.
- Archived leads disappear from every queue, the timeout check, and the reports (unless the archived view is switched on).
- Archiving removes any assignment.
- Archived leads cannot be edited.

### 2.8 Other workflow facts

- Every step is written to the lead's history (who, what, when).
- Every change to a lead is mirrored to a **Google Sheet** automatically within about a minute. Under heavy load it can lag by minutes. Nobody works from the Sheet. It is a reporting copy.
- Search in the manager queue only filters the open tab. Other tabs' counts stay whole.
- "Draft date" times and report days follow **Pacific time**.

---

## 3. Roles and access

The database decides what each person can see and do. Hiding a button is only a convenience.

| Role | Can see and do |
|---|---|
| **Admin** | Everything: users, settings, all leads, parked leads, exports, import history. |
| **Manager** | The validation queue. Assigns, records outcomes, archives, approves or rejects imported batches, edits leads, fills missing information, can reveal card details, tags second-policy leads. Cannot see parked leads. |
| **Closing manager** | Closer leads **from their own center only**. Edits lead details (every edit is recorded). Can see CX statuses but not change them. With no center set, sees nothing. |
| **General manager** | Same screen as the closing manager, but **all centers** and both closer and validator leads. Also releases parked leads, can reveal card details, and tags second-policy leads. |
| **Reporting manager** | Read-only business-wide reports. Cannot change anything. |
| **Closer** | Submits the form. Sees only their own "Forwarded Leads", with SSN, bank and card fields removed. |
| **Validator** | Only leads assigned to them, and only inside the review window. Can also submit their own form. |
| **Data uploader** | Upload screen only, and only the leads they imported. |
| **CX manager / CX agent** | The CX pipeline: approved leads, plus leads they sent back, until one of them removes the lead. |

Account rules:

- **There is no public sign-up.** Only an admin can create an account, by invitation. The invited person sets their own password.
- Switching an account to **inactive** removes all its access at once. If they are logged in, they are signed out within seconds. The system refuses to deactivate or demote the **last active admin**.
- The admin can **suspend the whole CRM** for everyone except admins, for a set time or until resumed. Non-admins are signed out and see a message.
- A closing manager's center is what limits their view, so a center must be set when they are invited. Closers, data uploaders and validators also need a center.

---

## 4. Imports (spreadsheet uploads)

- The data uploader's file is read **in their browser**. Nothing is sent until they press Import.
- The system **trusts what is in a cell over the column heading**. A card number under a heading like "Routing" is still recognized and flagged.
- **Flags** mark suspicious values (bad SSN, bad card, etc.). Flags **never block** an import. Correcting a value re-checks it. "Ignore without fixing" hides a flag and is clearly marked as not fixing anything.
- **Duplicates inside the file** are matched by SSN, then phone number, then name plus date of birth. Only one row of each group is imported. The others stay visible, greyed out and editable, so a wrong match can be fixed.
- Dates are standardized to **MM/DD/YYYY**. Only the first sheet of an Excel file is read.
- **Manager approval gate:** imported leads wait for a manager or admin to approve the batch. The manager can approve all, approve with some leads rejected, or reject the whole batch. Rejected leads are archived. Until approved, the leads are not in the queue.
- **Missing information:** an uploaded lead missing any of 15 core fields (name, gender, date of birth, age, state, SSN, phone, address, zip, proposed carrier, coverage, premium, plan type, beneficiary, draft date) is labelled **Missing info**. Five bank fields (account title, bank name, bank type, routing, account number) are tracked separately. This is only a label and never blocks assigning or approving. Managers, general managers and admins can fill them in.
- Draft dates written as a pattern ("3rd of the month") are turned into the next real date and updated every night. A pattern that cannot become one date ("Every 2nd Friday") is left as written.
- Card numbers and CVVs from a file are **kept apart from the lead details** and never sent to the Google Sheet.
- After import, an uploader can see only the last four digits of a card. Before import, the uploader's own preview shows full card numbers, because they already have the source file open.

---

## 5. CX pipeline (after a lead is approved)

- The pipeline holds leads that CX has not finished with: approved leads, plus leads CX sent back for re-checking, until a CX person removes them.
- There are **four independent statuses** per lead. Changing one never changes another, and none of them changes the lead's Submit/Declined state.
  - **Policy:** Pending Review, Requirements Pending, Approved, Issued / Active, Declined, Withdrawn, Cancelled, Lapsed, Rewrite, Additional.
  - **Premium:** Draft Pending, First Draft Paid, Current, Payment Failed, Past Due, Grace Period, Lapsed.
  - **Commission:** Pending, Earned, Paid, Chargeback, Partially Charged Back.
  - **Chargeback:** Potential, Pending, Applied, Recovered.
- Only CX agents, CX managers and admins can change statuses. Everyone else sees them read-only. The status lists are managed by the admin. Items can be deactivated but never deleted.
- **Return for Validation:** CX can send an approved lead back. It clears the outcome, the final carrier, agent and policy number, and returns to the **manager queue** on a "CXA Returned" tab with CX's reason shown. The lead stays on CX's list during the re-check. The old statuses stay editable.
- **Remove from pipeline:** CX can remove a lead from their list. This is not archiving: the lead stays in reports, exports and history. Only an admin can restore it.
- CX can correct a lead's details and its bank fields on their own pipeline leads. They can **never** edit a card number or CVV.
- Tags: see the second-policy tag in section 1.1.

---

## 6. Security and payment data

- **Bank and card data from imports never goes in the lead details**, so it is never copied to Google Sheets. It is stored separately and only reachable through checked functions.
- **Full card numbers and CVVs** can be viewed only by: admin, manager, general manager, or the validator who has the lead open in review. Closing managers, CX and uploaders cannot. **Every view is logged.** Everyone else sees only the last four digits.
- Admin, manager and general manager can **add** a missing card number, expiry or CVC. A stored value is never shown back in the entry box.
- **Bank fields** (payment type, bank name, routing, account number, account title, expiry) can be edited by admin, manager, general manager, and by CX on their own pipeline leads.
- **Automatic deletion, every night:** the **CVV is erased** once the lead has an outcome, or after **30 days**, whichever comes first. The **card number is erased** 90 days after the lead was created or got an outcome, whichever comes first. The last four digits stay.
- **Edits are recorded.** Every change to a lead's details is stored with who made it and the before and after values.
- **Fix, then clear:** a data flag is cleared only after the value has been corrected, or when someone chooses "Ignore without fixing".
- If a person is not allowed to see something, the screen says "not authorized". It does not pretend there is no data.
- **Exports** (CSV or Excel of approved leads) are admin-only, limited to 500 rows at a time.
- A center's partner key is shown **once** when created. Creating a new key cancels the old one.
- Admins can suspend the system, change the review window, hold limit and retention settings. Setting changes are recorded.

---

## 7. Not active yet

- **Placement rule (built, switched OFF).** Purpose: protect carrier licensing by stopping a customer a carrier rejected from being sent to that same carrier through another IMO. When switched on: Agency, IMO, Final Carrier and Agent become pick-lists tied to a mapping the admin maintains. Re-shopping a rejected carrier under another IMO is **blocked** (only an admin or general manager can override, with a written reason). A different carrier under the same IMO gives a **warning** the validator must tick to acknowledge. Today agency and IMO are typed as free text with no checks. It stays off until the real agency, IMO and agent mapping is entered.
- **CX tabs for Transfer, Chargeback and Analytics** show "Coming soon". Only Customers Pipeline is built.
- **Audit tab** (history of settings changes and card views) is built but hidden. The records are still being kept.
- **The two card and CVV deletion-day settings** cannot currently be changed from the admin screen, although the nightly deletion runs using the stored values.

---

## 8. Known limitations

- **Card details typed on the closer form are saved with the lead details** (the form has optional Card Number, Expiry and CVC fields), and those details are copied to the Google Sheet like the rest of the form. The separation described in section 6 applies to imported leads only.
- Some detail screens show bank and card text from the lead details **unmasked** to the roles that can open them.
- The validator's own form does not record an IMO, so the placement rule (when on) cannot check those sales.
- There is no grace period on the 20-minute window. Expiry takes effect at the next check, up to about a minute later.
- There is no log of who downloaded an export.
- Search in some screens needs at least four SSN digits.

---

## 9. Needs your confirmation

- The developer notes say the Submit check needs three validator fields. The **live system requires five** (section 2.5), and this guide follows the live system.
- The developer notes imply the CVV is deleted after 7 days by default. The **live setting is 30 days** (section 6).
- The report-retention setting is currently **0**. It was not confirmed whether 0 means "keep everything" or "delete nothing".
