import { Worker } from "@notionhq/workers";
import * as Schema from "@notionhq/workers/schema";
import * as Builder from "@notionhq/workers/builder";
import type { Client } from "@notionhq/client";

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
	notion: Client,
): Promise<ReturnType<typeof toUpsertChange>[]> {
	const companiesDataSourceId = process.env.COMPANIES_DATA_SOURCE_ID;
	const fxRatesDataSourceId = process.env.FX_RATES_DATA_SOURCE_ID;

	let companies: CompanyIndex | null = null;
	if (companiesDataSourceId) {
		try {
			companies = await buildCompanyIndex(notion, companiesDataSourceId);
		} catch (err) {
			console.warn(`Failed to build Company index: ${(err as Error).message}`);
		}
	}

	let currencies: CurrencyIndex | null = null;
	if (fxRatesDataSourceId) {
		try {
			currencies = await buildCurrencyIndex(notion, fxRatesDataSourceId);
		} catch (err) {
			console.warn(`Failed to build Currency index: ${(err as Error).message}`);
		}
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
			try {
				await reconcileInvoiceRelations(notion, managedDsId, relations);
			} catch (err) {
				console.warn(`Invoice relation reconciliation failed: ${(err as Error).message}`);
			}
		}
	}

	return changes;
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
	execute: async (state: BackfillState | undefined, { notion }) => {
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
	schedule: "15m",
	execute: async (state: DeltaState | undefined, { notion }) => {
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
