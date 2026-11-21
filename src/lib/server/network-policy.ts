import type { LookupAddress, LookupAllOptions } from 'node:dns';

import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';

import { networkURL } from '#lib/games/network/protocol.js';

const blocked = new BlockList();
const blockedV6 = new BlockList();
for (const [address, prefix] of [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.0.2.0', 24],
	['192.88.99.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['198.51.100.0', 24],
	['203.0.113.0', 24],
	['224.0.0.0', 3]
] as const) {
	blocked.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
	['::', 96],
	['::ffff:0:0', 96],
	['64:ff9b::', 96],
	['64:ff9b:1::', 48],
	['100::', 64],
	['2001::', 23],
	['2001:db8::', 32],
	['2002::', 16],
	['3fff::', 20],
	['fc00::', 7],
	['fe80::', 10],
	['ff00::', 8]
] as const) {
	blockedV6.addSubnet(address, prefix, 'ipv6');
}
export function isPublicAddress(address: string): boolean {
	const version = isIP(address);
	if (version === 4) {
		return address !== '168.63.129.16' && !blocked.check(address, 'ipv4');
	}
	return version === 6 && /^[23]/.test(address) && !blockedV6.check(address, 'ipv6');
}
export type NetworkLookup = (
	hostname: string,
	options: LookupAllOptions
) => Promise<LookupAddress[]>;
/** Resolve once and pin these verified addresses into the HTTP connector. */
export async function networkAddresses(value: string, resolve: NetworkLookup = lookup) {
	const url = networkURL(value);
	const hostname = url.hostname.replace(/^\[|\]$/g, '');
	const addresses = await resolve(hostname, { all: true, verbatim: true });
	if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
		throw new TypeError('Fetch destination is not a public network address');
	}
	return addresses;
}
