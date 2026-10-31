#!/usr/bin/env node

// Keep the upstream server available while giving this executable a fixed workflow.
process.env.MCP_PROFILE = "x2d";
await import("./index.js");
