# notion-worker-xero-invoice-sync

A [Notion Worker](https://developers.notion.com/workers) that syncs Xero sales
invoices (ACCREC) into a managed Notion database, and links each invoice to
the matching **Company** in the CRM and **FX Rate** in the FX Rates DB.

Xero is reached through the [Zapier SDK](https://docs.zapier.com/sdk) using
the existing `Xero work.flowers` connection — no direct Xero OAuth setup is
required.

## Capabilities

| Key | Mode | Schedule | What it does |
|---|---|---|---|
| `invoicesBackfill` | replace | manual | Paginates all sales invoices from Xero. Run once after first deploy. |
| `invoicesDelta` | incremental | every 15 minutes | Pulls invoices updated since the last successful run (using Xero's `If-Modified-Since` header). |

Both syncs share an `xero` pacer (8 req/s).

## Managed database schema

Worker-managed properties (defined in code, migrated on each deploy):

- `Invoice Number` (title) — from Xero `InvoiceNumber`
- `Xero Invoice ID` (rich text, primary key)
- `Reference` (rich text)
- `Status` (select: Draft / Submitted / Authorised / Paid / Voided / Deleted)
- `Issue Date` / `Due Date` / `Payment Date` (date)
- `Amount` (number) — Xero `Total`
- `Currency Code` (rich text, e.g. `SGD`)
- `Xero URL` (url)
- `Xero Contact ID` (rich text)
- `Matched Domain` (rich text) — debug field showing which key was used to match a Company (either `COM-N` or a domain)

User-added properties to set up in the Notion UI after first deploy (these are
preserved across deploys):

- `Company` — relation to Companies (`limit 1`)
- `Currency` — relation to FX Rates (`limit 1`)
- `FX Rate (USD)` — rollup of the `Rate (USD Base)` number on the linked Currency
- `Amount (USD)` — formula combining `Amount` and the FX rate rollup

## Relation matching

For each upserted invoice, the worker resolves and sets two relations via
`notion.pages.update` (one cycle after the row is first created):

- **Company** — prefers the Xero contact's `AccountNumber` if it parses to a
  number matching a Companies row's auto-increment `ID` (e.g. Xero
  `COM-421` → Company with `ID = 421`). Falls back to a **domain match**
  against the Companies `Website` property — using the contact's `Website`,
  then primary `EmailAddress`, then any `ContactPersons` email (skipping
  generic mailbox domains like gmail/outlook).
- **Currency** — Xero invoice `CurrencyCode` (e.g. `SGD`) → FX Rates row
  whose title equals that code.

## Project layout

```
src/
├── index.ts        # Worker, managed DB schema, pacer, syncs
├── xero.ts         # Direct Xero REST API calls via zapier.fetch
├── companies.ts    # Domain normalization + Companies/FX-Rates indexes
└── reconcile.ts    # Notion API updates for Company + Currency relations
```

The Worker fetches invoices using the Xero REST API directly (`zapier.fetch`
to `https://api.xero.com/api.xro/2.0/Invoices`) rather than Zapier's pre-built
`list_invoices` action — the pre-built action only returns ~5 records as a
dropdown sample, not the full dataset.

## Environment variables

Set via `ntn workers env set`. All are required except where noted.

| Name | Value |
|---|---|
| `NOTION_API_TOKEN` | Internal integration token. The integration must be connected to the managed Sales Invoices DB, the Companies DB, and the FX Rates DB. |
| `ZAPIER_CLIENT_ID` | From `npx zapier-sdk create-client-credentials`. |
| `ZAPIER_CLIENT_SECRET` | Same as above. Secret is shown once — save immediately. |
| `XERO_ZAPIER_CONNECTION_ID` | The Xero connection ID in Zapier (`02336808-1736-878b-a0a8-87e02bb0aec3` for `Xero work.flowers`). |
| `XERO_ORGANIZATION_ID` | The Xero tenant ID (`62699a8c-3351-40e8-9265-bdca5e037b03` for work.flowers). |
| `COMPANIES_DATA_SOURCE_ID` | `21991b07-11ac-80b0-b787-000b3d3995f6` |
| `FX_RATES_DATA_SOURCE_ID` | `19391b07-11ac-80b9-abab-000b44470272` |
| `SALES_INVOICES_DATA_SOURCE_ID` | Set this to the data source ID Notion created on first deploy (visible in `ntn workers sync status` as `https://www.notion.so/ds/<id>`). Without it, relation reconciliation is skipped. |

## First-time setup

```bash
npm install
ntn workers deploy                 # creates the managed Sales Invoices DB
```

In Notion: open the new Sales Invoices database and:

1. Connect the integration to the new DB, the Companies DB, and the FX Rates DB.
2. Add the user-managed properties listed above (`Company`, `Currency`, `FX Rate (USD)`, `Amount (USD)`).

Then set the remaining secrets and trigger the backfill:

```bash
ntn workers env set SALES_INVOICES_DATA_SOURCE_ID=<from sync status>
ntn workers deploy
ntn workers sync state reset invoicesBackfill
ntn workers sync trigger invoicesBackfill
```

The `invoicesDelta` sync runs automatically every 15 minutes thereafter.

## Operations

```bash
ntn workers sync status               # live dashboard
ntn workers runs list | head          # recent executions
ntn workers runs logs <runId>         # logs for a specific run
ntn workers sync state reset <key>    # restart from scratch
ntn workers sync trigger <key>        # run now
```

Common reasons relations stay empty:

- Integration not connected to the Companies / FX Rates DB.
- `SALES_INVOICES_DATA_SOURCE_ID` not set.
- Brand-new invoice — its page doesn't exist when reconciliation runs in the same cycle. The relation is set on the next cycle (~15 min lag).
- No `AccountNumber` and no resolvable non-generic domain on the Xero contact — `Matched Domain` will be empty.

## Constraints

- One-way sync only (Xero → Notion). Edits in Notion are not pushed back.
- Worker-managed schema means renames / type changes in code can drop the column. User-added properties (`Company`, `Currency`, `FX Rate (USD)`, `Amount (USD)`) survive.
- The Zapier connection must remain valid — if it expires, re-authenticate it in Zapier and redeploy.
