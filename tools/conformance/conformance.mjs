#!/usr/bin/env node
// MCP-WP 0.1 conformance checker (SPECIFICATION.md §12).
//
//   node conformance.mjs www.example.com            # derives https://www.example.com/mcp
//   node conformance.mjs https://www.example.com/mcp
//   node conformance.mjs http://localhost:8787/mcp  # a local development server
//   node conformance.mjs www.example.com --json     # machine-readable report
//
// What it does:
// - Runs the §12 checks for Core, and for each Extended module the site declares
//   in get_site_info (insights, service_details, people, events).
// - Validates every structured result against the schemas in ../../schemas.
// - Is read-only. It calls only Core and Extended tools, which MCP-WP requires to
//   be read-only and unauthenticated. It NEVER calls Transactional tools: for a
//   site declaring `transactions` it checks only tool presence and annotations.
// - Is bounded: a request budget (--max-requests, default 400) and a time limit
//   (--max-minutes, default 15). If either runs out, the report says so.
// - Waits and retries when the server rate-limits it (HTTP 429 with Retry-After,
//   or a `rate_limited` result with retry_after_seconds).
//
// A passing run is evidence, not certification: it samples pages and inputs, and
// can't judge consistency with the human site (CORE-007), privacy or side effects.
//
// Exit codes: 0 no failures; 1 at least one failure; 2 run incomplete (budget,
// time limit or fatal error) without failures; 64 bad usage.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Validator } from '@cfworker/json-schema';

const CHECKER = { name: 'mcpwp-conformance', version: '0.1.0', mcpwp: '0.1' };
const PROTOCOL = '2025-06-18';
const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schemas');

const CORE = ['get_site_info', 'get_services', 'get_contact', 'search_site', 'get_page'];
const EXTENDED = {
	insights: ['search_insights', 'get_insight', 'latest_insights', 'list_topics'],
	service_details: ['get_service'],
	people: ['get_people', 'get_person'],
	events: ['get_events', 'get_event']
};
const TRANSACTIONAL = ['list_transaction_types', 'check_availability', 'prepare_transaction', 'submit_transaction', 'get_transaction_status', 'cancel_transaction'];
const RESERVED = new Set([...CORE, ...Object.values(EXTENDED).flat(), ...TRANSACTIONAL]);
const ERROR_STATUSES = new Set(['invalid_request', 'not_found', 'unauthorized', 'forbidden', 'conflict', 'rate_limited', 'unavailable', 'internal_error']);
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// TXN-002
const TXN_ANNOTATIONS = {
	list_transaction_types: READ_ONLY,
	check_availability: READ_ONLY,
	get_transaction_status: READ_ONLY,
	prepare_transaction: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	submit_transaction: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
	cancel_transaction: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true }
};

// ---- Arguments ---------------------------------------------------------------------

function usage(message) {
	if (message) console.error(message);
	console.error('Usage: node conformance.mjs <host | endpoint URL> [--json] [--max-requests N] [--max-minutes N]');
	process.exit(64);
}

const argv = process.argv.slice(2);
const options = { json: false, maxRequests: 400, maxMinutes: 15 };
let target;
for (let i = 0; i < argv.length; i++) {
	const arg = argv[i];
	if (arg === '--json') options.json = true;
	else if (arg === '--max-requests') options.maxRequests = Number(argv[++i]);
	else if (arg === '--max-minutes') options.maxMinutes = Number(argv[++i]);
	else if (arg === '-h' || arg === '--help') usage();
	else if (arg.startsWith('-')) usage(`Unknown option ${arg}`);
	else if (target) usage('Give one host or endpoint URL.');
	else target = arg;
}
if (!target) usage();
if (!(options.maxRequests > 0) || !(options.maxMinutes > 0)) usage('--max-requests and --max-minutes must be positive numbers.');

