import { createZapierSdk } from "@zapier/zapier-sdk";

export type XeroInvoice = {
	InvoiceID: string;
	InvoiceNumber?: string | null;
	Reference?: string | null;
	Type?: string | null;
	Status?: string | null;
	Date?: string | null;
	DueDate?: string | null;
	FullyPaidOnDate?: string | null;
	Total?: number | string | null;
	AmountDue?: number | string | null;
	AmountPaid?: number | string | null;
	CurrencyCode?: string | null;
	UpdatedDateUTC?: string | null;
	Contact?: { ContactID?: string | null; Name?: string | null } | null;
};

export type XeroContact = {
	ContactID: string;
	Name?: string | null;
	AccountNumber?: string | null;
	EmailAddress?: string | null;
	Website?: string | null;
	ContactPersons?: Array<{ EmailAddress?: string | null }> | null;
};

let _sdk: ReturnType<typeof createZapierSdk> | null = null;
function sdk() {
	if (_sdk) return _sdk;
	const clientId = process.env.ZAPIER_CLIENT_ID;
	const clientSecret = process.env.ZAPIER_CLIENT_SECRET;
	if (!clientId || !clientSecret) {
		throw new Error("ZAPIER_CLIENT_ID and ZAPIER_CLIENT_SECRET must be set");
	}
	_sdk = createZapierSdk({ credentials: { clientId, clientSecret } });
	return _sdk;
}

function connectionId(): string {
	const id = process.env.XERO_ZAPIER_CONNECTION_ID;
	if (!id) throw new Error("XERO_ZAPIER_CONNECTION_ID must be set");
	return id;
}

function organization(): string {
	const id = process.env.XERO_ORGANIZATION_ID;
	if (!id) throw new Error("XERO_ORGANIZATION_ID must be set");
	return id;
}

async function xeroGet<T = unknown>(path: string, headers: Record<string, string> = {}): Promise<T> {
	const url = `https://api.xero.com/api.xro/2.0/${path}`;
	const res = await sdk().fetch(url, {
		method: "GET",
		connection: connectionId(),
		headers: {
			"Xero-tenant-id": organization(),
			Accept: "application/json",
			...headers,
		},
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`Xero ${path} failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
	}
	return (await res.json()) as T;
}

export async function fetchInvoicesPage(page: number, ifModifiedSinceIso?: string): Promise<XeroInvoice[]> {
	const headers: Record<string, string> = {};
	if (ifModifiedSinceIso) headers["If-Modified-Since"] = ifModifiedSinceIso;
	const where = encodeURIComponent('Type=="ACCREC"');
	const data = await xeroGet<{ Invoices?: XeroInvoice[] }>(
		`Invoices?page=${page}&order=UpdatedDateUTC%20DESC&where=${where}`,
		headers,
	);
	return data.Invoices ?? [];
}

export async function fetchAllContacts(): Promise<XeroContact[]> {
	const all: XeroContact[] = [];
	for (let page = 1; ; page++) {
		const data = await xeroGet<{ Contacts?: XeroContact[] }>(`Contacts?page=${page}`);
		const batch = data.Contacts ?? [];
		all.push(...batch);
		if (batch.length < 100) break;
		if (page >= 50) break;
	}
	return all;
}

const XERO_STATUS_MAP: Record<string, string> = {
	DRAFT: "Draft",
	SUBMITTED: "Submitted",
	AUTHORISED: "Authorised",
	PAID: "Paid",
	VOIDED: "Voided",
	DELETED: "Deleted",
};

export function mapXeroStatus(raw: string | null | undefined): string {
	if (!raw) return "Draft";
	return XERO_STATUS_MAP[raw.toUpperCase()] ?? raw;
}

export function xeroInvoiceUrl(invoiceId: string): string {
	return `https://go.xero.com/AccountsReceivable/Edit.aspx?InvoiceID=${invoiceId}`;
}

export function toNumber(n: unknown): number | null {
	if (n == null || n === "") return null;
	const v = typeof n === "string" ? Number.parseFloat(n) : (n as number);
	return Number.isFinite(v) ? v : null;
}

export function toIsoDate(s: string | null | undefined): string | null {
	if (!s) return null;
	const dotnet = /\/Date\((-?\d+)([+-]\d{4})?\)\//.exec(s);
	if (dotnet) {
		const d = new Date(Number.parseInt(dotnet[1], 10));
		if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
	}
	const isoMatch = /\d{4}-\d{2}-\d{2}/.exec(s);
	if (isoMatch) return isoMatch[0];
	const d = new Date(s);
	if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
	return null;
}

export function toIsoDateTime(s: string | null | undefined): string | null {
	if (!s) return null;
	const dotnet = /\/Date\((-?\d+)([+-]\d{4})?\)\//.exec(s);
	if (dotnet) {
		const d = new Date(Number.parseInt(dotnet[1], 10));
		if (!Number.isNaN(d.getTime())) return d.toISOString();
	}
	const d = new Date(s);
	if (!Number.isNaN(d.getTime())) return d.toISOString();
	return null;
}
