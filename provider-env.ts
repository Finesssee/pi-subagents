const DROID_AUTO_LEVELS = new Set(["low", "medium", "high"]);

function normalizeDroidAutoLevel(value: string | undefined): "low" | "medium" | "high" | undefined {
	const trimmed = value?.trim().toLowerCase();
	if (trimmed && DROID_AUTO_LEVELS.has(trimmed)) {
		return trimmed as "low" | "medium" | "high";
	}
	return undefined;
}

export function resolveSubagentDroidAutoOverride(
	agentName: string,
	env: NodeJS.ProcessEnv = process.env,
): "low" | "medium" | "high" | undefined {
	const normalizedAgent = agentName.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_");
	const perAgent = normalizeDroidAutoLevel(env[`PI_SUBAGENT_${normalizedAgent}_DROID_AUTO`]);
	if (perAgent) return perAgent;

	const shared = normalizeDroidAutoLevel(env.PI_SUBAGENT_DROID_AUTO);
	if (shared) return shared;

	return undefined;
}

export function resolveSubagentProviderEnv(
	agentName: string,
	env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const defaultDroidAuto = agentName.trim().toLowerCase() === "worker" ? "high" : "medium";
	return {
		PI_DROID_AUTO: resolveSubagentDroidAutoOverride(agentName, env) || defaultDroidAuto,
	};
}
