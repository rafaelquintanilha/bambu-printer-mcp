#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

// Keep the upstream server available while giving this executable a fixed workflow.
// By default a small supervisor keeps the client's MCP session and runs the
// server as a child, loading a rebuilt dist/ without the client reconnecting.
const entry = fileURLToPath(import.meta.url);
if (process.env.BAMBU_X2D_SUPERVISED === "1" || process.env.BAMBU_X2D_HOT_RELOAD === "0") {
  process.env.MCP_PROFILE = "x2d";
  await import("./index.js");
} else {
  const { runX2dSupervisor } = await import("./x2d-supervisor.js");
  const settle = Number(process.env.BAMBU_X2D_RELOAD_SETTLE_MS);
  const code = await runX2dSupervisor({
    command: process.execPath,
    args: [...process.execArgv, entry],
    env: { ...process.env, BAMBU_X2D_SUPERVISED: "1" },
    distDirectory: path.dirname(entry),
    ...(Number.isFinite(settle) && settle >= 0 ? { settleMs: settle } : {}),
  });
  process.exit(code);
}
