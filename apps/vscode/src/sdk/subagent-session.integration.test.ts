/** Real Core, parent/child runtimes and host projection; only inference and the VS Code shell are faked. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ApiStreamChunk, registerHandler } from "@cline/llms"
import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import type { ExtensionState } from "@shared/ExtensionMessage"
import { describe, expect, it, vi } from "vitest"
import { StateManager } from "@/core/storage/StateManager"
import { ClineCore, type CoreSessionEvent } from "../../../../sdk/packages/core/dist/index.js"
import { buildStartSessionInput } from "./cline-session-factory"
import { MessageTranslatorState } from "./message-translator"
import { Controller } from "./SdkController"
import { SdkMessageCoordinator } from "./sdk-message-coordinator"
import { SdkSessionLifecycle } from "./sdk-session-lifecycle"
import { SdkTaskControlCoordinator } from "./sdk-task-control-coordinator"
import { SdkTaskHistory } from "./sdk-task-history"
import type { SdkSessionHost } from "./session-host"

// Base state is the VS Code shell, not the session/translator/interaction code under test.
vi.mock("@core/controller/state/getStateToPostToWebview", () => ({
	getStateToPostToWebview: async ({ task }: { task?: { messageStateHandler: { getClineMessages(): unknown[] } } }) => ({
		taskHistory: [],
		clineMessages: task?.messageStateHandler.getClineMessages().slice() ?? [],
		mode: "act",
	}),
}))

const call = (name: string, id: string, input: Record<string, unknown>): ApiStreamChunk => ({
	type: "tool_calls",
	id,
	tool_call: { call_id: id, function: { name, arguments: input } },
})

describe("subagents through the real parent session", () => {
	it.each([
		{ mode: "act" as const, autoApprove: false },
		{ mode: "plan" as const, autoApprove: false },
		{ mode: "act" as const, autoApprove: true },
		{ mode: "plan" as const, autoApprove: true },
	])("projects concurrent progress and decisions in $mode, MCP auto-approve=$autoApprove", async ({ mode, autoApprove }) => {
		const dir = mkdtempSync(join(tmpdir(), "cline-child-repro-"))
		const oldData = process.env.CLINE_DATA_DIR
		process.env.CLINE_DATA_DIR = join(dir, "data")
		writeFileSync(join(dir, "fixture.txt"), "fixture content")
		const finish = Promise.withResolvers<void>()
		const questions = Promise.withResolvers<void>()
		const settings = {
			...DEFAULT_AUTO_APPROVAL_SETTINGS,
			actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, readFiles: true, useMcp: autoApprove },
		}
		const mcpHub = { getServers: () => [{ name: "fixture", tools: [{ name: "change" }] }] } as never
		const invoked: string[] = []
		const events: CoreSessionEvent[] = []
		let core: ClineCore | undefined
		let controller: any
		try {
			registerHandler("child-repro", () => ({
				getMessages: (_system, messages) => messages,
				getModel: () => ({
					id: "scripted",
					info: { id: "scripted", contextWindow: 100_000, maxTokens: 1000, capabilities: ["tools"] as const },
				}),
				async *createMessage(system, messages) {
					const turns = messages.filter((message) => message.role === "assistant").length
					const firstTurn = turns === 0
					const parent = system.includes("REPRO_PARENT")
					const name = parent
						? "parent"
						: ["child-a", "child-b", "child-c"].find((name) => JSON.stringify(messages).includes(name))!
					if (firstTurn) {
						yield { type: "text", id: name, text: `Streaming ${name}` } as const
						if (parent) {
							for (const child of ["child-a", "child-b", "child-c"])
								yield call("spawn_agent", `spawn-${child}`, {
									systemPrompt: "Investigate",
									task: child,
									access: "read",
								})
						} else {
							yield call("fixture__change", `change-${name}`, { name })
							yield call("read_files", `read-${name}`, { paths: [join(dir, "fixture.txt")] })
						}
					} else if (!parent && turns === 1) {
						yield { type: "text", id: name, text: `Read complete ${name}` } as const
						await questions.promise
						yield call("ask_question", `question-${name}`, {
							question: `Which option for ${name}?`,
							options: ["One", "Two"],
						})
					} else if (!parent) {
						await finish.promise
						yield { type: "text", id: name, text: `Report ${name}` } as const
					} else yield { type: "text", id: name, text: "All children finished" } as const
					yield { type: "usage", id: name, inputTokens: 100, outputTokens: 20, totalCost: 0.002 } as const
					yield { type: "done", id: name, success: true } as const
				},
			}))
			controller = Object.create(Controller.prototype)
			Object.assign(controller, {
				taskSessions: new Map(),
				subagentThreads: new Map(),
				lastKnownWorkspaceRoot: dir,
				messageTranslatorState: new MessageTranslatorState(),
				foregroundCommands: { isRunning: false },
				diffEdits: { openForApproval: async () => {}, discardPreview: async () => {} },
				stateManager: {
					getGlobalSettingsKey: (key: string) => (key === "autoApprovalSettings" ? settings : mode),
					getRemoteConfigSettings: () => ({}),
					setGlobalState: () => {},
				},
				ensureWorkspaceManager: async () => undefined,
				getWorkspaceRoot: async () => dir,
				postStateToWebview: async () => {},
				restoreTaskApiSelection: () => {},
				sessionEventStream: new SdkMessageCoordinator({ getTask: () => controller.task }),
			})
			vi.spyOn(StateManager, "get").mockReturnValue(controller.stateManager)
			const onEvent = (event: CoreSessionEvent) => {
				events.push(event)
				if (!controller.handleSubagentEvent(event) && controller.sessions.getSession(event.payload.sessionId))
					void controller.getTaskSessionContext(event.payload.sessionId).events.handleSessionEvent(event)
			}
			core = await ClineCore.create({
				backendMode: "local",
				clientName: "child-repro",
				distinctId: "test",
				toolPolicies: { read_files: { autoApprove: false }, fixture__change: { autoApprove: false } },
				capabilities: {
					requestToolApproval: (request) =>
						controller.getTaskSessionContext(request.sessionId).interactions.handleRequestToolApproval(request),
					toolExecutors: {
						askQuestion: (question, options, context) =>
							controller
								.getTaskSessionContext(startResult.sessionId)
								.interactions.handleAskQuestion(question, options, context),
					},
				},
			})
			const host = core as unknown as SdkSessionHost
			const sessions = new SdkSessionLifecycle({
				mcpHub,
				requestToolApproval: async () => ({ approved: false }),
				askQuestion: async () => "",
				onSessionEvent: onEvent,
				onSendComplete: () => {},
				onSendError: () => {},
			})
			// Use Core directly as the transport. Session lifecycle, input factory,
			// runtime, persistence, event coordinators and controller are production code.
			Reflect.set(sessions, "sharedHost", host)
			controller.sessions = sessions
			controller.taskHistory = new SdkTaskHistory({ sessions, mcpHub })
			const input = buildStartSessionInput(
				{
					providerId: "child-repro",
					modelId: "scripted",
					apiKey: "fake",
					sessionId: `repro-${mode}`,
					cwd: dir,
					enableTools: true,
					enableSpawnAgent: true,
					enableAgentTeams: false,
					subagentSettings: { maxConcurrent: 3 },
					systemPrompt: "REPRO_PARENT",
					extraTools: [
						{
							name: "fixture__change",
							description: "Change fixture",
							inputSchema: { type: "object" },
							metadata: {
								mcp: { serverName: "fixture", toolName: "change", annotations: { readOnlyHint: false } },
							},
							execute: async (input: any) => {
								invoked.push(input.name)
								return { changed: input.name }
							},
						},
					],
				},
				{ cwd: dir, mode },
			)
			const { startResult } = await sessions.startNewSession(input)
			controller.task = controller.getTaskSessionContext(startResult.sessionId).task
			controller.taskControl = new SdkTaskControlCoordinator({
				sessions,
				taskHistory: controller.taskHistory,
				messages: controller.messages,
				interactions: controller.interactions,
				getTask: () => controller.task,
				setTask: (task) => {
					controller.task = task
				},
				onAskResponse: (...args) => controller.askResponse(...args),
				resetMessageTranslator: () => controller.resetMessageTranslatorAndFence(),
				clearTaskSettings: async () => {},
				setTurnPhase: (phase) => controller.turnStateTracker.set(phase),
				rebuilds: { runTaskTransition: async (fn) => fn() },
				postStateToWebview: async () => {},
				getLiveTaskItem: (id) => controller.subagentThreads.get(id) ?? controller.liveTaskHistoryItem(id),
				focusLiveTask: (id) => {
					const context = controller.taskSessions.get(id)
					if (!context) return false
					controller.task = context.task
					return true
				},
			})
			const running = core.send({ sessionId: startResult.sessionId, prompt: "Spawn three children" })
			await vi.waitFor(() => expect(controller.subagentThreads.size).toBe(3))
			if (!autoApprove) await vi.waitFor(() => expect(controller.interactions.getPendingDecision()).toBeDefined())
			else await vi.waitFor(() => expect(invoked).toHaveLength(3))
			const state = () => controller.getStateToPostToWebview() as Promise<ExtensionState>
			const parentState = await state()
			expect(parentState.taskHistory.filter((item) => item.isSubagent)).toHaveLength(3)
			expect(parentState.pendingSubagentDecisions).toHaveLength(autoApprove ? 0 : 1)
			if (!autoApprove) expect(parentState.turnState?.phase).toBe("awaiting_approval")
			const children = [...controller.subagentThreads.values()]
			for (const child of children) {
				expect(parentState.sessionStatuses[child.id]).toBe(autoApprove ? "running" : "waiting")
				await controller.showTaskWithId(child.id)
				const childState = await state()
				expect(childState.currentTaskItem?.id).toBe(child.id)
				expect(childState.clineMessages.some((message) => message.text?.includes(`Streaming ${child.task}`))).toBe(true)
				expect(childState.currentTaskItem?.tokensIn).toBe(100)
			}
			await controller.showTaskWithId(startResult.sessionId)
			for (let index = 0; !autoApprove && index < 3; index++) {
				await vi.waitFor(() => expect(controller.interactions.getPendingDecision()).toBeDefined())
				const pending = (await state()).pendingSubagentDecisions![0]
				expect(pending.message.subagentName).toBe(pending.name)
				await controller.task.handleWebviewAskResponse(
					"yesButtonClicked",
					undefined,
					undefined,
					undefined,
					pending.message.decisionId,
				)
			}
			await vi.waitFor(() => expect(invoked).toHaveLength(3))
			await vi.waitFor(() => {
				for (const child of children)
					expect(
						controller.taskSessions
							.get(child.id)
							.task.messageStateHandler.getClineMessages()
							.some((message: any) => message.text?.includes(`Read complete ${child.task}`)),
					).toBe(true)
			})
			for (const child of children) {
				await controller.showTaskWithId(child.id)
				const childState = await state()
				expect(
					childState.clineMessages.some((message) => message.say === "tool" || message.say === "mcp_server_response"),
				).toBe(true)
				expect(childState.currentTaskItem?.subagentToolCalls).toBe(2)
				expect(childState.currentTaskItem?.totalCost).toBeGreaterThan(0)
			}
			await controller.showTaskWithId(startResult.sessionId)
			questions.resolve()
			await vi.waitFor(async () => expect((await state()).pendingSubagentDecisions).toHaveLength(3))
			const pendingQuestions = (await state()).pendingSubagentDecisions!
			// Answer out of order from parent and child views without crossing resolvers.
			for (const index of [1, 0, 2]) {
				const pending = pendingQuestions[index]
				if (index === 2) await controller.showTaskWithId(pending.taskId)
				await controller.task.handleWebviewAskResponse(
					"messageResponse",
					`Answer ${pending.name}`,
					undefined,
					undefined,
					pending.message.decisionId,
				)
			}
			finish.resolve()
			await running
			await controller.showTaskWithId(startResult.sessionId)
			const done = await state()
			expect(done.pendingSubagentDecisions).toEqual([])
			for (const child of children) {
				expect(done.sessionStatuses[child.id]).toBe("done")
				expect(done.taskHistory.find((item) => item.id === child.id)?.tokensIn).toBe(300)
				await controller.showTaskWithId(child.id)
				expect((await state()).clineMessages.some((message) => message.text?.includes(`Report ${child.task}`))).toBe(true)
			}
			for (const child of children) {
				const saved = await controller.taskHistory.findHistoryItem(child.id)
				expect(saved).toMatchObject({ tokensIn: 300, tokensOut: 60, totalCost: 0.006, subagentToolCalls: 3 })
			}
			expect(done.subagentCounts[startResult.sessionId]).toEqual({ total: 3, live: 0 })
			expect(events.filter((event) => event.type === "agent_event" && event.payload.event.parentAgentId)).not.toHaveLength(
				0,
			)
		} finally {
			finish.resolve()
			questions.resolve()
			vi.restoreAllMocks()
			for (const context of controller?.taskSessions?.values() ?? []) context.interactions.clearPending("Test cleanup")
			await core?.dispose()
			if (oldData === undefined) delete process.env.CLINE_DATA_DIR
			else process.env.CLINE_DATA_DIR = oldData
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
