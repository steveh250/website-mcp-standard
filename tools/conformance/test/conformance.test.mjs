import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixture } from './fixture-server.mjs';

const CHECKER = join(dirname(fileURLToPath(import.meta.url)), '..', 'conformance.mjs');

function runChecker(args) {
	return new Promise((resolve) => {
		execFile(process.execPath, [CHECKER, ...args, '--json'], (error, stdout) => {
			resolve({ code: error ? error.code : 0, report: JSON.parse(stdout) });
		});
	});
}

test('a conforming Core site passes', async () => {
	const fixture = await startFixture();
	try {
		const { code, report } = await runChecker([fixture.url]);
		const failures = report.results.filter((r) => r.level === 'FAIL');
		assert.deepEqual(failures, []);
		assert.equal(code, 0);
		assert.equal(report.complete, true);
		assert.ok(report.summary.pass >= 20, `expected at least 20 passes, got ${report.summary.pass}`);
		assert.match(report.declared, /modules core$/);
	} finally {
		await fixture.close();
	}
});

test('a site missing a Core tool fails CORE-001', async () => {
	const fixture = await startFixture({ broken: true });
	try {
		const { code, report } = await runChecker([fixture.url]);
		assert.equal(code, 1);
		assert.ok(report.results.some((r) => r.level === 'FAIL' && r.requirements.includes('CORE-001')));
	} finally {
		await fixture.close();
	}
});

test('running out of request budget reports an incomplete run', async () => {
	const fixture = await startFixture();
	try {
		const { code, report } = await runChecker([fixture.url, '--max-requests', '5']);
		assert.equal(code, 2);
		assert.equal(report.complete, false);
		assert.match(report.incomplete, /request budget of 5/);
	} finally {
		await fixture.close();
	}
});
