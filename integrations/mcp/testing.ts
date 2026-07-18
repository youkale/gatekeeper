/**
 * Test-only helper for wiring an MCP `Client` to a `McpServer` instance over
 * an in-memory transport for a real protocol round trip.
 *
 * This lives inside integrations/mcp/ (not tests/) on purpose: Node/TS bare
 * specifier resolution for `@modelcontextprotocol/sdk/*` is always relative
 * to the *importing file's own location*, walking up through its own
 * node_modules chain -- a file under the parent repo's tests/ directory
 * cannot resolve a devDependency that only lives in
 * integrations/mcp/node_modules. Routing the real SDK Client import through
 * a file that lives in this package (same trick integrations/pi/index.ts
 * uses for its host type re-exports) keeps the parent package's tests/
 * free of a direct dependency on this package's node_modules.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export { Client } from "@modelcontextprotocol/sdk/client/index.js";
export type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface TestConnection {
	client: Client;
	close: () => Promise<void>;
}

/** Connects a fresh client/server pair over an in-memory transport for one test. */
export async function connectInMemory(server: McpServer): Promise<TestConnection> {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "gatekeeper-mcp-test-client", version: "0.0.0" });
	await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
	return {
		client,
		close: async () => {
			await client.close();
			await server.close();
		},
	};
}
