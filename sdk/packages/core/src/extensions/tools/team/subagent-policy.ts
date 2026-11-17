import type { AgentTool } from "@cline/shared";

export const SUBAGENT_SPAWN_ERROR =
	"Subagents can't start other subagents. Do the work yourself, or message_parent to ask the parent to start one.";

export function isParentAgentTool(name: string): boolean {
	return (
		[
			"spawn_agent",
			"send_to_agent",
			"cancel_agent",
			"list_agents",
			"wait_for_agents",
			"team_spawn_teammate",
			"team_run_task",
		].includes(name) || name.startsWith("subagent_")
	);
}

export function workToolsOnly(tools: AgentTool[]): AgentTool[] {
	return tools.filter((tool) => !isParentAgentTool(tool.name));
}

/** Asides have parentTaskId only. Agent ownership survives reloads and history resumes. */
export function subagentParent(record?: {
	parentAgentId?: string | null;
	parentSessionId?: string | null;
	metadata?: Record<string, unknown> | null;
}): string | undefined {
	const metadata = record?.metadata;
	const parent =
		record?.parentAgentId ||
		record?.parentSessionId ||
		metadata?.parentAgentId ||
		metadata?.runtimeOwnerTaskId ||
		(metadata?.isSubagent ? metadata?.parentTaskId || "parent" : undefined);
	return typeof parent === "string" && parent ? parent : undefined;
}
