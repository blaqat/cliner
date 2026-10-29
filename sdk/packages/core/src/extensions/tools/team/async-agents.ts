import { createTool, type AgentTool, zodToJsonSchema } from "@cline/shared";
import { z } from "zod";

export interface AsyncAgentEntry {
	agentId: string;
	runtimeId?: string;
	threadId?: string;
	task: string;
	status: "running" | "done" | "failed" | "cancelled" | "ended (reloaded)";
	startedAt: number;
	endedAt?: number;
	lastResult?: string;
	pending: string[];
	notify?(): void;
	cancel(): void;
	resume(message: string): Promise<unknown>;
	completion?: Promise<unknown>;
}

/** Owned by a root session, including all of its detached descendants. */
export class AsyncAgentRegistry {
	onInput?: (entry: AsyncAgentEntry, message: string) => void;
	readonly agents = new Map<string, AsyncAgentEntry>();
	private sequence = 0;
	restore(
		records: Array<{
			agentId: string;
			task: string;
			startedAt: number;
			lastResult?: string;
			preview?: string;
		}>,
	) {
		for (const record of records) {
			this.sequence = Math.max(
				this.sequence,
				Number(record.agentId.slice(1)) || 0,
			);
			this.agents.set(record.agentId, {
				...record,
				lastResult: record.lastResult ?? record.preview,
				status: "ended (reloaded)",
				endedAt: Date.now(),
				pending: [],
				cancel() {},
				resume() {
					throw new Error(
						"Agent ended after extension reload. Spawn a new agent with the needed context.",
					);
				},
			});
		}
	}

	nextId(): string {
		return `a${++this.sequence}`;
	}
	snapshot() {
		return [...this.agents.values()].map(
			({
				agentId,
				runtimeId,
				threadId,
				task,
				status,
				startedAt,
				endedAt,
				lastResult,
			}) => ({
				agentId,
				runtimeId,
				threadId,
				task: task.slice(0, 200),
				status,
				startedAt,
				endedAt,
				ageSeconds: Math.floor((Date.now() - startedAt) / 1000),
				preview: lastResult?.slice(0, 500),
			}),
		);
	}
	dispose() {
		for (const entry of this.agents.values())
			if (entry.status === "running") entry.cancel();
	}
	tools(): AgentTool[] {
		const tool = (
			name: string,
			description: string,
			schema: z.ZodType,
			execute: AgentTool["execute"],
		): AgentTool =>
			createTool({
				name,
				timeoutMs: name === "wait_for_agents" ? 125000 : 30000,
				description,
				inputSchema: zodToJsonSchema(schema),
				execute: async (input, context) => execute(input, context),
			});
		const id = z.object({ agentId: z.string() });
		return [
			tool(
				"list_agents",
				"List this session's children, status, age and last result. Do not poll in a loop.",
				z.object({}),
				async () => ({ agents: this.snapshot() }),
			),
			tool(
				"cancel_agent",
				"Cancel a child by agentId. Parent Stop does not cancel children.",
				id,
				async (input) => {
					const entry = this.agents.get((input as { agentId: string }).agentId);
					if (!entry)
						return {
							error:
								"Unknown agent id. After reload, spawn a new agent with the needed context; live runtimes cannot be restored.",
						};
					entry.cancel();
					return { agentId: entry.agentId, status: entry.status };
				},
			),
			tool(
				"send_to_agent",
				"Send a user message at a running child's next iteration boundary, or continue a finished child's existing conversation. Returns immediately; results arrive as messages.",
				id.extend({ message: z.string() }),
				async (raw) => {
					const input = raw as { agentId: string; message: string };
					const entry = this.agents.get(input.agentId);
					if (
						!entry ||
						entry.status === "cancelled" ||
						entry.status === "ended (reloaded)"
					)
						return {
							error:
								"Unknown or cancelled agent. After reload, spawn a new agent with the needed context; live runtimes cannot be restored.",
						};
					this.onInput?.(entry, input.message);
					if (entry.status === "running") {
						entry.pending.push(`Parent: ${input.message}`);
						entry.notify?.();
					} else {
						try {
							entry.completion = entry.resume(`Parent: ${input.message}`);
						} catch (error) {
							return { error: String(error) };
						}
					}
					return { agentId: entry.agentId, status: entry.status };
				},
			),
			tool(
				"wait_for_agents",
				"Wait for selected children when you have no other work. Returns completed children at the deadline. Do not poll in a loop.",
				z.object({
					agentIds: z.array(z.string()).optional(),
					timeoutSeconds: z.number().min(0).max(120).optional(),
				}),
				async (raw) => {
					const input = raw as { agentIds?: string[]; timeoutSeconds?: number };
					const entries = [...this.agents.values()].filter(
						(e) => !input.agentIds || input.agentIds.includes(e.agentId),
					);
					let timer: ReturnType<typeof setTimeout> | undefined;
					try {
						await Promise.race([
							Promise.allSettled(entries.map((e) => e.completion)),
							new Promise((resolve) => {
								timer = setTimeout(
									resolve,
									(input.timeoutSeconds ?? 120) * 1000,
								);
							}),
						]);
					} finally {
						if (timer) clearTimeout(timer);
					}
					return {
						agents: this.snapshot().filter(
							(e) =>
								e.status !== "running" &&
								entries.some((selected) => selected.agentId === e.agentId),
						),
					};
				},
			),
		];
	}
}

export const agentControlTools = new WeakMap<AgentTool, AgentTool[]>();
