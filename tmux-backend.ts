import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sanitizeSessionFragment(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "run";
}

export function buildTmuxSessionName(runId: string | undefined): string {
	const fragment = sanitizeSessionFragment(runId ?? `adhoc-${Date.now()}`);
	return `pi-subagents-${fragment}`;
}

export function isTmuxAvailable(): boolean {
	const probe = spawnSync("tmux", ["-V"], { stdio: "ignore" });
	return probe.status === 0;
}

type LaunchInTmuxInput = {
	runId?: string;
	index?: number;
	command: string;
	args: string[];
	cwd: string;
	env: Record<string, string | undefined>;
	tempDir?: string;
};

export type TmuxLaunch = {
	sessionName: string;
	outputPath: string;
	exitCodePath: string;
	target: string;
	tempDir: string;
};

function buildEnvPrefix(env: Record<string, string | undefined>): string {
	const entries = Object.entries(env).filter(([, value]) => value !== undefined);
	if (entries.length === 0) return "";
	return `env ${entries.map(([key, value]) => `${key}=${shellQuote(value!)}`).join(" ")} `;
}

function buildShellCommand(input: LaunchInTmuxInput, outputPath: string, exitCodePath: string): string {
	const command = [input.command, ...input.args].map(shellQuote).join(" ");
	return [
		`cd ${shellQuote(input.cwd)}`,
		`${buildEnvPrefix(input.env)}${command} > ${shellQuote(outputPath)} 2>&1`,
		`status=$?`,
		`printf '%s' "$status" > ${shellQuote(exitCodePath)}`,
		"exit $status",
	].join("; ");
}

function tmux(args: string[]): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync("tmux", args, { encoding: "utf-8" });
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

export function launchInTmux(input: LaunchInTmuxInput): TmuxLaunch {
	const sessionName = buildTmuxSessionName(input.runId);
	const tempDir = input.tempDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-tmux-"));
	const outputPath = path.join(tempDir, `tmux-output-${input.index ?? 0}.log`);
	const exitCodePath = path.join(tempDir, `tmux-exit-${input.index ?? 0}.code`);
	const shellCommand = buildShellCommand(input, outputPath, exitCodePath);
	const targetBase = `${sessionName}:subagents`;

	fs.mkdirSync(tempDir, { recursive: true });

	const hasSession = tmux(["has-session", "-t", sessionName]).status === 0;
	if (!hasSession) {
		const created = tmux(["new-session", "-d", "-s", sessionName, "-n", "subagents"]);
		if (created.status !== 0) {
			throw new Error((created.stderr || created.stdout || "Failed to create tmux session").trim());
		}
		const remain = tmux(["set-option", "-t", sessionName, "remain-on-exit", "on"]);
		if (remain.status !== 0) {
			throw new Error((remain.stderr || remain.stdout || "Failed to configure tmux session").trim());
		}
		const paneLookup = tmux(["list-panes", "-t", targetBase, "-F", "#{pane_id}"]);
		const paneTarget = paneLookup.stdout.trim().split("\n")[0]?.trim() || targetBase;
		const respawn = tmux(["respawn-pane", "-k", "-t", paneTarget, shellCommand]);
		if (respawn.status !== 0) {
			throw new Error((respawn.stderr || respawn.stdout || "Failed to start tmux pane").trim());
		}
		return { sessionName, outputPath, exitCodePath, target: paneTarget, tempDir };
	}

	const split = tmux(["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", targetBase]);
	if (split.status !== 0) {
		throw new Error((split.stderr || split.stdout || "Failed to open tmux pane").trim());
	}
	const paneTarget = split.stdout.trim() || "%1";
	const respawn = tmux(["respawn-pane", "-k", "-t", paneTarget, shellCommand]);
	if (respawn.status !== 0) {
		throw new Error((respawn.stderr || respawn.stdout || "Failed to start tmux pane").trim());
	}
	tmux(["select-layout", "-t", targetBase, "tiled"]);
	return { sessionName, outputPath, exitCodePath, target: paneTarget, tempDir };
}

export async function waitForTmuxExit(
	exitCodePath: string,
	signal?: AbortSignal,
	timeoutMs = 60 * 60 * 1000,
): Promise<number> {
	const startedAt = Date.now();
	while (true) {
		if (signal?.aborted) {
			throw new Error("Aborted");
		}
		try {
			const raw = fs.readFileSync(exitCodePath, "utf-8").trim();
			if (raw) {
				const parsed = Number.parseInt(raw, 10);
				return Number.isFinite(parsed) ? parsed : 1;
			}
		} catch {
			// Still running.
		}
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error("Timed out waiting for tmux-backed subagent to finish");
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

export function readIncrementalFile(
	filePath: string,
	offset: number,
): { chunk: string; nextOffset: number } {
	try {
		const buffer = fs.readFileSync(filePath);
		if (buffer.byteLength <= offset) {
			return { chunk: "", nextOffset: offset };
		}
		return {
			chunk: buffer.subarray(offset).toString("utf-8"),
			nextOffset: buffer.byteLength,
		};
	} catch {
		return { chunk: "", nextOffset: offset };
	}
}

export function tailFileText(filePath: string, maxBytes = 16 * 1024): string {
	try {
		const stats = fs.statSync(filePath);
		const start = Math.max(0, stats.size - maxBytes);
		const fd = fs.openSync(filePath, "r");
		try {
			const buffer = Buffer.alloc(stats.size - start);
			fs.readSync(fd, buffer, 0, buffer.length, start);
			return buffer.toString("utf-8").trim();
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return "";
	}
}

export function killTmuxSession(runId?: string): void {
	const sessionName = buildTmuxSessionName(runId);
	tmux(["kill-session", "-t", sessionName]);
}

export function getTmuxSocketDir(): string {
	return path.join(os.tmpdir(), "pi-subagents-tmux");
}