/** A bare host becomes https://<host>/mcp; a URL with no path gets /mcp. */
function endpointFor(input) {
	const url = new URL(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`);
	if (url.pathname === '/' || url.pathname === '') url.pathname = '/mcp';
	return url;
}

let endpoint;
try {
	endpoint = endpointFor(target);
} catch {
	usage(`"${target}" is not a host name or URL.`);
}
const isLocal = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(endpoint.hostname);

// ---- Schemas -----------------------------------------------------------------------

const schemas = {};
for (const level of readdirSync(SCHEMA_DIR)) {
	for (const file of readdirSync(join(SCHEMA_DIR, level))) {
		const m = /^(.+)\.(input|output)\.json$/.exec(file);
		if (m) (schemas[m[1]] ??= {})[m[2]] = JSON.parse(readFileSync(join(SCHEMA_DIR, level, file), 'utf8'));
	}
}
const validators = {};
function validate(tool, instance) {
	const schema = schemas[tool]?.output;
	if (!schema) return null;
	validators[tool] ??= new Validator(schema, '2020-12', false);
	const { valid, errors } = validators[tool].validate(instance);
	if (valid) return null;
	const leaves = errors.filter((e) => !/does not match schema|A subschema had errors|do not match/i.test(e.error));
	return (leaves.length ? leaves : errors).slice(0, 4).map((e) => `${e.instanceLocation}: ${e.error}`).join('; ');
}

// ---- Reporting ---------------------------------------------------------------------

const results = [];
const record = (level, req, name, detail = '') => results.push({ level, requirements: req ? req.split(/,\s*/) : [], name, detail: String(detail) });
const check = (pass, req, name, detail = '') => record(pass ? 'PASS' : 'FAIL', req, name, pass ? '' : detail);
const warn = (req, name, detail = '') => record('WARN', req, name, detail);
const skip = (req, name, detail = '') => record('SKIP', req, name, detail);
const should = (pass, req, name, detail = '') => (pass ? record('PASS', req, name) : warn(req, name, detail));

class Incomplete extends Error {}
const started = Date.now();
let requests = 0;
let sessionId;

const sleep = (s) => new Promise((resolve) => setTimeout(resolve, s * 1000));

async function budgetedFetch(url, init) {
	if (requests >= options.maxRequests) throw new Incomplete(`request budget of ${options.maxRequests} used up`);
	if (Date.now() - started > options.maxMinutes * 60_000) throw new Incomplete(`time limit of ${options.maxMinutes} minutes reached`);
	requests++;
	return fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
}

// ---- MCP over Streamable HTTP ------------------------------------------------------

let nextId = 1;

function headers() {
	const h = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': PROTOCOL };
	if (sessionId) h['Mcp-Session-Id'] = sessionId;
	return h;
}

async function parseMessage(res, id) {
	const text = await res.text();
	if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
		const events = text.split(/\r?\n\r?\n/).map((block) => block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n')).filter(Boolean);
		for (const data of events) {
			try {
				const message = JSON.parse(data);
				if (message.id === id) return message;
			} catch {}
		}
		return undefined;
	}
	try {
		return text ? JSON.parse(text) : undefined;
	} catch {
		return undefined;
	}
}

async function rpc(method, params, { notification = false, url = endpoint, redirect = 'follow' } = {}) {
	const id = notification ? undefined : nextId++;
	const body = JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notification ? {} : { id }) });
	let res = await budgetedFetch(url, { method: 'POST', headers: headers(), body, redirect });
	for (let attempt = 0; res.status === 429 && attempt < 3; attempt++) {
		const wait = Math.min(Number(res.headers.get('retry-after')) || 60, 120);
		if (!options.json) console.error(`  (rate limited by the server; waiting ${wait}s)`);
		await sleep(wait);
		res = await budgetedFetch(url, { method: 'POST', headers: headers(), body, redirect });
	}
	if (notification) return { res };
	return { res, message: await parseMessage(res, id) };
}

/** Calls a tool and checks the MCP-WP result envelope (RES-001, RES-002, RES-010, RES-011, CORE-005). */
async function call(name, args = {}) {
	let { message } = await rpc('tools/call', { name, arguments: args });
	let sc = message?.result?.structuredContent;
	// A tool-level rate limit: wait as told, once.
	if (sc?.status === 'rate_limited' && (sc.error?.retry_after_seconds ?? 0) <= 120) {
		if (!options.json) console.error(`  (${name} rate limited; waiting ${sc.error?.retry_after_seconds ?? 30}s)`);
		await sleep(sc.error?.retry_after_seconds ?? 30);
		({ message } = await rpc('tools/call', { name, arguments: args }));
		sc = message?.result?.structuredContent;
	}
	const label = `${name} ${JSON.stringify(args)}`;
	const result = message?.result;
	if (!result) return { protocolError: message?.error ?? message ?? 'no response', label };
	if (typeof sc?.status !== 'string') {
		check(false, 'RES-001', `${label}: structuredContent with a status`, JSON.stringify(result).slice(0, 200));
		return { result, label };
	}
	const problems = [];
	if (!!result.isError !== ERROR_STATUSES.has(sc.status)) problems.push(`isError is ${!!result.isError} for status "${sc.status}" (RES-010)`);
	if (ERROR_STATUSES.has(sc.status) && typeof sc.error?.message !== 'string') problems.push('error.message missing (RES-011)');
	const invalid = validate(name, sc);
	if (invalid) problems.push(`schema (CORE-005): ${invalid}`);
	if (problems.length) check(false, 'RES-001, RES-010, RES-011, CORE-005', `${label}: valid result`, problems.join('; '));
	const text = result.content?.find((c) => c.type === 'text')?.text;
	let textMatches = false;
	try {
		textMatches = JSON.stringify(JSON.parse(text)) === JSON.stringify(sc);
	} catch {}
	if (!textMatches) textBlockMismatches.add(name);
	return { result, sc, status: sc.status, label };
}
const textBlockMismatches = new Set();

const statusOf = async (name, args) => (await call(name, args)).status;
const sameHost = (a, b) => a.replace(/^www\./, '') === b.replace(/^www\./, '');

// ---- Checks ------------------------------------------------------------------------

async function main() {
	// 1. initialize, without credentials
	const init = await rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: CHECKER.name, version: CHECKER.version } });
	const info = init.message?.result;
	check(init.res.status === 200 && !!info, 'MCP-001, DISC-001, DISC-005', '1. MCP initialize over Streamable HTTP, without credentials', `HTTP ${init.res.status}: ${JSON.stringify(init.message?.error ?? '').slice(0, 200)}`);
	if (!info) return;
	sessionId = init.res.headers.get('mcp-session-id') ?? undefined;
	check(String(info.protocolVersion) >= PROTOCOL, 'MCP-002', `   protocol revision is ${PROTOCOL} or later`, info.protocolVersion);
	check(!!info.capabilities?.tools, 'MCP-003', '   tools capability advertised');
	should(/MCP-WP|MCP Website Profile/i.test(info.instructions ?? ''), 'DISC-009', '   initialize instructions name MCP-WP', 'no mention of MCP-WP in instructions');
	await rpc('notifications/initialized', undefined, { notification: true });

	// 2. transport details
	if (endpoint.protocol === 'https:' && !isLocal) {
		const plain = new URL(endpoint);
		plain.protocol = 'http:';
		try {
			const r = await rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: CHECKER.name, version: CHECKER.version } }, { url: plain, redirect: 'manual' });
			check(!(r.res.status === 200 && r.message?.result), 'DISC-004', '2. plain HTTP does not serve MCP', 'http:// answered an MCP initialize');
		} catch (error) {
			if (error instanceof Incomplete) throw error;
			check(true, 'DISC-004', '2. plain HTTP does not serve MCP');
		}
		const alternate = new URL(endpoint);
		alternate.hostname = endpoint.hostname.startsWith('www.') ? endpoint.hostname.slice(4) : `www.${endpoint.hostname}`;
		try {
			const r = await rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: CHECKER.name, version: CHECKER.version } }, { url: alternate, redirect: 'manual' });
			const location = r.res.headers.get('location') ?? '';
			const ok = (r.res.status === 200 && r.message?.result) || ([307, 308].includes(r.res.status) && location.startsWith('https://'));
			should(ok, 'DISC-003', `   alternate host ${alternate.host} serves /mcp or redirects with 307/308`, `HTTP ${r.res.status}${location ? ` → ${location}` : ''}`);
		} catch (error) {
			if (error instanceof Incomplete) throw error;
			skip('DISC-003', `   alternate host ${alternate.host}`, 'could not connect (no such host, or a network or proxy block), so not checked');
		}
	} else skip('DISC-003, DISC-004', '2. HTTPS and alternate-host checks', 'not run against http:// or local endpoints');

	const preflight = await budgetedFetch(endpoint, { method: 'OPTIONS', headers: { Origin: 'https://example.org', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, mcp-protocol-version, mcp-session-id' } }).catch((e) => {
		if (e instanceof Incomplete) throw e;
		return null;
	});
	const allowHeaders = (preflight?.headers.get('access-control-allow-headers') ?? '').toLowerCase();
	const allowOrigin = preflight?.headers.get('access-control-allow-origin');
	should(!!allowOrigin && ['content-type', 'mcp-protocol-version', 'mcp-session-id'].every((h) => allowHeaders.includes(h) || allowHeaders === '*'), 'DISC-007', '   CORS preflight allows browser-based agents', `allow-origin=${allowOrigin ?? 'none'}, allow-headers=${allowHeaders || 'none'}`);
	const page = await budgetedFetch(endpoint, { headers: { Accept: 'text/html' } }).catch((e) => {
		if (e instanceof Incomplete) throw e;
		return null;
	});
	if ((page?.headers.get('content-type') ?? '').includes('text/html')) record('PASS', 'DISC-006', '   human-readable page for browsers');
	else skip('DISC-006', '   human-readable page for browsers', 'not offered (optional)');

	// 3. tools/list
	const list = (await rpc('tools/list', {})).message?.result?.tools ?? [];
	const byName = Object.fromEntries(list.map((t) => [t.name, t]));
	const annotated = (t, expected = READ_ONLY) => !!t && Object.entries(expected).every(([k, v]) => t.annotations?.[k] === v);
	const inputCompatible = (t) => {
		const std = schemas[t.name]?.input;
		if (!std) return true;
		const listed = t.inputSchema?.properties ?? {};
		return Object.keys(std.properties ?? {}).every((p) => p in listed) && (t.inputSchema?.required ?? []).every((r) => (std.required ?? []).includes(r));
	};
	const missing = (names) => names.filter((n) => !byName[n]);
	const failing = (names, test) => names.filter((n) => byName[n] && !test(byName[n]));
	check(missing(CORE).length === 0, 'CORE-001', '3. all five Core tools present', `missing: ${missing(CORE).join(', ')}`);
	check(failing(CORE, (t) => annotated(t)).length === 0, 'CORE-003', '   Core tools annotated read-only', failing(CORE, (t) => annotated(t)).join(', '));
	check(failing(CORE, inputCompatible).length === 0, 'CORE-004', '   Core input schemas accept the standard arguments, with no extra required ones', failing(CORE, inputCompatible).join(', '));
	should(failing(CORE, (t) => !!t.outputSchema).length === 0, 'CORE-005', '   Core tools declare an outputSchema', failing(CORE, (t) => !!t.outputSchema).join(', '));

	// 4. get_site_info
	const site = await call('get_site_info');
	check(site.status === 'ok', 'CORE-005', '4. get_site_info returns ok', site.protocolError ? JSON.stringify(site.protocolError).slice(0, 200) : site.status);
	if (site.status !== 'ok') return;
	const decl = site.sc.mcpwp;
	const modules = decl.modules ?? [];
	const extendedModules = modules.filter((m) => m in EXTENDED || m.startsWith('x-'));
	const consistent =
		decl.levels.includes('core') && modules.includes('core') &&
		decl.levels.includes('extended') === extendedModules.length > 0 &&
		decl.levels.includes('transactional') === modules.includes('transactions');
	check(consistent, 'DECL-001, DECL-002', `   declaration is consistent: levels ${decl.levels.join(', ')}; modules ${modules.join(', ')}`, JSON.stringify(decl));
	const canonicalHost = new URL(site.sc.canonical_url).hostname;
	if (isLocal) skip('DISC-001', '   canonical host matches the endpoint host', `local endpoint; canonical host is ${canonicalHost}`);
	else check(canonicalHost === endpoint.hostname, 'DISC-001', '   canonical host matches the endpoint host', `${canonicalHost} vs ${endpoint.hostname}`);

	// 5. sections
	const sections = site.sc.sections ?? [];
	const badSections = [];
	for (const s of sections.slice(0, 15)) {
		if ((await statusOf('get_page', { url: s.url })) !== 'ok' || (await statusOf('get_page', { id: s.id })) !== 'ok') badSections.push(s.id);
	}
	check(badSections.length === 0, 'CORE-010', `5. every section retrievable with get_page by url and id (${Math.min(sections.length, 15)} checked)`, badSections.join(', '));

	// 6. services and contact
	const services = await call('get_services');
	check(['ok', 'not_applicable'].includes(services.status), 'CORE-005, CORE-006, CORE-020', '6. get_services returns ok or not_applicable', services.status ?? JSON.stringify(services.protocolError));
	const contact = await call('get_contact');
	check(['ok', 'not_applicable'].includes(contact.status), 'CORE-005, CORE-006', '   get_contact returns ok or not_applicable', contact.status ?? JSON.stringify(contact.protocolError));
	const offerings = services.status === 'ok' ? services.sc.services : [];
	const category = services.sc?.categories?.[0];
	if (category) {
		const filtered = await call('get_services', { category });
		check(filtered.status === 'ok' && filtered.sc.services.every((s) => s.category === category), 'CORE-020', `   get_services category filter "${category}"`, filtered.status);
	}
	const firstPage = await call('get_services', { limit: 1 });
	if (firstPage.sc?.next_cursor) {
		const next = await call('get_services', { limit: 1, cursor: firstPage.sc.next_cursor });
		check(next.status === 'ok' && next.sc.services[0]?.id !== firstPage.sc.services[0]?.id, 'RES-023', '   get_services pagination with next_cursor', next.status);
	}

	// 7. search_site
	const candidates = [site.sc.name, ...sections.map((s) => s.title), ...offerings.map((o) => o.name)].filter(Boolean);
	let search;
	for (const query of [...new Set(candidates)].slice(0, 6)) {
		search = await call('search_site', { query, limit: 5 });
		if (search.sc?.results?.length) break;
	}
	check(!!search?.sc?.results?.length, 'CORE-040', `7. search_site finds content (query "${search?.sc?.query ?? candidates[0]}")`, 'no results for the site name, section titles or service names');
	const badResults = [];
	for (const r of search?.sc?.results ?? []) {
		if ((await statusOf('get_page', { id: r.id })) !== 'ok' || (await statusOf('get_page', { url: r.url })) !== 'ok') badResults.push(r.id);
	}
	check(badResults.length === 0, 'CORE-041', '   every search result id and url works with get_page', badResults.join(', '));
	const nonsense = await call('search_site', { query: 'zqxjvw kpqfzt' });
	check(nonsense.status === 'ok' && nonsense.sc.results.length === 0, 'CORE-042', '   a search with no matches returns ok with []', nonsense.status);
	const noQuery = await call('search_site', {});
	should(noQuery.status === 'invalid_request', 'RES-012', '   a missing query returns an invalid_request result', noQuery.status ?? 'protocol error');
	const uncovered = [];
	for (const o of offerings.slice(0, 10)) {
		const hit = await call('search_site', { query: o.name, limit: 10 });
		if (!hit.sc?.results?.some((r) => r.url === o.url)) uncovered.push(o.id);
	}
	if (offerings.length) check(uncovered.length === 0, 'CORE-040', `   search covers offering URLs (${Math.min(offerings.length, 10)} checked)`, uncovered.join(', '));

	// 8. get_page errors
	check((await statusOf('get_page', { url: 'https://example.invalid/' })) === 'invalid_request', 'CORE-050', '8. get_page with an off-site URL returns invalid_request');
	check((await statusOf('get_page', { url: '/mcpwp-conformance-no-such-page' })) === 'not_found', 'CORE-052', '   get_page with an unknown path returns not_found');
	check((await statusOf('get_page', {})) === 'invalid_request', 'CORE-004', '   get_page with neither id nor url returns invalid_request');
	if (sections[0]) check((await statusOf('get_page', { id: sections[0].id, url: sections[0].url })) === 'invalid_request', 'CORE-004', '   get_page with both id and url returns invalid_request');

	// 10. extension tools
	const declaredTools = new Set([...CORE, ...modules.flatMap((m) => EXTENDED[m] ?? []), ...(modules.includes('transactions') ? TRANSACTIONAL : [])]);
	const extensions = list.map((t) => t.name).filter((n) => !declaredTools.has(n));
	check(extensions.every((n) => !RESERVED.has(n)), 'EXTN-001, DECL-003', `10. no undeclared tool uses a reserved name${extensions.length ? ` (extension tools: ${extensions.join(', ')})` : ''}`, extensions.filter((n) => RESERVED.has(n)).join(', ') + ' are standard tools from modules the site does not declare');
	const listedExtensions = (decl.extensions ?? []).map((e) => e.tool);
	const unlisted = extensions.filter((n) => !RESERVED.has(n) && !listedExtensions.includes(n));
	if (extensions.length) should(unlisted.length === 0, 'DECL-004', '   extension tools listed in mcpwp.extensions', unlisted.join(', '));

	// 11-14. Extended modules
	for (const module of extendedModules) {
		const tools = EXTENDED[module];
		if (!tools) {
			skip('SECT-001', `11. [${module}] sector module`, 'sector modules are not checked');
			continue;
		}
		check(missing(tools).length === 0, 'LVL-004, DECL-003', `11. [${module}] all module tools present`, `missing: ${missing(tools).join(', ')}`);
		check(failing(tools, (t) => annotated(t) && inputCompatible(t)).length === 0, 'CORE-003, CORE-004', `    [${module}] tools read-only, with standard inputs`, failing(tools, (t) => annotated(t) && inputCompatible(t)).join(', '));
		if (missing(tools).length) continue;
		if (module === 'service_details') await checkServiceDetails(offerings);
		if (module === 'insights') await checkInsights();
		if (module === 'people') await checkPeople();
		if (module === 'events') await checkEvents();
	}

	// 15. Transactional: presence and annotations only
	if (modules.includes('transactions')) {
		const required = ['list_transaction_types', 'prepare_transaction', 'submit_transaction', 'get_transaction_status'];
		check(missing(required).length === 0, 'TXN-001', '15. [transactions] required tools present', `missing: ${missing(required).join(', ')}`);
		const wrong = TRANSACTIONAL.filter((n) => byName[n] && !annotated(byName[n], TXN_ANNOTATIONS[n]));
		check(wrong.length === 0, 'TXN-002', '    [transactions] annotations match TXN-002', wrong.join(', '));
		skip('TXN-010, TXN-020, TXN-030, TXN-040', '    [transactions] behaviour', 'not tested: this checker never calls Transactional tools');
	}

	if (textBlockMismatches.size) warn('RES-002', 'results include the structuredContent JSON as a text block', [...textBlockMismatches].join(', '));
	else record('PASS', 'RES-002', 'results include the structuredContent JSON as a text block');
}

/** Content from an Extended module is reachable through Core (XTD-001). */
async function reachableThroughCore(module, title, url) {
	const found = await call('search_site', { query: title, limit: 10 });
	const inSearch = !!found.sc?.results?.some((r) => r.url === url);
	const retrievable = (await statusOf('get_page', { url })) === 'ok';
	check(inSearch && retrievable, 'XTD-001', `    [${module}] sample appears in search_site and resolves with get_page`, `search: ${inSearch}, get_page: ${retrievable} (${url})`);
}

async function checkServiceDetails(offerings) {
	const bad = [];
	for (const o of offerings.slice(0, 10)) {
		const byId = await call('get_service', { id: o.id });
		const byUrl = await call('get_service', { url: o.url });
		if (byId.status !== 'ok' || byUrl.status !== 'ok' || byId.sc.id !== o.id) bad.push(o.id);
	}
	check(bad.length === 0, 'SVC-001, XTD-002', `12. [service_details] every get_services id and url works with get_service (${Math.min(offerings.length, 10)} checked)`, bad.join(', '));
	check((await statusOf('get_service', { id: 'mcpwp-conformance-no-such-service' })) === 'not_found', 'SVC-001', '    [service_details] unknown id returns not_found');
}

async function checkInsights() {
	const topics = await call('list_topics');
	check(topics.status === 'ok', 'INS-001', '12. [insights] list_topics returns ok', topics.status);
	const bad = [];
	for (const t of (topics.sc?.topics ?? []).slice(0, 10)) {
		const r = await call('search_insights', { topic: t.id, limit: 1 });
		if (r.status !== 'ok' || (t.count > 0 && r.sc.results.length === 0)) bad.push(`topic:${t.id}`);
	}
	for (const s of (topics.sc?.series ?? []).slice(0, 10)) {
		const r = await call('latest_insights', { series: s.id, limit: 1 });
		if (r.status !== 'ok' || (s.count > 0 && r.sc.results[0]?.series !== s.id)) bad.push(`series:${s.id}`);
	}
	check(bad.length === 0, 'INS-002', '    [insights] list_topics ids work as topic and series filters', bad.join(', '));
	const latest = await call('latest_insights', { limit: 5 });
	const dates = (latest.sc?.results ?? []).map((r) => Date.parse(r.published_at));
	check(latest.status === 'ok' && dates.every((d, i) => i === 0 || dates[i - 1] >= d), 'INS-001', '    [insights] latest_insights is newest first', latest.status);
	const first = await call('search_insights', { limit: 2 });
	if (first.sc?.next_cursor) {
		const second = await call('search_insights', { limit: 2, cursor: first.sc.next_cursor });
		check(second.status === 'ok' && second.sc.results[0]?.id !== first.sc.results[0]?.id, 'RES-023', '    [insights] search_insights pagination with next_cursor', second.status);
	}
	const sample = latest.sc?.results?.[0];
	if (!sample) return skip('INS-001', '    [insights] get_insight', 'no insights published');
	const byId = await call('get_insight', { id: sample.id });
	const byUrl = await call('get_insight', { url: sample.url });
	check(byId.status === 'ok' && byUrl.status === 'ok', 'INS-001', '    [insights] get_insight by id and by url', `${byId.status} / ${byUrl.status}`);
	check((await statusOf('get_insight', { id: 'mcpwp-conformance-no-such-insight' })) === 'not_found', 'INS-001', '    [insights] unknown id returns not_found');
	await reachableThroughCore('insights', sample.title, sample.url);
}

async function checkPeople() {
	const people = await call('get_people');
	check(people.status === 'ok', 'PPL-001', '12. [people] get_people returns ok', people.status);
	const bad = [];
	for (const p of (people.sc?.people ?? []).slice(0, 5)) {
		if ((await statusOf('get_person', { id: p.id })) !== 'ok' || (p.url && (await statusOf('get_person', { url: p.url })) !== 'ok')) bad.push(p.id);
	}
	check(bad.length === 0, 'PPL-001, XTD-002', '    [people] get_people ids and urls work with get_person', bad.join(', '));
	check((await statusOf('get_person', { id: 'mcpwp-conformance-no-such-person' })) === 'not_found', 'PPL-001', '    [people] unknown id returns not_found');
	const sample = (people.sc?.people ?? []).find((p) => p.url);
	if (sample) await reachableThroughCore('people', sample.name, sample.url);
}

async function checkEvents() {
	const events = await call('get_events');
	check(events.status === 'ok', 'EVT-001', '12. [events] get_events returns ok', events.status);
	const list = events.sc?.events ?? [];
	const now = Date.now();
	const past = list.filter((e) => Date.parse(e.end ?? e.start) < now).map((e) => e.id);
	check(past.length === 0, 'EVT-002', '14. [events] get_events with no arguments returns no past events', past.join(', '));
	const starts = list.map((e) => Date.parse(e.start));
	check(starts.every((s, i) => i === 0 || starts[i - 1] <= s), 'EVT-001', '    [events] ordered by start, earliest first');
	const sample = list[0];
	if (!sample) return skip('EVT-001', '    [events] get_event', 'no upcoming events');
	const byId = await call('get_event', { id: sample.id });
	check(byId.status === 'ok' && typeof byId.sc.content === 'string', 'EVT-001', '    [events] get_event by id', byId.status);
	check((await statusOf('get_event', { id: 'mcpwp-conformance-no-such-event' })) === 'not_found', 'EVT-001', '    [events] unknown id returns not_found');
	await reachableThroughCore('events', sample.name, sample.url);
}

// ---- Run ---------------------------------------------------------------------------

let incomplete = null;
try {
	await main();
} catch (error) {
	incomplete = error instanceof Incomplete ? error.message : `stopped by an error: ${error?.cause?.message ?? error?.message ?? error}`;
}

const count = (level) => results.filter((r) => r.level === level).length;
const summary = { pass: count('PASS'), fail: count('FAIL'), warn: count('WARN'), skip: count('SKIP'), requests };
const declared = results.find((r) => r.name.startsWith('   declaration is consistent'))?.name.replace('   declaration is consistent: ', '') ?? null;

if (options.json) {
	console.log(JSON.stringify({ checker: CHECKER, endpoint: endpoint.href, started: new Date(started).toISOString(), finished: new Date().toISOString(), declared, complete: !incomplete, incomplete, summary, results }, null, 2));
} else {
	console.log(`MCP-WP ${CHECKER.mcpwp} conformance: ${endpoint.href}\n`);
	for (const r of results) {
		const req = r.requirements.length ? ` [${r.requirements.join(', ')}]` : '';
		console.log(`${r.level.padEnd(4)}  ${r.name}${req}${r.detail ? `\n        ${r.detail}` : ''}`);
	}
	if (incomplete) console.log(`\nINCOMPLETE: ${incomplete}. Later checks were not run.`);
	console.log(`\n${summary.pass} passed, ${summary.fail} failed, ${summary.warn} warnings, ${summary.skip} skipped (${requests} requests)`);
	if (declared) console.log(`Declared: ${declared}`);
	console.log('A passing run samples the site; it is not certification. See SPECIFICATION.md §12.');
}

process.exit(summary.fail ? 1 : incomplete ? 2 : 0);
