// A tiny MCP-WP Core site for testing the checker without a live endpoint.
// It speaks just enough MCP (JSON responses, no SSE) for the checker: initialize,
// notifications, tools/list and tools/call, with the five Core tools over an
// in-memory site. `broken: true` leaves out get_page, so Core is incomplete.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMAS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'schemas', 'core');
const schema = (tool, io) => {
	const { $schema, $id, ...rest } = JSON.parse(readFileSync(join(SCHEMAS, `${tool}.${io}.json`), 'utf8'));
	return rest;
};

const SITE = 'https://www.example.com';
const HOSTS = new Set(['www.example.com', 'example.com']);
const PAGES = {
	'/': { title: 'Example Studio', content: '# Example Studio\n\nA small studio that designs websites.' },
	'/about': { title: 'About', content: '# About\n\nTwo designers in Victoria, BC.' },
	'/contact': { title: 'Contact', content: '# Contact\n\nEmail hello@example.com.' },
	'/services/web-design': { title: 'Web design', content: '# Web design\n\nAccessible websites for small organisations.' }
};
const SECTIONS = [
	{ id: 'home', title: 'Home', url: `${SITE}/` },
	{ id: 'about', title: 'About', url: `${SITE}/about` },
	{ id: 'contact', title: 'Contact', url: `${SITE}/contact` }
];
const SERVICES = [{ id: 'web-design', name: 'Web design', type: 'service', description: 'Accessible websites for small organisations.', url: `${SITE}/services/web-design`, category: 'Design' }];
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const pageId = (path) => (path === '/' ? 'home' : path.slice(1));
const ok = (body) => ({ status: 'ok', ...body });
const fail = (status, message) => ({ status, error: { message } });

function locate(input) {
	if (input.startsWith('/')) return { path: input.split(/[?#]/)[0].replace(/(.)\/+$/, '$1') };
	try {
		const url = new URL(input);
		if (!HOSTS.has(url.host)) return { error: fail('invalid_request', 'Only pages on www.example.com can be retrieved.') };
		return { path: url.pathname.replace(/(.)\/+$/, '$1') };
	} catch {
		return { error: fail('invalid_request', 'url must be absolute or root-relative.') };
	}
}

const HANDLERS = {
	get_site_info: () =>
		ok({
			mcpwp: { version: '0.1', levels: ['core'], modules: ['core'] },
			name: 'Example Studio',
			description: 'A small web design studio.',
			canonical_url: `${SITE}/`,
			language: 'en',
			site_type: 'business',
			sections: SECTIONS
		}),
	get_services: ({ category, limit = 50, cursor }) => {
		const all = category ? SERVICES.filter((s) => s.category === category) : SERVICES;
		const offset = cursor ? Number(cursor) : 0;
		const page = all.slice(offset, offset + limit);
		return ok({ services: page, categories: ['Design'], ...(offset + limit < all.length ? { next_cursor: String(offset + limit) } : {}) });
	},
	get_contact: () => ok({ channels: [{ type: 'email', value: 'hello@example.com' }], contact_url: `${SITE}/contact` }),
	search_site: ({ query, limit = 10 }) => {
		if (typeof query !== 'string' || !query) return fail('invalid_request', 'query is required.');
		const words = query.toLowerCase().split(/\W+/).filter(Boolean);
		const results = Object.entries(PAGES)
			.filter(([, p]) => words.some((w) => `${p.title} ${p.content}`.toLowerCase().includes(w)))
			.slice(0, limit)
			.map(([path, p]) => ({ id: pageId(path), title: p.title, url: `${SITE}${path}` }));
		return ok({ query, results });
	},
	get_page: ({ id, url }) => {
		if ((id === undefined) === (url === undefined)) return fail('invalid_request', 'Provide exactly one of id or url.');
		let path;
		if (url !== undefined) {
			const located = locate(url);
			if (located.error) return located.error;
			path = located.path;
		} else path = id === 'home' ? '/' : `/${id}`;
		const page = PAGES[path];
		if (!page) return fail('not_found', `No page at ${path}. Use search_site.`);
		return ok({ id: pageId(path), title: page.title, url: `${SITE}${path}`, content_format: 'text/markdown', content: page.content });
	}
};

export function startFixture({ broken = false } = {}) {
	const tools = Object.keys(HANDLERS).filter((name) => !(broken && name === 'get_page'));
	const listed = tools.map((name) => ({ name, description: `MCP-WP Core: ${name}`, inputSchema: schema(name, 'input'), outputSchema: schema(name, 'output'), annotations: READ_ONLY }));

	const server = createServer(async (req, res) => {
		const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID' };
		if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
		if (req.method === 'GET') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h1>Example Studio MCP server</h1>');
		let body = '';
		for await (const chunk of req) body += chunk;
		const message = JSON.parse(body);
		if (message.id === undefined) return res.writeHead(202, cors).end();
		let result;
		if (message.method === 'initialize') {
			result = { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'fixture', version: '1.0.0' }, instructions: 'This server implements the MCP Website Profile (MCP-WP) 0.1 at level core. Call get_site_info first.' };
		} else if (message.method === 'tools/list') {
			result = { tools: listed };
		} else if (message.method === 'tools/call' && tools.includes(message.params.name)) {
			const sc = HANDLERS[message.params.name](message.params.arguments ?? {});
			result = { content: [{ type: 'text', text: JSON.stringify(sc) }], structuredContent: sc, isError: sc.status !== 'ok' };
		} else {
			return res.writeHead(200, { 'Content-Type': 'application/json', ...cors }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Unknown method or tool' } }));
		}
		res.writeHead(200, { 'Content-Type': 'application/json', ...cors }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
	});

	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			resolve({ url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise((r) => server.close(r)) });
		});
	});
}
