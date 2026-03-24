import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSubagentDroidAutoOverride, resolveSubagentProviderEnv } from "./provider-env.ts";

describe("resolveSubagentDroidAutoOverride", () => {
	it("prefers per-agent override over shared override", () => {
		const env = {
			PI_SUBAGENT_DROID_AUTO: "low",
			PI_SUBAGENT_WORKER_DROID_AUTO: "high",
		} satisfies NodeJS.ProcessEnv;

		assert.equal(resolveSubagentDroidAutoOverride("worker", env), "high");
	});

	it("normalizes agent names for override lookup", () => {
		const env = {
			PI_SUBAGENT_CONTEXT_BUILDER_DROID_AUTO: "medium",
		} satisfies NodeJS.ProcessEnv;

		assert.equal(resolveSubagentDroidAutoOverride("context-builder", env), "medium");
	});

	it("ignores ambient PI_DROID_AUTO", () => {
		const env = {
			PI_DROID_AUTO: "low",
		} satisfies NodeJS.ProcessEnv;

		assert.equal(resolveSubagentDroidAutoOverride("worker", env), undefined);
	});
});

describe("resolveSubagentProviderEnv", () => {
	it("defaults workers to high autonomy", () => {
		assert.deepEqual(resolveSubagentProviderEnv("worker", {}), {
			PI_DROID_AUTO: "high",
		});
	});

	it("defaults non-worker agents to medium autonomy", () => {
		assert.deepEqual(resolveSubagentProviderEnv("planner", {}), {
			PI_DROID_AUTO: "medium",
		});
	});

	it("uses shared subagent override when present", () => {
		assert.deepEqual(resolveSubagentProviderEnv("reviewer", {
			PI_SUBAGENT_DROID_AUTO: "low",
			PI_DROID_AUTO: "high",
		}), {
			PI_DROID_AUTO: "low",
		});
	});
});
