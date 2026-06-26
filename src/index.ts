import { Worker } from "@notionhq/workers";
import * as Schema from "@notionhq/workers/schema";
import * as Builder from "@notionhq/workers/builder";
import { getNotion, type NotionClient } from "./notion.js";

import {
	fetchAllContacts,
	fetchInvoicesPage,
	mapXeroStatus,
	toIsoDate,
	toIsoDateTime,
	toNumber,
	xeroInvoiceUrl,
	type XeroContact,
	type XeroInvoice,
} from "./xero.js";
import {
	buildCompanyIndex,
	buildCurrencyIndex,
	parseAccountNumber,
	pickContactDomain,
	type CompanyIndex,
	type CurrencyIndex,
} from "./companies.js";
import { reconcileInvoiceRelations, type InvoiceRelations } from "./reconcile.js";

const worker = new Worker();
export default worker;

const xeroPacer = worker.pacer("xero", {
	allowedRequests: 8,
	intervalMs: 1000,
});

// Notion's public API allows ~3 req/s. The auxiliary reads/writes (Company & FX
// indexes, relation reconciliation) go through Zapier's Notion connection, so we
// pace them ourselves rather than relying on a NOTION_API_TOKEN integration.
const notionPacer = worker.pacer("notion", {
	allowedRequests: 3,
	intervalMs: 1000,
});

const notion = getNotion(notionPacer);

const salesInvoices = worker.database("salesInvoices", {
	type: "managed",
	initialTitle: "Sales Invoices",
	primaryKeyProperty: "Xero Invoice ID",
	schema: {
		properties: {
			"Invoice Number": Schema.title(),
			"Xero Invoice ID": Schema.richText(),
			Reference: Schema.richText(),
			Status: Schema.select([
				{ name: "Draft", color: "gray" },
				{ name: "Submitted", color: "blue" },
				{ name: "Authorised", color: "yellow" },
				{ name: "Paid", color: "green" },
				{ name: "Voided", color: "purple" },
				{ name: "Deleted", color: "orange" },
			]),
			"Issue Date": Schema.date(),
			"Due Date": Schema.date(),
			"Payment Date": Schema.date(),
			Amount: Schema.number(),
			"Currency Code": Schema.richText(),
			"Xero URL": Schema.url(),
			"Contact Name": Schema.richText(),
			"Xero Contact ID": Schema.richText(),
			"Matched Domain": Schema.richText(),
		},
	},
});

type BackfillState = { page: number };
type DeltaState = { lastSyncIso?: string };

function maybeDate(s: string | null | undefined) {
	const d = toIsoDate(s ?? null);
	return d ? Builder.date(d) : [];
}

function invoiceProperties(invoice: XeroInvoice, matchedDomain: string | null) {
	return {
		"Invoice Number": Builder.title(invoice.InvoiceNumber ?? invoice.InvoiceID),
		"Xero Invoice ID": Builder.richText(invoice.InvoiceID),
		Reference: Builder.richText(invoice.Reference ?? ""),
		Status: Builder.select(mapXeroStatus(invoice.Status)),
		"Issue Date": maybeDate(invoice.Date),
		"Due Date": maybeDate(invoice.DueDate),
		"Payment Date": maybeDate(invoice.FullyPaidOnDate),
		Amount: Builder.number(toNumber(invoice.Total) ?? 0),
		"Currency Code": Builder.richText(invoice.CurrencyCode ?? ""),
		"Xero URL": Builder.url(xeroInvoiceUrl(invoice.InvoiceID)),
		"Contact Name": Builder.richText(invoice.Contact?.Name ?? ""),
		"Xero Contact ID": Builder.richText(invoice.Contact?.ContactID ?? ""),
		"Matched Domain": Builder.richText(matchedDomain ?? ""),
	};
}

let contactIndexCache: { fetchedAt: number; index: Map<string, XeroContact> } | null = null;
const CONTACT_CACHE_MS = 10 * 60 * 1000;

async function getContactIndex(): Promise<Map<string, XeroContact>> {
	if (contactIndexCache && Date.now() - contactIndexCache.fetchedAt < CONTACT_CACHE_MS) {
		return contactIndexCache.index;
	}
	await xeroPacer.wait();
	const contacts = await fetchAllContacts();
	const index = new Map<string, XeroContact>();
	for (const c of contacts) {
		if (c.ContactID) index.set(c.ContactID, c);
	}
	contactIndexCache = { fetchedAt: Date.now(), index };
	return index;
}

type ResolvedMatch = {
	companyPageId: string | null;
	currencyPageId: string | null;
	matchKey: string; // for the "Matched Domain" debug column
};

async function resolveMatchesForBatch(
	invoices: XeroInvoice[],
	companies: CompanyIndex | null,
	currencies: CurrencyIndex | null,
): Promise<Map<string, ResolvedMatch>> {
	const contactIndex = await getContactIndex();
	const out = new Map<string, ResolvedMatch>();

	for (const inv of invoices) {
		let companyPageId: string | null = null;
		let matchKey = "";

		const contact = inv.Contact?.ContactID ? contactIndex.get(inv.Contact.ContactID) : undefined;

		if (contact && companies) {
			const acctNum = parseAccountNumber(contact.AccountNumber);
			if (acctNum != null) {
				const id = companies.byId.get(acctNum);
				if (id) {
					companyPageId = id;
					matchKey = `COM-${acctNum}`;
				}
			}
			if (!companyPageId) {
				const domain = pickContactDomain(contact).domain;
				if (domain) {
					matchKey = domain;
					const id = companies.byDomain.get(domain);
					if (id) companyPageId = id;
				}
			}
		}

		const currencyCode = (inv.CurrencyCode ?? "").toUpperCase().trim();
		const currencyPageId = currencies && currencyCode ? (currencies.get(currencyCode) ?? null) : null;

		out.set(inv.InvoiceID, { companyPageId, currencyPageId, matchKey });
	}

	return out;
}

