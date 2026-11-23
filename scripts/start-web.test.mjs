import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

async function start(t, settings = {}) {
	const reservation = createServer();
	reservation.listen(0, '127.0.0.1');
	await once(reservation, 'listening');
	const port = reservation.address().port;
	await new Promise((resolve, reject) =>
		reservation.close((error) => (error ? reject(error) : resolve()))
	);
	const directory = await mkdtemp(join(tmpdir(), 'helia-web-origin-'));
	const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), HELIA_DATA_DIR: directory };
	for (const key of [
		'HELIA_ORIGIN',
		'PROTOCOL_HEADER',
		'HOST_HEADER',
		'PORT_HEADER',
		'SOCKET_PATH',
		'LISTEN_PID',
		'LISTEN_FDS'
	])
		delete env[key];
	Object.assign(env, settings);
	const child = spawn(process.execPath, ['scripts/start-web.mjs'], {
		env,
		stdio: ['ignore', 'pipe', 'pipe']
	});
	const exited = once(child, 'exit');
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill();
			await exited;
		}
		assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
		assert.ok(basename(directory).startsWith('helia-web-origin-'));
		await rm(directory, { recursive: true, force: true });
	});
	await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(Error('Web server did not start')), 15000);
		child.once('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once('exit', () => {
			clearTimeout(timer);
			reject(Error('Web server exited before readiness'));
		});
		child.stdout.on('data', (chunk) => {
			if (String(chunk).includes('Listening on')) {
				clearTimeout(timer);
				resolve();
			}
		});
	});
	return { port, base: `http://127.0.0.1:${port}` };
}

async function read(base, origin, extra = {}) {
	const response = await fetch(base + '/api/storage', {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...extra },
		body: JSON.stringify({ kind: 'list' }),
		signal: AbortSignal.timeout(5000)
	});
	await response.arrayBuffer();
	return response.status;
}

test('built HTTP server accepts both loopback hosts and rejects foreign or forged origins', async (t) => {
	const { base, port } = await start(t);
	for (const host of ['127.0.0.1', 'localhost']) {
		const origin = `http://${host}:${port}`;
		assert.equal(await read(origin, origin), 200);
	}
	assert.equal(
		await read(base, base, { 'x-helia-protocol': 'https', 'x-forwarded-proto': 'https' }),
		200
	);
	assert.equal(await read(base, 'https://127.0.0.1:' + port), 403);
	assert.equal(
		await read(base, 'https://127.0.0.1:' + port, {
			'x-helia-protocol': 'https',
			'x-forwarded-proto': 'https'
		}),
		403
	);
	assert.equal(await read(base, 'https://foreign.example'), 403);
	assert.equal(await read(base, undefined), 403);
});

test('built server preserves explicitly configured reverse-proxy protocol headers', async (t) => {
	const { base, port } = await start(t, { PROTOCOL_HEADER: 'x-forwarded-proto' });
	assert.equal(
		await read(base, `https://127.0.0.1:${port}`, { 'x-forwarded-proto': 'https' }),
		200
	);
	assert.equal(await read(base, base, { 'x-forwarded-proto': 'https' }), 403);
});
