import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

const SLASH_RESULT_TYPE = "subagent-slash-result";
const SLASH_SUBAGENT_REQUEST_EVENT = "subagent:slash:request";
const SLASH_SUBAGENT_STARTED_EVENT = "subagent:slash:started";
const SLASH_SUBAGENT_RESPONSE_EVENT = "subagent:slash:response";

interface EventBus {
	on(event: string, handler: (data: unknown) => void): () => void;
	emit(event: string, data: unknown): void;
}

interface RegisterSlashCommandsModule {
	registerSlashCommands?: (
		pi: {
			events: EventBus;
			registerCommand(
				name: string,
				spec: { handler(args: string, ctx: unknown): Promise<void>; getArgumentCompletions?: (prefix: string) => unknown },
			): void;
			registerShortcut(key: string, spec: { handler(ctx: unknown): Promise<void> }): void;
			sendMessage(message: unknown): void;
		},
		state: {
			baseCwd: string;
			currentSessionId: string | null;
			asyncJobs: Map<string, unknown>;
			cleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
			lastUiContext: unknown;
			poller: NodeJS.Timeout | null;
			completionSeen: Map<string, number>;
			watcher: unknown;
			watcherRestartTimer: ReturnType<typeof setTimeout> | null;
			resultFileCoalescer: { schedule(file: string, delayMs?: number): boolean; clear(): void };
		},
	) => void;
}

let registerSlashCommands: RegisterSlashCommandsModule["registerSlashCommands"];
let getSubagentUserConfigPath: (() => string) | undefined;
let available = true;
const originalHome = process.env.HOME;
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-home-"));
process.env.HOME = testHome;
try {
	({ registerSlashCommands } = await import("./slash-commands.ts") as RegisterSlashCommandsModule);
	({ getSubagentUserConfigPath } = await import("./config.ts") as { getSubagentUserConfigPath(): string });
} catch {
	available = false;
}

after(() => {
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	fs.rmSync(testHome, { recursive: true, force: true });
});

function createEventBus(): EventBus {
	const handlers = new Map<string, Array<(data: unknown) => void>>();
	return {
		on(event, handler) {
			const existing = handlers.get(event) ?? [];
			existing.push(handler);
			handlers.set(event, existing);
			return () => {
				const current = handlers.get(event) ?? [];
				handlers.set(event, current.filter((entry) => entry !== handler));
			};
		},
		emit(event, data) {
			for (const handler of handlers.get(event) ?? []) {
				handler(data);
			}
		},
	};
}

function createState(cwd: string) {
	return {
		baseCwd: cwd,
		currentSessionId: null,
		asyncJobs: new Map(),
		cleanupTimers: new Map(),
		lastUiContext: null,
		poller: null,
		completionSeen: new Map(),
		watcher: null,
		watcherRestartTimer: null,
		resultFileCoalescer: {
			schedule: () => false,
			clear: () => {},
		},
	};
}

function createCommandContext() {
	return {
		cwd: process.cwd(),
		hasUI: false,
		ui: {
			notify: (_message: string) => {},
			setStatus: (_key: string, _text: string | undefined) => {},
			onTerminalInput: () => () => {},
			custom: async () => undefined,
		},
		modelRegistry: { getAvailable: () => [] },
	};
}