async function buildChangesAndReconcile(
	invoices: XeroInvoice[],
	notion: NotionClient,
): Promise<ReturnType<typeof toUpsertChange>[]> {
	const companiesDataSourceId = process.env.COMPANIES_DATA_SOURCE_ID;
	const fxRatesDataSourceId = process.env.FX_RATES_DATA_SOURCE_ID;

	// Notion failures below are intentionally NOT swallowed: a broken Notion path
	// (unset ZAPIER_NOTION_CONNECTION_ID, a 404 from a database not shared with the
	// Zapier Notion connection, an expired connection) is a misconfiguration that
	// must fail the sync loudly — otherwise the run reports HEALTHY while silently
	// writing no relations. When a *_DATA_SOURCE_ID env var is unset, the matching
	// enrichment is intentionally skipped (no throw); when it is set but the call
	// fails, we rethrow with actionable context so it surfaces in sync status.
	let companies: CompanyIndex | null = null;
	if (companiesDataSourceId) {
		companies = await withNotionContext(
			"Company index build",
			"COMPANIES_DATA_SOURCE_ID",
			() => buildCompanyIndex(notion, companiesDataSourceId),
		);
	}

	let currencies: CurrencyIndex | null = null;
	if (fxRatesDataSourceId) {
		currencies = await withNotionContext(
			"Currency index build",
			"FX_RATES_DATA_SOURCE_ID",
			() => buildCurrencyIndex(notion, fxRatesDataSourceId),
		);
	}

	const matches = await resolveMatchesForBatch(invoices, companies, currencies);

	const changes = invoices.map((inv) => {
		const m = matches.get(inv.InvoiceID);
		return toUpsertChange(inv, m?.matchKey || null);
	});

	const managedDsId = process.env.SALES_INVOICES_DATA_SOURCE_ID;
	if (managedDsId) {
		const relations = new Map<string, InvoiceRelations>();
		for (const [invoiceId, m] of matches) {
			if (m.companyPageId || m.currencyPageId) {
				relations.set(invoiceId, {
					companyPageId: m.companyPageId,
					currencyPageId: m.currencyPageId,
				});
			}
		}
		if (relations.size > 0) {
			await withNotionContext(
				"Invoice relation reconciliation",
				"SALES_INVOICES_DATA_SOURCE_ID",
				() => reconcileInvoiceRelations(notion, managedDsId, relations),
			);
		}
	}

	return changes;
}

/**
 * Runs a Notion-backed step and, on failure, rethrows with actionable context.
 * Failing (rather than warn-and-continue) is deliberate: it turns an otherwise
 * invisible misconfiguration into a failed sync run visible in `ntn workers sync
 * status`. The hint points at the two things that actually break this path:
 * the data source id and whether the Zapier Notion connection can see it.
 */
async function withNotionContext<T>(
	label: string,
	dataSourceEnvVar: string,
	fn: () => Promise<T>,
): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		throw new Error(
			`${label} failed: ${(err as Error).message} — verify ZAPIER_NOTION_CONNECTION_ID is set and that the Zapier Notion connection is shared with the database referenced by ${dataSourceEnvVar} (Notion: ••• → Connections).`,
		);
	}
}

function toUpsertChange(invoice: XeroInvoice, matchedDomain: string | null) {
	return {
		type: "upsert" as const,
		key: invoice.InvoiceID,
		properties: invoiceProperties(invoice, matchedDomain),
		upstreamUpdatedAt: toIsoDateTime(invoice.UpdatedDateUTC) ?? undefined,
	};
}

worker.sync("invoicesBackfill", {
	database: salesInvoices,
	mode: "replace",
	schedule: "manual",
	execute: async (state: BackfillState | undefined) => {
		const page = state?.page ?? 1;
		await xeroPacer.wait();
		const invoices = await fetchInvoicesPage(page);
		const changes = await buildChangesAndReconcile(invoices, notion);
		const hasMore = invoices.length >= 100;
		return { changes, hasMore, nextState: hasMore ? { page: page + 1 } : undefined };
	},
});

worker.sync("invoicesDelta", {
	database: salesInvoices,
	mode: "incremental",
	schedule: "6h",
	execute: async (state: DeltaState | undefined) => {
		const sinceIso = state?.lastSyncIso ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
		const runStartedAt = new Date().toISOString();

		const allChanges: Awaited<ReturnType<typeof buildChangesAndReconcile>> = [];
		for (let page = 1; page <= 50; page++) {
			await xeroPacer.wait();
			const invoices = await fetchInvoicesPage(page, sinceIso);
			if (invoices.length === 0) break;
			const changes = await buildChangesAndReconcile(invoices, notion);
			allChanges.push(...changes);
			if (invoices.length < 100) break;
		}

		return {
			changes: allChanges,
			hasMore: false,
			nextState: { lastSyncIso: runStartedAt },
		};
	},
});
