import type { Client } from "@notionhq/client";

export type InvoiceRelations = {
	companyPageId?: string | null;
	currencyPageId?: string | null;
};

export async function reconcileInvoiceRelations(
	notion: Client,
	managedDataSourceId: string,
	invoiceRelations: Map<string, InvoiceRelations>,
): Promise<void> {
	for (const [xeroInvoiceId, rels] of invoiceRelations) {
		const wantCompany = rels.companyPageId ?? null;
		const wantCurrency = rels.currencyPageId ?? null;
		if (!wantCompany && !wantCurrency) continue;

		const found = await notion.dataSources.query({
			data_source_id: managedDataSourceId,
			filter: {
				property: "Xero Invoice ID",
				rich_text: { equals: xeroInvoiceId },
			},
			page_size: 1,
		} as Parameters<typeof notion.dataSources.query>[0]);

		const page = found.results[0];
		if (!page || !("properties" in page)) continue;

		const updates: Record<string, { relation: Array<{ id: string }> }> = {};

		if (wantCompany) {
			const cur = readRelation(page.properties["Company"]);
			if (!(cur.length === 1 && cur[0] === wantCompany)) {
				updates["Company"] = { relation: [{ id: wantCompany }] };
			}
		}

		if (wantCurrency) {
			const cur = readRelation(page.properties["Currency"]);
			if (!(cur.length === 1 && cur[0] === wantCurrency)) {
				updates["Currency"] = { relation: [{ id: wantCurrency }] };
			}
		}

		if (Object.keys(updates).length === 0) continue;

		await notion.pages.update({
			page_id: page.id,
			properties: updates,
		});
	}
}

function readRelation(prop: unknown): string[] {
	if (!prop || typeof prop !== "object") return [];
	const p = prop as { type?: string; relation?: unknown };
	if (p.type !== "relation" || !Array.isArray(p.relation)) return [];
	return (p.relation as Array<{ id: string }>).map((r) => r.id);
}
