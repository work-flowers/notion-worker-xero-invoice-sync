import { createZapierSdk } from "@zapier/zapier-sdk";

let _sdk: ReturnType<typeof createZapierSdk> | null = null;

/**
 * Shared Zapier SDK instance. Both the Xero and Notion REST helpers route their
 * authenticated requests through this SDK's `fetch`, each naming its own Zapier
 * connection so Zapier injects the right OAuth credentials.
 */
export function sdk() {
	if (_sdk) return _sdk;
	const clientId = process.env.ZAPIER_CLIENT_ID;
	const clientSecret = process.env.ZAPIER_CLIENT_SECRET;
	if (!clientId || !clientSecret) {
		throw new Error("ZAPIER_CLIENT_ID and ZAPIER_CLIENT_SECRET must be set");
	}
	_sdk = createZapierSdk({ credentials: { clientId, clientSecret } });
	return _sdk;
}
