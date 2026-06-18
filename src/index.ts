/**
 * MCP server entrypoint. Connects the HacknPlan server to stdio so an MCP host
 * (Claude Code, Claude Desktop, etc.) can launch it as a subprocess.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { HacknPlanClient } from "./client.js";
import { buildServer } from "./server.js";

export async function serve(): Promise<void> {
  const apiKey = process.env.HACKNPLAN_API_KEY ?? "";
  if (!apiKey) {
    // Fail loudly on stderr (stdout is the MCP transport and must stay clean).
    process.stderr.write(
      "[hacknplan-mcp] HACKNPLAN_API_KEY is not set. " +
        "Run `npx @mtuska/hacknplan-mcp install` to configure it, " +
        "or set the env var before launching the server.\n",
    );
    process.exit(1);
  }

  const hp = new HacknPlanClient(apiKey);
  const server = buildServer(hp);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The process stays alive while the transport is connected.
}

export { buildServer } from "./server.js";
export { HacknPlanClient, HacknPlanError } from "./client.js";
