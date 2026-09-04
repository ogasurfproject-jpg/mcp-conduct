// Wrap an MCP SDK client so every connect consults the gate first.
// npm i mcp-conduct @modelcontextprotocol/sdk
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { conductGate, ConductBlocked } from "mcp-conduct";

const gate = conductGate({ policy: "measured" });
const client = gate.guard(new Client({ name: "example-agent", version: "0.1.0" }));

try {
  await client.connect(new StreamableHTTPClientTransport(new URL(process.argv[2] || "https://mcp.horizonshield.dev/mcp")));
  const tools = await client.listTools();
  console.log("connected; tools:", tools.tools.map((t) => t.name).join(", "));
} catch (e) {
  if (e instanceof ConductBlocked) {
    console.error(e.message);
    console.error("verdict:", JSON.stringify(e.verdict, null, 2));
    process.exit(2);
  }
  throw e;
}
