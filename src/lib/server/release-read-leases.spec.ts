import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import mediaSchema from '#lib/storage/media.sql?raw';

import { ReleaseReadLeases } from './release-read-leases.js';

let directory: string;
let db: Database.Database;
let leases: ReleaseReadLeases;
let time: number;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'helia-read-leases-'));
	db = new Database(join(directory, 'leases.sqlite'));
	db.exec(mediaSchema);
	db.pragma('busy_timeout=0');
	time = Date.now();
	vi.spyOn(Date, 'now').mockImplementation(() => time);
	leases = new ReleaseReadLeases(db);
	leases.add('game', 'object-one');
	leases.add('game', 'object-two');
});
afterEach(() => {
	leases.close();
	db.close();
	vi.restoreAllMocks();
	rmSync(directory, { recursive: true, force: true });
});

const expiries = () => db.prepare('SELECT expires_at FROM media_leases').pluck().all();

it('retries a transient database lock on the next chunk and renews every object', () => {
	const writer = new Database(join(directory, 'leases.sqlite'));
	const initial = expiries();
	try {
		writer.exec('BEGIN IMMEDIATE');
		time += 60000;
		leases.renew();
		expect(expiries()).toEqual(initial);
		writer.exec('ROLLBACK');
		time += 1000;
		leases.renew();
		expect(expiries()).toEqual(Array(2).fill(new Date(time + 180000).toISOString()));
	} finally {
		if (writer.inTransaction) {
			writer.exec('ROLLBACK');
		}
		writer.close();
	}
});

it.each(['missing', 'expired', 'elapsed'])(
	'stops safely when lease protection is %s',
	(failure) => {
		if (failure === 'missing') {
			db.exec('DELETE FROM media_leases');
		}
		if (failure === 'expired') {
			db.exec("UPDATE media_leases SET expires_at='2000-01-01'");
		}
		time += failure === 'elapsed' ? 180000 : 60000;
		expect(() => leases.renew()).toThrow(expect.objectContaining({ code: 'missingAsset' }));
	}
);

it('aborts after lock failures exhaust the lease lifetime', () => {
	const writer = new Database(join(directory, 'leases.sqlite'));
	try {
		writer.exec('BEGIN IMMEDIATE');
		time += 60000;
		leases.renew();
		time += 120000;
		expect(() => leases.renew()).toThrow(expect.objectContaining({ code: 'missingAsset' }));
	} finally {
		writer.exec('ROLLBACK');
		writer.close();
	}
});
