import assert from "node:assert/strict";
import test from "node:test";
import { discoverAgents } from "./agents.ts";

test("discoverAgents exposes the dedicated orchestrator planner builtin", () => {
	const { agents } = discoverAgents("/tmp", "both");
	const agent = agents.find((entry) => entry.name === "orchestrator-planner");
	assert.ok(agent);
	assert.equal(agent?.source, "builtin");
	assert.equal(agent?.output, undefined);
	assert.equal(agent?.defaultReads, undefined);
	assert.deepEqual(agent?.tools, ["read", "grep", "find", "ls"]);
});
