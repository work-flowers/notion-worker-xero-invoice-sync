import { sdk } from "./zapier.js";

/**
 * Minimal Notion REST client routed through the Zapier SDK's `fetch`, using a
 * Notion connection in Zapier for auth. This removes the need for a separate
 * `NOTION_API_TOKEN` internal integration — Zapier injects the connection's
 * Notion OAuth credentials on each request.
 *
 * Only the surface this worker actually uses is implemented: querying a data
 * source and updating a page's properties.
 */

// Data-source endpoints require this API version or later.
const NOTION_VERSION = "2025-09-03";

export type NotionQueryParams = {
	data_source_id: string;
	start_cursor?: string;
	page_size?: number;
	filter?: unknown;
};

export type NotionPage = {
	id: string;
	properties: Record<string, any>;
};

export type NotionQueryResponse = {
	results: Array<NotionPage | { id: string }>;
	has_more: boolean;
	next_cursor: string | null;
};

export type NotionClient = {
	dataSources: {
		query(params: NotionQueryParams): Promise<NotionQueryResponse>;
	};
	pages: {
		update(params: { page_id: string; properties: Record<string, unknown> }): Promise<unknown>;
	};
};

/** Anything with an awaitable `wait()` — satisfied by `worker.pacer(...)`. */
export type Pacer = { wait: () => Promise<void> };

function connectionId(): string {
	const id = process.env.NOTION_ZAPIER_CONNECTION_ID;
	if (!id) throw new Error("NOTION_ZAPIER_CONNECTION_ID must be set");
	return id;
}

async function notionFetch<T>(
	path: string,
	init: { method: string; body?: unknown },
	pacer?: Pacer,
): Promise<T> {
	if (pacer) await pacer.wait();
	const res = await sdk().fetch(`https://api.notion.com/v1/${path}`, {
		method: init.method,
		connection: connectionId(),
		headers: {
			"Content-Type": "application/json",
			"Notion-Version": NOTION_VERSION,
			Accept: "application/json",
		},
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`Notion ${path} failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
	}
	return (await res.json()) as T;
}

export function getNotion(pacer?: Pacer): NotionClient {
	return {
		dataSources: {
			query: ({ data_source_id, ...body }) =>
				notionFetch<NotionQueryResponse>(
					`data_sources/${data_source_id}/query`,
					{ method: "POST", body },
					pacer,
				),
		},
		pages: {
			update: ({ page_id, properties }) =>
				notionFetch(`pages/${page_id}`, { method: "PATCH", body: { properties } }, pacer),
		},
	};
}
