import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MockPi } from "./helpers.ts";
import {
	createMockPi,
	createTempDir,
	makeAgentConfigs,
	removeTempDir,
	tryImport,
} from "./helpers.ts";

const execution = await tryImport<any>("./execution.ts");
const tmuxBackend = await tryImport<any>("./tmux-backend.ts");
const available = !!(execution && tmuxBackend);
const runSync = execution?.runSync;
const getFinalOutput = (await tryImport<any>("./utils.ts"))?.getFinalOutput;

function writeFakeTmux(binDir: string): void {
	const scriptPath = path.join(binDir, "tmux");
	const script = `#!/usr/bin/env bash
set -euo pipefail
state_dir="\${FAKE_TMUX_STATE_DIR:?}"
mkdir -p "$state_dir"
printf '%s\\n' "$*" >> "$state_dir/commands.log"
cmd="\${1:-}"
if [[ "$cmd" == "-V" ]]; then
  echo "tmux 3.4"
  exit 0
fi
shift || true
case "$cmd" in
  has-session)
    if [[ "\${1:-}" == "-t" && -f "$state_dir/session-\${2}.exists" ]]; then
      exit 0
    fi
    exit 1
    ;;
  new-session)
    session=""
    while (($#)); do
      case "$1" in
        -d) shift ;;
        -s) session="$2"; shift 2 ;;
        -n) shift 2 ;;
        *) shift ;;
      esac
    done
    touch "$state_dir/session-$session.exists"
    exit 0
    ;;
  set-option)
    exit 0
    ;;
  split-window)
    pane_id="%1"
    while (($#)); do
      case "$1" in
        -d|-P) shift ;;
        -F) shift 2 ;;
        -t) shift 2 ;;
        *) shift ;;
      esac
    done
    echo "$pane_id"
    exit 0
    ;;
  list-panes)
    echo "%1"
    exit 0
    ;;
  respawn-pane)
    shell_cmd=""
    while (($#)); do
      case "$1" in
        -k) shift ;;
        -t) shift 2 ;;
        *) shell_cmd="$1"; shift ;;
      esac
    done
    bash -lc "$shell_cmd" &
    exit 0
    ;;
  select-layout) exit 0 ;;
  kill-session)
    exit 0
    ;;
  *)
    echo "unsupported fake tmux command: $cmd" >&2
    exit 1
    ;;
esac
`;
	fs.writeFileSync(scriptPath, script, { mode: 0o755 });
}

describe("tmux-backed sync execution", { skip: !available ? "pi packages not available" : undefined }, () => {
	let tempDir: string;
	let mockPi: MockPi;
	let fakeTmuxDir: string;
	let fakeTmuxStateDir: string;
	let originalPath: string | undefined;
	let originalFakeState: string | undefined;

	before(() => {
		mockPi = createMockPi();
		mockPi.install();
		originalPath = process.env.PATH;
		originalFakeState = process.env.FAKE_TMUX_STATE_DIR;
	});

	after(() => {
		mockPi.uninstall();
		process.env.PATH = originalPath;
		if (originalFakeState === undefined) delete process.env.FAKE_TMUX_STATE_DIR;
		else process.env.FAKE_TMUX_STATE_DIR = originalFakeState;
	});

	beforeEach(() => {
		tempDir = createTempDir("pi-subagents-tmux-");
		fakeTmuxDir = path.join(tempDir, "bin");
		fakeTmuxStateDir = path.join(tempDir, "state");
		fs.mkdirSync(fakeTmuxDir, { recursive: true });
		writeFakeTmux(fakeTmuxDir);
		process.env.FAKE_TMUX_STATE_DIR = fakeTmuxStateDir;
		process.env.PATH = `${fakeTmuxDir}:${originalPath ?? ""}`;
		mockPi.reset();
	});

	afterEach(() => {
		removeTempDir(tempDir);
	});

	it("runs a sync subagent through tmux and captures output", async () => {
		mockPi.onCall({ output: "Hello from tmux backend" });
		const agents = makeAgentConfigs(["echo"]);

		const result = await runSync(tempDir, agents, "echo", "Say hello", {
			runId: "tmux-demo",
			executionBackend: "tmux",
		});

		assert.equal(result.exitCode, 0);
		assert.equal(getFinalOutput(result.messages), "Hello from tmux backend");
		const log = fs.readFileSync(path.join(fakeTmuxStateDir, "commands.log"), "utf-8");
		assert.match(log, /new-session/);
	});

	it("reuses the same tmux session for later tasks in the same run", async () => {
		mockPi.onCall({ output: "First" });
		mockPi.onCall({ output: "Second" });
		const agents = makeAgentConfigs(["worker"]);

		const first = await runSync(tempDir, agents, "worker", "Task one", {
			runId: "shared-run",
			index: 0,
			executionBackend: "tmux",
		});
		const second = await runSync(tempDir, agents, "worker", "Task two", {
			runId: "shared-run",
			index: 1,
			executionBackend: "tmux",
		});

		assert.equal(first.exitCode, 0);
		assert.equal(second.exitCode, 0);
		const log = fs.readFileSync(path.join(fakeTmuxStateDir, "commands.log"), "utf-8");
		assert.match(log, /new-session/);
		assert.match(log, /split-window/);
	});

	it("builds stable tmux session names from run ids", () => {
		assert.equal(tmuxBackend.buildTmuxSessionName("orch_123/abc"), "pi-subagents-orch_123-abc");
	});
});
