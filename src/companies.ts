import type { Client } from "@notionhq/client";

const GENERIC_EMAIL_DOMAINS = new Set([
	"gmail.com",
	"googlemail.com",
	"outlook.com",
	"hotmail.com",
	"live.com",
	"yahoo.com",
	"yahoo.co.uk",
	"yahoo.com.au",
	"icloud.com",
	"me.com",
	"mac.com",
	"proton.me",
	"protonmail.com",
	"aol.com",
	"msn.com",
	"qq.com",
	"126.com",
	"163.com",
]);

export function normalizeDomain(input: string | null | undefined): string | null {
	if (!input) return null;
	let s = input.trim().toLowerCase();
	if (!s) return null;

	if (s.includes("@")) s = s.split("@").pop() ?? "";
	s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
	s = s.split("/")[0].split("?")[0].split("#")[0];
	s = s.split(":")[0];
	if (!s || !s.includes(".")) return null;
	return s;
}

export function pickContactDomain(contact: {
	Website?: string | null;
	EmailAddress?: string | null;
	ContactPersons?: Array<{ EmailAddress?: string | null }> | null;
}): { domain: string | null; source: string } {
	const fromWebsite = normalizeDomain(contact.Website);
	if (fromWebsite) return { domain: fromWebsite, source: "website" };

	const primaryEmailDomain = normalizeDomain(contact.EmailAddress);
	if (primaryEmailDomain && !GENERIC_EMAIL_DOMAINS.has(primaryEmailDomain)) {
		return { domain: primaryEmailDomain, source: "primary_email" };
	}

	for (const person of contact.ContactPersons ?? []) {
		const d = normalizeDomain(person?.EmailAddress);
		if (d && !GENERIC_EMAIL_DOMAINS.has(d)) {
			return { domain: d, source: "contact_person_email" };
		}
	}

	return { domain: null, source: "none" };
}

export function parseAccountNumber(s: string | null | undefined): number | null {
	if (!s) return null;
	const m = /^\s*(?:COM[-_]?)?(\d+)\s*$/i.exec(s);
	if (!m) return null;
	const n = Number.parseInt(m[1], 10);
	return Number.isFinite(n) ? n : null;
}

export type CompanyIndex = {
	byId: Map<number, string>;
	byDomain: Map<string, string>;
};

export async function buildCompanyIndex(
	notion: Client,
	companiesDataSourceId: string,
): Promise<CompanyIndex> {
	const byId = new Map<number, string>();
	const byDomain = new Map<string, string>();
	let cursor: string | undefined;

	do {
		const res = await notion.dataSources.query({
			data_source_id: companiesDataSourceId,
			start_cursor: cursor,
			page_size: 100,
		} as Parameters<typeof notion.dataSources.query>[0]);

		for (const page of res.results) {
			if (!("properties" in page)) continue;

			const idProp = page.properties["ID"] as { type?: string; unique_id?: { number?: number | null } } | undefined;
			if (idProp?.type === "unique_id") {
				const num = idProp.unique_id?.number;
				if (typeof num === "number" && !byId.has(num)) byId.set(num, page.id);
			}

			const websiteProp = page.properties["Website"];
			if (websiteProp?.type === "url") {
				const url = typeof websiteProp.url === "string" ? websiteProp.url : null;
				const domain = normalizeDomain(url);
				if (domain && !byDomain.has(domain)) byDomain.set(domain, page.id);
			}
		}

		cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
	} while (cursor);

	return { byId, byDomain };
}

export type CurrencyIndex = Map<string, string>;

export async function buildCurrencyIndex(
	notion: Client,
	fxRatesDataSourceId: string,
): Promise<CurrencyIndex> {
	const index = new Map<string, string>();
	let cursor: string | undefined;

	do {
		const res = await notion.dataSources.query({
			data_source_id: fxRatesDataSourceId,
			start_cursor: cursor,
			page_size: 100,
		} as Parameters<typeof notion.dataSources.query>[0]);

		for (const page of res.results) {
			if (!("properties" in page)) continue;
			const titleProp = page.properties["Currency"];
			if (titleProp?.type !== "title") continue;
			const code = titleProp.title
				.map((t) => ("plain_text" in t ? t.plain_text : ""))
				.join("")
				.trim()
				.toUpperCase();
			if (code && !index.has(code)) index.set(code, page.id);
		}

		cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
	} while (cursor);

	return index;
}
