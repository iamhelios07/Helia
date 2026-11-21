import { networkURL, parseNetworkRequest, type NetworkRequest } from './protocol.js';
import { networkHop } from './transport.js';

export type NetworkPermission = (origin: string, signal: AbortSignal) => Promise<boolean>;
export interface FetchResult {
	response: Response;
	url: string;
	redirected: boolean;
}
/** Redirects pass through the same consent gate as the initial destination. */
export async function fetchWithPermission(
	input: NetworkRequest & { redirect: RequestRedirect },
	signal: AbortSignal,
	permission: NetworkPermission,
	send = networkHop
): Promise<FetchResult> {
	let request = parseNetworkRequest(input);
	for (let redirects = 0; redirects <= 20; redirects++) {
		signal.throwIfAborted();
		const allowed = await permission(networkURL(request.url).origin, signal);
		signal.throwIfAborted();
		if (!allowed) {
			throw new TypeError('Fetch permission denied');
		}
		signal.throwIfAborted();
		const response = await send(request, signal);
		const location = response.headers.get('location');
		if (
			input.redirect === 'manual' ||
			![301, 302, 303, 307, 308].includes(response.status) ||
			!location
		) {
			return { response, url: request.url, redirected: redirects > 0 };
		}
		await response.body?.cancel();
		if (input.redirect === 'error' || redirects === 20) {
			throw new TypeError('Fetch redirect rejected');
		}
		request = redirectedRequest(request, response.status, location);
	}
	throw new TypeError('Fetch redirect limit');
}
function redirectedRequest(
	request: NetworkRequest,
	status: number,
	location: string
): NetworkRequest {
	const url = networkURL(new URL(location, request.url).href);
	const changeMethod =
		(status === 303 && request.method !== 'HEAD') ||
		([301, 302].includes(status) && request.method === 'POST');
	const crossOrigin = url.origin !== new URL(request.url).origin;
	const headers = request.headers.filter(([name]) => {
		const key = name.toLowerCase();
		if (crossOrigin && ['authorization', 'www-authenticate'].includes(key)) {
			return false;
		}
		return (
			!changeMethod ||
			!['content-type', 'content-encoding', 'content-language', 'content-location'].includes(key)
		);
	});
	return {
		url: url.href,
		method: changeMethod ? 'GET' : request.method,
		headers,
		body: changeMethod ? null : request.body
	};
}
