import { expect, it, vi } from 'vitest';

import { isPublicAddress, networkAddresses } from './network-policy.js';

it.each([
	'127.0.0.1',
	'10.1.2.3',
	'172.16.0.1',
	'192.168.0.1',
	'169.254.169.254',
	'100.64.0.1',
	'0.0.0.0',
	'224.0.0.1',
	'192.0.2.1',
	'168.63.129.16',
	'::1',
	'::ffff:8.8.8.8',
	'64:ff9b::808:808',
	'fc00::1',
	'fe80::1',
	'2002:808:808::',
	'2001:db8::1',
	'3fff::1'
])('blocks internal and special address %s', (address) => {
	expect(isPublicAddress(address)).toBe(false);
});
it('accepts public IPv4/IPv6 and rejects mixed public/private DNS answers', async () => {
	for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
		expect(isPublicAddress(address)).toBe(true);
	}
	const resolve = vi
		.fn<import('./network-policy.js').NetworkLookup>()
		.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
	await expect(networkAddresses('https://example.com/', resolve)).resolves.toEqual([
		{ address: '8.8.8.8', family: 4 }
	]);
	resolve.mockResolvedValue([
		{ address: '8.8.8.8', family: 4 },
		{ address: '127.0.0.1', family: 4 }
	]);
	await expect(networkAddresses('https://example.com/', resolve)).rejects.toThrow('public');
	resolve.mockResolvedValue([]);
	await expect(networkAddresses('https://example.com/', resolve)).rejects.toThrow();
});