describe("slash command custom message delivery", { skip: !available ? "slash-commands.ts not importable" : undefined }, () => {
	it("/subagent-backend reports the effective backend and config paths", async () => {
		const sent: unknown[] = [];
		const printed: string[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const pi = {
			events: createEventBus(),
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(message: unknown) {
				sent.push(message);
			},
		};

		const originalLog = console.log;
		console.log = (message?: unknown) => {
			printed.push(String(message ?? ""));
		};
		try {
			registerSlashCommands!(pi, createState(process.cwd()));
			await commands.get("subagent-backend")!.handler("", createCommandContext());
		} finally {
			console.log = originalLog;
		}

		assert.equal(sent.length, 0);
		assert.equal(printed.length, 1);
		assert.match(printed[0]!, /Foreground subagent backend: process/);
		assert.match(printed[0]!, /Source: default/);
		assert.match(printed[0]!, new RegExp(getSubagentUserConfigPath!().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	});

	it("/subagent-backend tmux persists the user config outside the repo checkout", async () => {
		const sent: unknown[] = [];
		const printed: string[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const pi = {
			events: createEventBus(),
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(message: unknown) {
				sent.push(message);
			},
		};

		const originalLog = console.log;
		console.log = (message?: unknown) => {
			printed.push(String(message ?? ""));
		};
		try {
			registerSlashCommands!(pi, createState(process.cwd()));
			await commands.get("subagent-backend")!.handler("tmux", createCommandContext());
		} finally {
			console.log = originalLog;
		}

		const configPath = getSubagentUserConfigPath!();
		const saved = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { syncBackend?: string };
		assert.equal(saved.syncBackend, "tmux");
		assert.equal(sent.length, 0);
		assert.equal(printed.length, 1);
		assert.match(printed[0]!, /Saved foreground subagent backend: tmux/);
		assert.equal(configPath.includes("/.pi/agent/subagent-config.json"), true);
	});

	it("/run sends an inline slash result message after a successful bridge response", async () => {
		const sent: unknown[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const requestId = (data as { requestId: string }).requestId;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId,
				result: {
					content: [{ type: "text", text: "Scout finished" }],
					details: { mode: "single", results: [] },
				},
				isError: false,
			});
		});

		const pi = {
			events,
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(message: unknown) {
				sent.push(message);
			},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("run")!.handler("scout inspect this", createCommandContext());

		assert.equal(sent.length, 2);
		assert.deepEqual(sent[0], {
			customType: SLASH_RESULT_TYPE,
			content: "inspect this",
			display: true,
			details: {
				requestId: (sent[0] as { details: { requestId: string } }).details.requestId,
				result: {
					content: [{ type: "text", text: "inspect this" }],
					details: {
						mode: "single",
						progress: [
							{
								agent: "scout",
								status: "running",
								task: "inspect this",
								recentTools: [],
								recentOutput: [],
								toolCount: 0,
								tokens: 0,
								durationMs: 0,
							},
						],
						results: [
							{
								agent: "scout",
								task: "inspect this",
								exitCode: 0,
								messages: [],
								usage: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									cost: 0,
									turns: 0,
								},
								progress: {
									agent: "scout",
									status: "running",
									task: "inspect this",
									recentTools: [],
									recentOutput: [],
									toolCount: 0,
									tokens: 0,
									durationMs: 0,
								},
							},
						],
					},
				},
			},
		});
		assert.deepEqual(sent[1], {
			customType: SLASH_RESULT_TYPE,
			content: "Scout finished",
			display: false,
			details: {
				requestId: (sent[0] as { details: { requestId: string } }).details.requestId,
				result: {
					content: [{ type: "text", text: "Scout finished" }],
					details: { mode: "single", results: [] },
				},
			},
		});
	});

	it("/run still sends an inline slash result message when the bridge returns an error", async () => {
		const sent: unknown[] = [];
		const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
		const events = createEventBus();
		events.on(SLASH_SUBAGENT_REQUEST_EVENT, (data) => {
			const requestId = (data as { requestId: string }).requestId;
			events.emit(SLASH_SUBAGENT_STARTED_EVENT, { requestId });
			events.emit(SLASH_SUBAGENT_RESPONSE_EVENT, {
				requestId,
				result: {
					content: [{ type: "text", text: "Subagent failed" }],
					details: { mode: "single", results: [] },
				},
				isError: true,
				errorText: "Subagent failed",
			});
		});

		const pi = {
			events,
			registerCommand(name: string, spec: { handler(args: string, ctx: unknown): Promise<void> }) {
				commands.set(name, spec);
			},
			registerShortcut() {},
			sendMessage(message: unknown) {
				sent.push(message);
			},
		};

		registerSlashCommands!(pi, createState(process.cwd()));
		await commands.get("run")!.handler("scout inspect this", createCommandContext());

		assert.equal(sent.length, 2);
		assert.equal((sent[0] as { content: string }).content, "inspect this");
		assert.deepEqual(sent[1], {
			customType: SLASH_RESULT_TYPE,
			content: "Subagent failed",
			display: false,
			details: {
				requestId: (sent[0] as { details: { requestId: string } }).details.requestId,
				result: {
					content: [{ type: "text", text: "Subagent failed" }],
					details: { mode: "single", results: [] },
				},
			},
		});
	});
});
