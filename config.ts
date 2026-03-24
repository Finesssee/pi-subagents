import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionConfig } from "./types.js";

function getUserConfigPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "subagent-config.json");
}

function getLegacyConfigPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "extensions", "subagent", "config.json");
}

function readConfigFile(filePath: string): ExtensionConfig {
	try {
		if (fs.existsSync(filePath)) {
			return JSON.parse(fs.readFileSync(filePath, "utf-8")) as ExtensionConfig;
		}
	} catch (error) {
		console.error(`Failed to load subagent config from '${filePath}':`, error);
	}
	return {};
}

export function getSubagentUserConfigPath(): string {
	return getUserConfigPath();
}

export function getSubagentLegacyConfigPath(): string {
	return getLegacyConfigPath();
}

export function loadPersistedSubagentConfig(): ExtensionConfig {
	return {
		...readConfigFile(getLegacyConfigPath()),
		...readConfigFile(getUserConfigPath()),
	};
}

export function loadSubagentConfig(): ExtensionConfig {
	const config = loadPersistedSubagentConfig();
	const syncBackendOverride = process.env.PI_SUBAGENT_SYNC_BACKEND;
	if (syncBackendOverride === "process" || syncBackendOverride === "tmux") {
		config.syncBackend = syncBackendOverride;
	}
	return config;
}

export function saveSubagentConfigPatch(patch: Partial<ExtensionConfig>): ExtensionConfig {
	const userConfigPath = getUserConfigPath();
	const next: ExtensionConfig = {
		...loadPersistedSubagentConfig(),
		...patch,
	};
	fs.mkdirSync(path.dirname(userConfigPath), { recursive: true });
	fs.writeFileSync(userConfigPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
	return next;
}
