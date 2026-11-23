// Content includes bounded embedded media and a separate recoverable authoring draft.
process.env.BODY_SIZE_LIMIT ??= String(20 * 1024 * 1024);

// adapter-node assumes HTTPS when no protocol header is configured. Its own
// listener uses HTTP, so supply that protocol before the adapter handles a request.
// Overwrite the private header instead of trusting a caller-supplied value.
const inferProtocol = !process.env.PROTOCOL_HEADER;
const protocolHeader = 'x-helia-protocol';
if (inferProtocol) process.env.PROTOCOL_HEADER = protocolHeader;

const { server } = await import('../build/web/index.js');
if (inferProtocol) {
	server.prependListener('request', (request) => {
		request.headers[protocolHeader] = 'http';
	});
}
