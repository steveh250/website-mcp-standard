# MCP-WP — MCP Website Profile

**An open specification defining how websites expose standardised information, capabilities and services to AI agents using the Model Context Protocol.**

> **Status:** v0.1 — Proposed Draft, open for comment. Not yet stable. The Transactional level is provisional.

Websites are built for people. Agents can read them, but every site has different navigation, layout and terminology, and no consistent way to *do* anything. MCP-WP gives agents a predictable front door:

```text
https://<your-site>/mcp
```

Behind that door, a site offers standard [MCP](https://modelcontextprotocol.io/) tools at up to three conformance levels:

| Level | What it covers | Tools |
|---|---|---|
| **Core** (mandatory) | Website identity, organisation overview, content discovery, page retrieval, service catalogue, contact | `get_site_info`, `get_services`, `get_contact`, `search_site`, `get_page` |
| **Extended** (optional) | Structured content, product and service details, people, events, sector-specific information | Modules: `insights` (`search_insights`, `get_insight`, `latest_insights`, `list_topics`), `service_details` (`get_service`), `people` (`get_people`, `get_person`), `events` (`get_events`, `get_event`), `x-<sector>` |
| **Transactional** (optional) | Agent-executable interactions with authentication, permissions, user approval and audit | `list_transaction_types`, `check_availability`, `prepare_transaction`, `submit_transaction`, `get_transaction_status`, `cancel_transaction` |

Core and Extended are public and read-only. They can be a small, deterministic layer over your CMS or static content, with no AI model needed on the site. The Transactional level uses MCP's OAuth-based authorisation, and follows a **prepare → user approves → submit** lifecycle with idempotency keys and an audit history. Payment details never pass through the tools.

MCP-WP is a *profile* of MCP. It reuses MCP's transport, tool discovery, structured output and authorisation, and adds only conventions: a fixed path, standard tool names, standard result shapes and safety rules.

## Read the standard

- **[SPECIFICATION.md](SPECIFICATION.md)**: the normative v0.1 specification
- **[schemas/](schemas/)**: JSON Schema (2020-12) for every tool's input and output, organised as `core/`, `extended/` and `transactional/`
- **[examples/](examples/)**: example results for a consultancy site (all three levels) and a personal blog (Core only)
- **[CHANGELOG.md](CHANGELOG.md)** · **[CONTRIBUTING.md](CONTRIBUTING.md)**

## Implementing MCP-WP on your site

**Core (every site)**

1. Serve an MCP server (Streamable HTTP, MCP revision 2025-06-18 or later) at `https://<canonical-host>/mcp`. Do not require authentication for Core or Extended tools.
2. Implement the five Core tools with the exact names above. Mark them `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true` and `openWorldHint: false`.
3. Return `structuredContent` that validates against [`schemas/core/`](schemas/core/), with a `status` in every result. Also return the same JSON as a `text` content block.
4. In `get_site_info`, declare `"mcpwp": { "version": "0.1", "levels": ["core"], "modules": ["core"] }`.
5. Make sure every `search_site` result and every section URL can be fetched with `get_page`. Make sure `get_page` never fetches off-site URLs.
6. Use `not_applicable` (with a `reason`) rather than inventing content, for example `get_services` on a personal blog.

**Extended (if relevant):** add whichever modules fit your content. Then add `"extended"` to `levels` and the module names to `modules`.

**Transactional (if you want agents to act):** describe each transaction type, including its `details_schema`, its `consequences` and whether it needs authentication. Then implement the lifecycle tools, require user approval and idempotency keys, keep an audit history, and provide a `test` type. See [SPECIFICATION.md §8](SPECIFICATION.md#8-transactional-level-provisional).

**Optionally:** add CORS headers, redirect the apex/`www` host's `/mcp` with 307/308, mention `/mcp` in your `llms.txt`, and serve a human-readable page for browser `GET /mcp`.

## Reference implementation

[AI4Enterprise](https://www.ai4enterprise.ca/) runs an MCP server at `https://www.ai4enterprise.ca/mcp`. It implements *MCP-WP 0.1 Extended (`insights`, `service_details`)* and passes the reference conformance checker. See [SPECIFICATION.md §13](SPECIFICATION.md#13-reference-implementation-ai4enterprise-informative).

## Validating the schemas and examples

```bash
pip install jsonschema
```

```bash
python3 tools/validate_examples.py
python3 -m unittest discover -s tests -v
```

Run these commands from the repository root. The validator rejects duplicate JSON
keys in schemas and examples. Event `start` and `end` values require a UTC offset
even without optional format-checking packages. For full date-time format checks,
install `jsonschema[format-nongpl]` instead of bare `jsonschema`.

## Checking a live endpoint

[`tools/conformance/`](tools/conformance/) holds a read-only conformance checker for MCP-WP endpoints. It runs the checks in [SPECIFICATION.md §12](SPECIFICATION.md#12-conformance-testing) for Core and for each Extended module the site declares. It validates every result against the schemas in this repository and reports PASS, FAIL, WARN or SKIP against requirement IDs. It needs Node.js 20 or later.

```bash
cd tools/conformance && npm install
```

```bash
node conformance.mjs www.example.com
```

- **Target:** give a host name (the checker derives `https://<host>/mcp`) or a full endpoint URL, such as `http://localhost:8787/mcp` for a development server.
- **JSON report:** `--json` prints a machine-readable report.
- **Limits:** `--max-requests` (default 400) and `--max-minutes` (default 15) bound a run. If a limit runs out, the report says the run is incomplete.
- **Exit codes:** `0` means no failures, `1` at least one failure, `2` an incomplete run.

The checker never calls Transactional tools. For a site that declares `transactions`, it checks only tool presence and annotations. It waits and retries when the server rate-limits it. A passing run samples the site and is not certification. `npm test` runs the checker against a local fixture server, so the checker itself can be tested without a live site.

## Repository layout

```text
SPECIFICATION.md            Normative specification (v0.1)
schemas/core/               Core tool input/output JSON Schemas
schemas/extended/           Extended module schemas (insights, service_details, people, events)
schemas/transactional/      Transactional module schemas
examples/consultancy/       Example results: business site with all three levels
examples/personal-blog/     Example results: personal site (shows not_applicable)
tools/validate_examples.py  Validates every example against its schema
tools/conformance/          Conformance checker for live MCP-WP endpoints (Node.js)
```

## Roadmap

- **v0.1** (this draft): three levels, schemas and examples, plus AI4Enterprise alignment.
- **Next:** extend the conformance checker in `tools/conformance/` (see issue #4), more implementations, and feedback from different site types.
- **v0.2:** refine the Transactional level from real implementations, add Extended modules (FAQs, locations, jobs), standardise sector modules, align with MCP discovery work (Server Cards), and support multilingual sites.

## Contributing

Feedback is very welcome, especially from people implementing MCP-WP on real sites or building agents that consume it. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Copyright 2026 AI4 Enterprise Corp. and MCP-WP contributors.

- **Specification and documentation** (`SPECIFICATION.md` and the other Markdown files): [CC BY 4.0](LICENSE-SPEC). You may share and adapt them, with attribution.
- **Schemas, examples and tools** (`schemas/`, `examples/`, `tools/`): [Apache License 2.0](LICENSE). You may use them freely in your own implementations, open or commercial.

Anyone may implement MCP-WP on a website, MCP server or agent. See [NOTICE](NOTICE).
