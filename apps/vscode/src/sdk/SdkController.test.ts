import type { TaskApiSelection } from "@shared/api-profiles"
import { describe, expect, it, vi } from "vitest"
import { telemetryService } from "@/services/telemetry"
import { isClineManagedProvider } from "@/shared/utils/cline"
import { LocalRuntimeHost } from "../../../../sdk/packages/core/dist/index.js"
import { MessageTranslatorState } from "./message-translator"
import { Controller as SdkController } from "./SdkController"
import type { SdkInteractionCoordinator } from "./sdk-interaction-coordinator"
import type { SdkMessageCoordinator } from "./sdk-message-coordinator"
import { SdkSessionLifecycle } from "./sdk-session-lifecycle"
import { SdkTaskControlCoordinator } from "./sdk-task-control-coordinator"
import { createTaskProxy, type TaskProxy } from "./task-proxy"
import { resolveWorkspaceManagerPaths, resolveWorkspaceRootPath } from "./workspace-root"

describe("isClineManagedProvider", () => {
	it("treats both Cline account providers as Cline providers", () => {
		expect(isClineManagedProvider("cline")).toBe(true)
		expect(isClineManagedProvider("cline-pass")).toBe(true)
		expect(isClineManagedProvider("anthropic")).toBe(false)
		expect(isClineManagedProvider(undefined)).toBe(false)
	})
})

describe("resolveWorkspaceRootPath", () => {
	it("uses the first non-empty workspace path when available", () => {
		expect(resolveWorkspaceRootPath(["", "/workspace"], "/Users/tester/Desktop")).toBe("/workspace")
	})

	it("falls back to Desktop when no workspace folder is open", () => {
		expect(resolveWorkspaceRootPath([], "/Users/tester/Desktop")).toBe("/Users/tester/Desktop")
	})
})

vi.mock("@/services/telemetry", () => ({
	telemetryService: {
		captureRemoteConfigSessionGate: vi.fn(),
	},
}))

const { buildBaseStateMock } = vi.hoisted(() => ({
	buildBaseStateMock: vi.fn(async () => ({ taskHistory: [] })),
}))
vi.mock("@core/controller/state/getStateToPostToWebview", () => ({
	getStateToPostToWebview: buildBaseStateMock,
}))

describe("SDK remote-config coordination", () => {
	it("posts the current remote-config revision to the webview", async () => {
		const controller = {
			stateManager: {
				getGlobalSettingsKey: () => undefined,
				getRemoteConfigSettings: () => ({}),
				setGlobalState: vi.fn(),
			},
			backgroundCommandRunning: false,
			backgroundCommandTaskId: undefined,
			foregroundCommands: { isRunning: false },
			isRemoteConfigAvailable: true,
			currentRemoteConfigRevision: 7,
			ensureWorkspaceManager: async () => undefined,
			taskHistory: { listHistory: async () => [] },
			sessions: { assertTaskAvailable: vi.fn(), getActiveSession: () => undefined },
			turnStateTracker: { get: () => undefined },
			messageTranslatorState: { getMinter: () => ({ epoch: 1, nextSeq: () => 1 }) },
		}

		await SdkController.prototype.getStateToPostToWebview.call(controller as never)

		expect(buildBaseStateMock).toHaveBeenCalledWith(
			expect.objectContaining({ isRemoteConfigAvailable: true, currentRemoteConfigRevision: 7 }),
		)
	})

	it("rebuilds the snapshot when the epoch moves while the state is being built", async () => {
		buildBaseStateMock.mockClear()
		const minter = { epoch: 1, nextSeq: () => 1 }
		const controller = {
			stateManager: {
				getGlobalSettingsKey: () => undefined,
				getRemoteConfigSettings: () => ({}),
				setGlobalState: vi.fn(),
			},
			backgroundCommandRunning: false,
			backgroundCommandTaskId: undefined,
			foregroundCommands: { isRunning: false },
			isRemoteConfigAvailable: false,
			currentRemoteConfigRevision: undefined,
			ensureWorkspaceManager: async () => undefined,
			taskHistory: {
				listHistory: async () => {
					// A conversation boundary (follow-up on an idle session) bumps the
					// epoch while this snapshot's transcript copy is already taken.
					minter.epoch = 2
					return []
				},
			},
			sessions: { assertTaskAvailable: vi.fn(), getActiveSession: () => undefined },
			turnStateTracker: { get: () => undefined },
			messageTranslatorState: { getMinter: () => minter },
			getStateToPostToWebview: SdkController.prototype.getStateToPostToWebview,
		}

		const state = await SdkController.prototype.getStateToPostToWebview.call(controller as never)

		expect(buildBaseStateMock).toHaveBeenCalledTimes(2)
		expect(state.epoch).toBe(2)
	})

	it("keys refreshes by the current user and organization", async () => {
		const refresh = vi.fn().mockResolvedValue(true)
		const controller = {
			authService: {
				getInfo: () => ({ user: { uid: "user-1" } }),
				getActiveOrganizationId: () => "org-1",
			},
			remoteConfigRefreshCoordinator: { refresh },
		}

		await SdkController.prototype.refreshRemoteConfig.call(controller as never)

		expect(refresh).toHaveBeenCalledWith("user-1:org-1", {})
	})

	it("uses a stable signed-out identity so startup refresh can settle", async () => {
		const refresh = vi.fn().mockResolvedValue(true)
		const controller = {
			authService: {
				getInfo: () => ({}),
				getActiveOrganizationId: () => null,
			},
			remoteConfigRefreshCoordinator: { refresh },
		}

		await SdkController.prototype.refreshRemoteConfig.call(controller as never)

		expect(refresh).toHaveBeenCalledWith("signed-out:no-org", {})
	})

	it("refreshes remote config after login before posting authenticated state", async () => {
		const events: string[] = []
		const controller = {
			authService: { handleAuthCallback: vi.fn(async () => events.push("auth")) },
			refreshRemoteConfig: vi.fn(async () => {
				events.push("refresh")
				return true
			}),
			postStateToWebview: vi.fn(async () => events.push("post")),
		}

		await SdkController.prototype.handleAuthCallback.call(controller as never, "token", "cline")

		expect(events).toEqual(["auth", "refresh", "post"])
	})

	it("rematerializes policy and ends the active session after a managed toggle", async () => {
		const events: string[] = []
		const controller = {
			refreshRemoteConfig: vi.fn(async () => {
				events.push("refresh")
				return true
			}),
			sessions: {
				assertTaskAvailable: vi.fn(),
				endActiveSession: vi.fn(async () => {
					events.push("end")
				}),
			},
			postStateToWebview: vi.fn(async () => events.push("post")),
		}

		await SdkController.prototype.rematerializeRemoteConfig.call(controller as never)

		expect(events).toEqual(["refresh", "end", "post"])
		expect(controller.sessions.endActiveSession).toHaveBeenCalledWith("remoteConfigToggle", { awaitStop: true })
	})

	it("allows the current organization to start with its last known-good policy after a transient failure", async () => {
		const controller = {
			waitForInitialRemoteConfig: vi.fn().mockResolvedValue(undefined),
			refreshRemoteConfig: vi.fn().mockResolvedValue(false),
			authService: { getActiveOrganizationId: () => "org-current" },
			remoteConfigBundle: { metadata: { organizationId: "org-current" } },
		}

		await expect(
			SdkController.prototype["ensureRemoteConfigForSessionStart"].call(controller as never),
		).resolves.toBeUndefined()
		expect(telemetryService.captureRemoteConfigSessionGate).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "last_known_good", managed: true }),
		)
	})

	it("does not block session start for users without an active organization when refresh fails", async () => {
		const controller = {
			waitForInitialRemoteConfig: vi.fn().mockResolvedValue(undefined),
			refreshRemoteConfig: vi.fn().mockResolvedValue(false),
			authService: { getActiveOrganizationId: () => null },
			stateManager: { getGlobalStateKey: () => undefined },
			remoteConfigBundle: undefined,
		}

		await expect(
			SdkController.prototype["ensureRemoteConfigForSessionStart"].call(controller as never),
		).resolves.toBeUndefined()
		expect(telemetryService.captureRemoteConfigSessionGate).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "unmanaged", managed: false }),
		)
	})

	it("does not block unmanaged session start when the refresh rejects instead of returning false", async () => {
		const controller = {
			waitForInitialRemoteConfig: vi.fn().mockResolvedValue(undefined),
			refreshRemoteConfig: vi.fn().mockRejectedValue(new Error("EACCES: permission denied")),
			authService: { getActiveOrganizationId: () => null },
			stateManager: { getGlobalStateKey: () => undefined },
			remoteConfigBundle: undefined,
		}

		await expect(
			SdkController.prototype["ensureRemoteConfigForSessionStart"].call(controller as never),
		).resolves.toBeUndefined()
		expect(telemetryService.captureRemoteConfigSessionGate).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "unmanaged", managed: false }),
		)
	})

	it("blocks session start when the install was managed but the identity cannot be resolved", async () => {
		const controller = {
			waitForInitialRemoteConfig: vi.fn().mockResolvedValue(undefined),
			refreshRemoteConfig: vi.fn().mockResolvedValue(false),
			authService: { getActiveOrganizationId: () => null },
			stateManager: { getGlobalStateKey: () => "org-previous" },
			remoteConfigBundle: undefined,
		}

		await expect(SdkController.prototype["ensureRemoteConfigForSessionStart"].call(controller as never)).rejects.toThrow(
			"Could not verify organization policy",
		)
		expect(telemetryService.captureRemoteConfigSessionGate).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "blocked", managed: true }),
		)
	})

	it("blocks session start when current organization policy cannot be verified", async () => {
		const controller = {
			waitForInitialRemoteConfig: vi.fn().mockResolvedValue(undefined),
			refreshRemoteConfig: vi.fn().mockResolvedValue(false),
			authService: { getActiveOrganizationId: () => "org-new" },
			remoteConfigBundle: { metadata: { organizationId: "org-old" } },
		}

		await expect(SdkController.prototype["ensureRemoteConfigForSessionStart"].call(controller as never)).rejects.toThrow(
			"Could not verify organization policy",
		)
		expect(telemetryService.captureRemoteConfigSessionGate).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "blocked", managed: true }),
		)
	})

	it("does not enter task startup until initial remote config is ready", async () => {
		let finishPolicyCheck!: () => void
		const policyReady = new Promise<void>((resolve) => {
			finishPolicyCheck = resolve
		})
		const events: string[] = []
		const initTask = vi.fn(async () => {
			events.push("task")
			return "task-id"
		})
		const controller = {
			waitForInitialRemoteConfig: vi.fn(async () => {
				await policyReady
				events.push("policy")
			}),
			turnStateTracker: { set: vi.fn() },
			messageTranslatorState: { clearTurnOutcome: vi.fn() },
			taskStart: { initTask },
		}

		const taskPromise = SdkController.prototype.initTask.call(controller as never, "start immediately")
		await Promise.resolve()
		expect(initTask).not.toHaveBeenCalled()
		expect(controller.turnStateTracker.set).not.toHaveBeenCalled()

		finishPolicyCheck()
		const taskId = await taskPromise

		expect(taskId).toBe("task-id")
		expect(events).toEqual(["policy", "task"])
		expect(initTask).toHaveBeenCalledWith("start immediately", undefined, undefined, undefined, undefined)
	})

	describe("after a Cline sign-in error offers to retry a prompt", () => {
		function controllerShowingSignInError(options: { existingTask?: boolean } = {}) {
			const controller = {
				task: undefined as TaskProxy | undefined,
				turnStateTracker: { set: vi.fn(), get: () => ({ phase: "error" }) },
				messageTranslatorState: { clearTurnOutcome: vi.fn() },
				messages: { appendAndEmit: vi.fn() },
				sessions: { assertTaskAvailable: vi.fn(), getActiveSession: () => undefined },
				postStateToWebview: vi.fn(async () => {}),
				initTask: vi.fn(async () => "task-id"),
				followups: { askResponse: vi.fn(async () => {}) },
				taskHistory: { markTaskActive: vi.fn(async () => {}) },
				cancelTask: vi.fn(async () => {}),
				askResponse(prompt?: string, images?: string[], files?: string[]) {
					return SdkController.prototype.askResponse.call(controller as never, prompt, images, files)
				},
			}
			const openTask = (taskId: string) => {
				controller.task = createTaskProxy(taskId, controller.askResponse, controller.cancelTask)
				return controller.task
			}
			if (options.existingTask) {
				openTask("existing-task")
			}
			SdkController.prototype["emitClineAuthError"].call(controller as never, "original prompt")
			const errorTask = controller.task
			if (!errorTask) {
				throw new Error("The sign-in error did not leave a task to answer")
			}
			return { controller, errorTask, openTask }
		}

		it("restarts a new task with the original prompt when Retry is clicked", async () => {
			const { controller, errorTask } = controllerShowingSignInError()
			await errorTask.handleWebviewAskResponse("yesButtonClicked")
			expect(controller.initTask).toHaveBeenCalledWith("original prompt", undefined, undefined)
			expect(controller.followups.askResponse).not.toHaveBeenCalled()
		})

		it("restarts a new task with a revised prompt submitted from the composer", async () => {
			const { controller, errorTask } = controllerShowingSignInError()
			await errorTask.handleWebviewAskResponse("messageResponse", "revised prompt", ["img"])
			expect(controller.initTask).toHaveBeenCalledWith("revised prompt", ["img"], undefined)
			expect(controller.followups.askResponse).not.toHaveBeenCalled()
		})

		it("keeps the original prompt when the revised submission has attachments but no text", async () => {
			const { controller, errorTask } = controllerShowingSignInError()
			await errorTask.handleWebviewAskResponse("messageResponse", "  ", ["img"])
			expect(controller.initTask).toHaveBeenCalledWith("original prompt", ["img"], undefined)
		})

		it("continues an existing conversation with a message submitted from the composer", async () => {
			const { controller, errorTask } = controllerShowingSignInError({ existingTask: true })
			await errorTask.handleWebviewAskResponse("messageResponse", "follow-up")
			expect(controller.initTask).not.toHaveBeenCalled()
			expect(controller.task).toBe(errorTask)
			expect(controller.followups.askResponse).toHaveBeenCalledWith(
				"follow-up",
				undefined,
				undefined,
				"messageResponse",
				"error",
			)

			// The follow-up answered the error, so a later approval continues the conversation.
			await errorTask.handleWebviewAskResponse("yesButtonClicked")
			expect(controller.initTask).not.toHaveBeenCalled()
		})

		it("does not restart the failed prompt from a task opened afterwards", async () => {
			const { controller, openTask } = controllerShowingSignInError()
			const historyTask = openTask("history-task")
			await historyTask.handleWebviewAskResponse("yesButtonClicked", "resume here")
			expect(controller.initTask).not.toHaveBeenCalled()
			expect(controller.followups.askResponse).toHaveBeenCalledWith(
				"resume here",
				undefined,
				undefined,
				"yesButtonClicked",
				"error",
			)
		})
	})

	it("lists a live background session in taskHistory before its record persists", async () => {
		const controller = Object.create(SdkController.prototype)
		const bgTask = createTaskProxy("bg-1", vi.fn(), vi.fn())
		bgTask.messageStateHandler.addMessages([{ ts: 42, type: "say", say: "task", text: "quiet work" }])
		const session = {
			sessionId: "bg-1",
			isRunning: true,
			startConfig: { modelId: "bg-model" },
			sdkHost: { pendingPrompts: async () => [] },
		}
		const liveSessions = new Map([["bg-1", session]])
		Object.assign(controller, {
			lastKnownWorkspaceRoot: "/workspace",
			taskSessions: new Map([["bg-1", { task: bgTask }]]),
			stateManager: {
				getGlobalSettingsKey: () => undefined,
				getRemoteConfigSettings: () => ({}),
				setGlobalState: vi.fn(),
			},
			backgroundCommandRunning: false,
			backgroundCommandTaskId: undefined,
			foregroundCommands: { isRunning: false },
			ensureWorkspaceManager: async () => undefined,
			getWorkspaceRoot: async () => "/workspace",
			taskHistory: { listHistory: async () => [] },
			sessions: {
				getActiveSession: () => undefined,
				getSessions: () => liveSessions,
				getSession: (id: string) => liveSessions.get(id),
				sessionStatuses: { "bg-1": "running" },
				subagentCounts: {},
			},
			turnStateTracker: { get: () => undefined },
			messageTranslatorState: { getMinter: () => ({ epoch: 1, nextSeq: () => 1 }) },
		})

		const state = await controller.getStateToPostToWebview()

		// No focused task and no persisted record — the running chat must still
		// surface in the inbox instead of looking deleted.
		expect(state.currentTaskItem).toBeUndefined()
		const row = state.taskHistory.find((item: { id: string }) => item.id === "bg-1")
		expect(row).toMatchObject({ task: "quiet work", modelId: "bg-model", cwdOnTaskInitialization: "/workspace" })
		expect(state.sessionStatuses["bg-1"]).toBe("running")
	})

	it("waits for initial remote config before resuming an existing task", async () => {
		const events: string[] = []
		const controller = {
			waitForInitialRemoteConfig: vi.fn(async () => events.push("policy")),
			turnStateTracker: { set: vi.fn() },
			messageTranslatorState: { clearTurnOutcome: vi.fn() },
			taskStart: { reinitExistingTaskFromId: vi.fn(async () => events.push("resume")) },
		}

		await SdkController.prototype.reinitExistingTaskFromId.call(controller as never, "task-id")

		expect(events).toEqual(["policy", "resume"])
	})
})

describe("hasWorkspaceCheckpointForMessage", () => {
	const messages = [
		{ ts: 1, type: "say", say: "task", text: "start" },
		{ ts: 2, type: "say", say: "text", text: "done" },
		{ ts: 3, type: "say", say: "user_feedback", text: "continue" },
	]
	const sdkMessages = [
		{ role: "user", content: "start" },
		{ role: "assistant", content: "done" },
		{ role: "user", content: "continue" },
	]

	it("reads the live conversation of the active session", async () => {
		const readLiveMessages = vi.fn().mockResolvedValue(sdkMessages)
		const readMessages = vi.fn().mockResolvedValue([])
		const controller = {
			task: { taskId: "task-a", messageStateHandler: { getClineMessages: () => messages } },
			sessions: {
				assertTaskAvailable: vi.fn(),
				getActiveSession: () => ({
					sessionId: "task-a",
					sdkHost: {
						get: async () => ({
							metadata: { checkpoint: { history: [{ ref: "checkpoint-b", createdAt: 1, runCount: 2 }] } },
						}),
						readLiveMessages,
						readMessages,
					},
				}),
			},
		}

		await expect(SdkController.prototype.hasWorkspaceCheckpointForMessage.call(controller as never, 3)).resolves.toBe(true)
		await expect(SdkController.prototype.hasWorkspaceCheckpointForMessage.call(controller as never, 1)).resolves.toBe(false)
		expect(readLiveMessages).toHaveBeenCalledWith("task-a")
		expect(readMessages).not.toHaveBeenCalled()
	})

	it("agrees with editMessageAndRegenerate on which messages exist while the transcript lags", async () => {
		// The persisted transcript is written after Core reports the turn done,
		// so it can still lack the newest user message while its checkpoint exists.
		const readLiveMessages = vi.fn().mockResolvedValue(sdkMessages)
		const readMessages = vi.fn().mockResolvedValue(sdkMessages.slice(0, 2))
		const restore = vi.fn().mockRejectedValue(new Error("stop at restore"))
		const selection = { actProfileId: "Q" }
		const configuration = { actModeApiProvider: "anthropic" }
		const build = vi.fn(async () => ({ providerId: "anthropic", apiKey: "key", modelId: "model" }))
		const controller = {
			task: { taskId: "task-a", messageStateHandler: { getClineMessages: () => messages } },
			sessions: {
				assertTaskAvailable: vi.fn(),
				getActiveSession: () => ({
					sessionId: "task-a",
					apiSnapshot: { selection, configuration },
					isRunning: false,
					sdkHost: {
						get: async () => ({
							cwd: "C:/work",
							metadata: { checkpoint: { history: [{ ref: "checkpoint-b", createdAt: 1, runCount: 2 }] } },
						}),
						readLiveMessages,
						readMessages,
						restore,
					},
				}),
			},
			taskHistory: { findHistoryItem: async () => undefined },
			getWorkspaceRoot: async () => "C:/work",
			stateManager: { getGlobalSettingsKey: () => "act" },
			sessionConfigBuilder: { build },
			resolveContextMentions: async (text: string) => text,
		}

		await expect(SdkController.prototype.hasWorkspaceCheckpointForMessage.call(controller as never, 3)).resolves.toBe(true)
		await expect(
			SdkController.prototype.editMessageAndRegenerate.call(controller as never, {
				messageTs: 3,
				text: "continue, edited",
				restoreWorkspace: true,
			}),
		).rejects.toThrow("stop at restore")
		expect(build).toHaveBeenCalledWith(expect.objectContaining({ apiSelection: selection, apiConfiguration: configuration }))
		expect(restore).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "task-a", checkpointRunCount: 2 }))
		expect(readMessages).not.toHaveBeenCalled()
	})

	it("uses and disposes a temporary host for a history task", async () => {
		const tempHost = {
			get: vi.fn().mockResolvedValue({
				metadata: { checkpoint: { history: [{ ref: "checkpoint-a", createdAt: 1, runCount: 1 }] } },
			}),
			readMessages: vi.fn().mockResolvedValue(sdkMessages),
			dispose: vi.fn().mockRejectedValue(new Error("cleanup failed")),
		}
		const controller = {
			task: { taskId: "task-a", messageStateHandler: { getClineMessages: () => messages } },
			sessions: { assertTaskAvailable: vi.fn(), getActiveSession: () => undefined },
			createRemoteConfigAwareSessionHost: vi.fn().mockResolvedValue(tempHost),
		}

		await expect(SdkController.prototype.hasWorkspaceCheckpointForMessage.call(controller as never, 1)).resolves.toBe(true)
		expect(tempHost.get).toHaveBeenCalledWith("task-a")
		expect(tempHost.dispose).toHaveBeenCalledWith("workspaceCheckpointForMessage")
	})

	it("reports no checkpoint when the host cannot be read", async () => {
		const controller = {
			task: { taskId: "task-a", messageStateHandler: { getClineMessages: () => messages } },
			sessions: { assertTaskAvailable: vi.fn(), getActiveSession: () => undefined },
			createRemoteConfigAwareSessionHost: vi.fn().mockRejectedValue(new Error("host unavailable")),
		}

		await expect(SdkController.prototype.hasWorkspaceCheckpointForMessage.call(controller as never, 1)).resolves.toBe(false)
	})

	it("reports no checkpoint for messages that did not start a run", async () => {
		const answerMessages = [
			{ ts: 1, type: "say", say: "task", text: "start" },
			{ ts: 2, type: "ask", ask: "followup", text: "which file?" },
			{ ts: 3, type: "say", say: "user_feedback", text: "src/index.ts" },
		]
		const createRemoteConfigAwareSessionHost = vi.fn()
		const controller = {
			task: { taskId: "task-a", messageStateHandler: { getClineMessages: () => answerMessages } },
			sessions: { assertTaskAvailable: vi.fn(), getActiveSession: () => undefined },
			createRemoteConfigAwareSessionHost,
		}

		await expect(SdkController.prototype.hasWorkspaceCheckpointForMessage.call(controller as never, 3)).resolves.toBe(false)
		expect(createRemoteConfigAwareSessionHost).not.toHaveBeenCalled()
	})
})

describe("resolveWorkspaceManagerPaths", () => {
	it("returns the host's workspace folder paths, dropping blank entries", () => {
		expect(resolveWorkspaceManagerPaths(["/workspace", "  ", "/other"], "/Users/tester/Desktop")).toEqual([
			"/workspace",
			"/other",
		])
	})

	it("falls back to a single root when no workspace folder is open", () => {
		// Legacy-parity: an empty VS Code window must still yield a usable root
		// so @-mention file search doesn't fail with workspace_unavailable.
		expect(resolveWorkspaceManagerPaths([], "/Users/tester/Desktop")).toEqual(["/Users/tester/Desktop"])
		expect(resolveWorkspaceManagerPaths(undefined, "/Users/tester/Desktop")).toEqual(["/Users/tester/Desktop"])
		expect(resolveWorkspaceManagerPaths(["", "   "], "/Users/tester/Desktop")).toEqual(["/Users/tester/Desktop"])
	})

	it("prefers real workspace folders over the fallback", () => {
		expect(resolveWorkspaceManagerPaths(["/workspace"], "/Users/tester/Desktop")).toEqual(["/workspace"])
	})

	it("returns no roots when the fallback is also unavailable", () => {
		expect(resolveWorkspaceManagerPaths([], undefined)).toEqual([])
		expect(resolveWorkspaceManagerPaths([], "  ")).toEqual([])
	})
})

describe("interject ordering", () => {
	it("waits for abort before sending the next turn with attachments", async () => {
		const order: string[] = []
		let releaseAbort: () => void = () => {}
		const controller = {
			task: { taskId: "parent" },
			sessions: { assertTaskAvailable: vi.fn(), getActiveSession: () => undefined },
			turnStateTracker: { set: vi.fn() },
			taskControl: {
				cancelTask: vi.fn(async (resume: boolean) => {
					expect(resume).toBe(false)
					order.push("abort")
					await new Promise<void>((resolve) => {
						releaseAbort = resolve
					})
				}),
			},
			askResponse: vi.fn(async () => {
				order.push("send")
			}),
		}
		const sending = SdkController.prototype.interjectPrompt.call(controller as never, "Now", ["image"], ["file"])
		expect(order).toEqual(["abort"])
		expect(controller.askResponse).not.toHaveBeenCalled()
		releaseAbort()
		await sending
		expect(order).toEqual(["abort", "send"])
		expect(controller.askResponse).toHaveBeenCalledWith("Now", ["image"], ["file"])
	})
})

describe("task session contexts", () => {
	it("isolates messages and approvals, streams only focus, and marks background asks waiting", async () => {
		type Context = { task: TaskProxy; interactions: SdkInteractionCoordinator; messages: SdkMessageCoordinator }
		const statuses: Record<string, string> = {}
		const stream = { emitSessionEvents: vi.fn() }
		const controller = {
			task: { taskId: "b" },
			taskSessions: new Map<string, Context>(),
			homeContext: { translator: new MessageTranslatorState() },
			sessionEventStream: stream,
			stateManager: { getGlobalSettingsKey: () => undefined },
			sessions: {
				assertTaskAvailable: vi.fn(),
				getSession: () => ({ isRunning: true }),
				setStatus: (id: string, status: string) => {
					statuses[id] = status
				},
			},
			taskHistory: {},
			postStateToWebview: vi.fn(async () => {}),
			diffEdits: { discardPreview: vi.fn() },
		}
		const factory = (SdkController.prototype as unknown as { getTaskSessionContext: (id: string) => Context })
			.getTaskSessionContext
		const a = factory.call(controller, "a")
		const b = factory.call(controller, "b")
		const answer = a.interactions.handleAskQuestion("Background question", [], {})
		await vi.waitFor(() => expect(statuses.a).toBe("waiting"))
		expect(a.task.messageStateHandler.getClineMessages()).toHaveLength(1)
		expect(b.task.messageStateHandler.getClineMessages()).toHaveLength(0)
		expect(stream.emitSessionEvents).not.toHaveBeenCalled()
		expect(b.interactions.resolvePendingAskQuestion("wrong session")).toBe(false)
		controller.task = { taskId: "a" }
		expect(a.interactions.resolvePendingAskQuestion("Answer")).toBe(true)
		await expect(answer).resolves.toBe("Answer")
		expect(statuses.a).toBe("running")
		expect(stream.emitSessionEvents).toHaveBeenCalledOnce()
	})
})

describe("child approval task ownership", () => {
	it("uses the background owner's mode and keeps concurrent approvals waiting", async () => {
		type Context = { mode: "plan" | "act"; task: TaskProxy; interactions: SdkInteractionCoordinator }
		const statuses: Record<string, string> = {}
		let focusedMode = "plan"
		const stream = { emitSessionEvents: vi.fn() }
		const controller = {
			task: { taskId: "focused-act" },
			taskSessions: new Map<string, Context>(),
			homeContext: { translator: new MessageTranslatorState() },
			sessionEventStream: stream,
			stateManager: {
				getGlobalSettingsKey: (key: string) =>
					key === "mode" ? focusedMode : key === "autoApprovalSettings" ? { actions: { useMcp: true } } : undefined,
			},
			sessions: {
				assertTaskAvailable: vi.fn(),
				getSession: () => ({ isRunning: true }),
				setStatus: (id: string, status: string) => {
					statuses[id] = status
				},
			},
			taskHistory: {},
			postStateToWebview: vi.fn(async () => {}),
			diffEdits: { discardPreview: vi.fn() },
		}
		const factory = (SdkController.prototype as unknown as { getTaskSessionContext: (id: string) => Context })
			.getTaskSessionContext
		const owner = factory.call(controller, "background-ask")
		focusedMode = "act"
		const focus = factory.call(controller, "focused-act")
		const request = {
			agentId: "child",
			conversationId: "child-conversation",
			iteration: 1,
			toolCallId: "call-1",
			toolName: "s__write",
			input: {},
			policy: { autoApprove: false },
		}
		const first = owner.interactions.handleRequestToolApproval(request)
		const second = owner.interactions.handleRequestToolApproval({ ...request, toolCallId: "call-2" })
		await vi.waitFor(() => expect(statuses["background-ask"]).toBe("waiting"))
		expect(focus.task.messageStateHandler.getClineMessages()).toHaveLength(0)
		expect(stream.emitSessionEvents).not.toHaveBeenCalled()
		owner.interactions.resolvePendingToolApproval(undefined, "yesButtonClicked")
		await expect(first).resolves.toEqual({ approved: true })
		await vi.waitFor(() => expect(owner.task.messageStateHandler.getClineMessages()).toHaveLength(2))
		expect(statuses["background-ask"]).toBe("waiting")
		owner.interactions.resolvePendingToolApproval(undefined, "noButtonClicked")
		await expect(second).resolves.toMatchObject({ approved: false })
		expect(statuses["background-ask"]).toBe("running")
		await expect(focus.interactions.handleRequestToolApproval(request)).resolves.toEqual({ approved: true })
	})
})

describe("aside session creation", () => {
	it("persists fork fields in Ask mode and keeps the parent focused without restoring files", async () => {
		const raw = [
			{ role: "user", content: "Parent question" },
			{ role: "assistant", content: "Answer" },
		]
		const visible = [{ ts: 10, type: "say", say: "task", text: "Parent question", sdkMessageIndex: 0 }]
		const task = createTaskProxy("parent", vi.fn(), vi.fn())
		task.messageStateHandler.addMessages(visible as never)
		const context = { mode: "act", task: createTaskProxy("aside", vi.fn(), vi.fn()), turn: { set: vi.fn() } }
		const host = { readLiveMessages: vi.fn(async () => raw), restore: vi.fn() }
		const controller = {
			stateManager: { getGlobalStateKey: () => undefined, getApiConfiguration: () => ({}) },
			task,
			taskSessions: new Map([["parent", { task }]]),
			sessionRebuilds: { runExclusive: async (run: () => Promise<void>) => run() },
			taskHistory: {
				findHistoryItem: async () => ({ id: "parent", task: "Parent question", cwdOnTaskInitialization: "/repo" }),
				updateTaskHistoryItem: vi.fn(async () => {}),
				getClineMessages: async () => visible,
			},
			sessions: {
				assertTaskAvailable: vi.fn(),
				getSession: () => ({ sdkHost: host }),
				startNewSession: vi.fn(async () => ({ startResult: { sessionId: "aside" } })),
				focusSession: vi.fn(),
				setRunning: vi.fn(),
			},
			sessionConfigBuilder: {
				build: vi.fn(async () => ({ providerId: "anthropic", modelId: "model", cwd: "/repo", mode: "plan" })),
			},
			getTaskSessionContext: () => context,
			postStateToWebview: vi.fn(async () => {}),
		}
		await expect(SdkController.prototype.forkTaskAt.call(controller as never, "parent", 10)).resolves.toBe("aside")
		expect(controller.sessions.startNewSession).toHaveBeenCalledWith(
			expect.objectContaining({
				initialMessages: [raw[0]],
				sessionMetadata: expect.objectContaining({ taskMode: "plan", parentTaskId: "parent", forkedAtTs: 10 }),
			}),
		)
		expect(controller.taskHistory.updateTaskHistoryItem).toHaveBeenCalledWith(
			expect.objectContaining({ parentTaskId: "parent", forkedAtTs: 10 }),
		)
		expect(context.mode).toBe("plan")
		expect(controller.sessions.focusSession).toHaveBeenCalledWith("parent")
		expect(controller.task).toBe(task)
		expect(host.restore).not.toHaveBeenCalled()
	})
})

describe("stopSubagent", () => {
	it("aborts the child run, marks it stopped, and emits an updated status row", async () => {
		const translator = new MessageTranslatorState()
		translator.addSpawnAgent("call-1", "research", "read")
		translator.addSpawnAgent("call-2", "write", "write")
		const statusTs = translator.getSpawnAgentStatusTs()
		const emitHookMessage = vi.fn()
		const stopSubagent = vi.fn(async () => true)
		const setSubagentCounts = vi.fn()
		const controller = {
			taskSessions: new Map([["task-1", { translator, messages: { emitHookMessage } }]]),
			sessions: {
				assertTaskAvailable: vi.fn(),
				getSession: () => ({ sessionId: "task-1", sdkHost: { stopSubagent } }),
				setSubagentCounts,
			},
			postStateToWebview: vi.fn(async () => {}),
		}

		await expect(SdkController.prototype.stopSubagent.call(controller as never, "task-1", `${statusTs}:1`)).resolves.toBe(
			true,
		)

		expect(stopSubagent).toHaveBeenCalledWith("task-1", "call-1")
		expect(translator.getSpawnAgent("call-1")?.status).toBe("stopped")
		expect(translator.getSpawnAgent("call-2")?.status).toBe("running")
		const emitted = emitHookMessage.mock.calls[0][0]
		expect(emitted.ts).toBe(statusTs)
		expect(emitted.say).toBe("subagent")
		expect(emitted.partial).toBe(true)
		expect(JSON.parse(emitted.text).items.map((i: { status: string }) => i.status)).toEqual(["stopped", "running"])
		expect(setSubagentCounts).toHaveBeenCalledWith("task-1", { total: 2, live: 1 })
		expect(controller.postStateToWebview).toHaveBeenCalled()
	})

	it("returns false for stale chips, unknown tasks, or missing abort support", async () => {
		const translator = new MessageTranslatorState()
		translator.addSpawnAgent("call-1", "research", "read")
		const statusTs = translator.getSpawnAgentStatusTs()
		const stopSubagent = vi.fn(async () => true)
		const controller = {
			taskSessions: new Map([["task-1", { translator, messages: { emitHookMessage: vi.fn() } }]]),
			sessions: {
				assertTaskAvailable: vi.fn(),
				getSession: () => ({ sessionId: "task-1", sdkHost: { stopSubagent } }),
				setSubagentCounts: vi.fn(),
			},
			postStateToWebview: vi.fn(async () => {}),
		}

		await expect(SdkController.prototype.stopSubagent.call(controller as never, "task-1", "999:1")).resolves.toBe(false)
		await expect(SdkController.prototype.stopSubagent.call(controller as never, "task-1", `${statusTs}:9`)).resolves.toBe(
			false,
		)
		await expect(SdkController.prototype.stopSubagent.call(controller as never, "gone", `${statusTs}:1`)).resolves.toBe(false)
		expect(stopSubagent).not.toHaveBeenCalled()
	})
})

describe("task deletion fence", () => {
	it.each([
		"askResponse",
		"showTaskWithId",
		"forkTaskAt",
		"interjectPrompt",
	] as const)("rejects %s for a deleting task", async (method) => {
		const controller = {
			task: { taskId: "deleting" },
			sessions: {
				assertTaskAvailable: vi.fn(() => {
					throw new Error("Task is being deleted")
				}),
			},
		}
		await expect(Reflect.apply(SdkController.prototype[method], controller, ["deleting", 10])).rejects.toThrow(
			"Task is being deleted",
		)
		expect(controller.sessions.assertTaskAvailable).toHaveBeenCalledWith("deleting")
	})
})

describe("task configuration races", () => {
	it("uses live selection when history was read before a picker change inside the transition lock", async () => {
		const controller = Object.create(SdkController.prototype)
		const profiles = ["P", "Q"].map((id) => ({ id, name: id, provider: "openai", modelId: id }))
		const globals: Record<string, unknown> = { apiConfigProfiles: profiles, askProfileId: "P", actProfileId: "P" }
		const config: Record<string, unknown> = { actModeReasoningEffort: "low" }
		const context = {
			mode: "act",
			apiSelection: { actProfileId: "P", actModeReasoningEffort: "low" },
			task: createTaskProxy("live", vi.fn(), vi.fn()),
		}
		Object.assign(controller, {
			stateManager: {
				getGlobalStateKey: (key: string) => globals[key],
				getGlobalSettingsKey: () => "act",
				getApiConfiguration: () => config,
				setGlobalStateBatch: (updates: object) => Object.assign(globals, updates),
				setApiConfiguration: (updates: object) => Object.assign(config, updates),
				getSecretForKey: () => undefined,
				listSecretStorageKeys: () => [],
			},
			taskSessions: new Map([["live", context]]),
			sessions: { getSession: () => ({}) },
			taskHistory: { setTaskApiSelection: vi.fn(async () => {}) },
		})
		const stale = { id: "live", apiSelection: { actProfileId: "P", actModeReasoningEffort: "low" } }
		const control = new SdkTaskControlCoordinator({
			taskHistory: { findHistoryItem: async () => stale },
			sessions: {},
			clearTaskSettings: async () => {},
			rebuilds: {
				runTaskTransition: async (run: () => Promise<void>) => {
					// A picker change lands after history lookup but before focus restoration.
					context.apiSelection = { actProfileId: "Q", actModeReasoningEffort: "high" }
					await run()
				},
			},
			focusLiveTask: (_id: string, item: unknown) => {
				controller.restoreTaskApiSelection(item, "act")
				return true
			},
			postStateToWebview: async () => {},
		} as never)
		await control.showTaskWithId("live")
		expect(globals.actProfileId).toBe("P")
		expect(config.actModeReasoningEffort).toBe("low")
		expect(context.apiSelection).toEqual({ actProfileId: "Q", actModeReasoningEffort: "high" })
	})

	it("keeps pending picker changes separate from the live selection and posts the live build snapshot", async () => {
		const controller = Object.create(SdkController.prototype)
		const selection = { askProfileId: "P", actProfileId: "P", actModeReasoningEffort: "low" }
		const context = { apiSelection: selection, pendingApiSelection: undefined as TaskApiSelection | undefined }
		const task = { taskId: "live", messageStateHandler: { getClineMessages: () => [] } }
		Object.defineProperty(controller, "task", { value: task, writable: true })
		const session = {
			sessionId: "live",
			apiSnapshot: {
				selection,
				configuration: { actModeApiProvider: "openai", actModeOpenAiModelId: "p-model", actModeReasoningEffort: "low" },
			},
			sdkHost: { pendingPrompts: async () => [] },
		}
		Object.assign(controller, {
			task,
			taskSessions: new Map([["live", context]]),
			getTaskSessionContext: () => context,
			stateManager: {
				getGlobalStateKey: (key: string) =>
					key === "apiConfigProfiles"
						? ["P", "Q"].map((id) => ({ id, name: id, provider: "openai", modelId: `${id.toLowerCase()}-model` }))
						: "Q",
				getApiConfiguration: () => ({ actModeReasoningEffort: "high" }),
				getGlobalSettingsKey: () => undefined,
				listSecretStorageKeys: () => [],
				getSecretForKey: () => undefined,
				getRemoteConfigSettings: () => ({}),
				setGlobalState: vi.fn(),
			},
			providerChanges: { handleApiConfigurationChanged: vi.fn() },
			sessions: { getSession: () => session, getActiveSession: () => session, sessionStatuses: {} },
			foregroundCommands: { isRunning: false },
			ensureWorkspaceManager: async () => undefined,
			taskHistory: { listHistory: async () => [] },
			turnStateTracker: { get: () => undefined },
			messageTranslatorState: { getMinter: () => ({ epoch: 1, nextSeq: () => 1 }) },
		})
		await controller.updateChatApiSelection("act", { taskId: "live", profileId: "Q", reasoningEffort: "high" })
		expect(context.apiSelection).toBe(selection)
		expect(context.pendingApiSelection).toMatchObject({ actProfileId: "Q", actModeReasoningEffort: "high" })
		buildBaseStateMock.mockResolvedValueOnce({
			taskHistory: [],
			mode: "act",
			actProfileId: "Q",
			apiConfiguration: { actModeReasoningEffort: "high" },
		} as never)
		const state = await controller.getStateToPostToWebview()
		expect(state.actProfileId).toBe("Q")
		expect(state.apiConfiguration).toMatchObject({ actModeReasoningEffort: "high" })
		expect(state.apiConfiguration.actModeOpenAiModelId).toBeUndefined()
		expect(state.composerApiSelection).toMatchObject({ actProfileId: "Q", actModeReasoningEffort: "high" })
		expect(state.composerApiConfiguration).toMatchObject({ actModeOpenAiModelId: "q-model", actModeReasoningEffort: "high" })
		expect(state.focusedSessionModels.act).toEqual({
			profileId: "P",
			provider: "openai",
			modelId: "p-model",
			reasoningEffort: "low",
		})
		// A background profile edit cannot change the displayed live model on refocus.
		controller.stateManager.getApiConfiguration = () => ({ actModeOpenAiModelId: "edited-p-model" })
		buildBaseStateMock.mockResolvedValueOnce({
			taskHistory: [],
			mode: "act",
			actProfileId: "Q",
			apiConfiguration: { actModeOpenAiModelId: "edited-p-model" },
		} as never)
		const editedState = await controller.getStateToPostToWebview()
		expect(editedState.focusedSessionModels.act.modelId).toBe("p-model")
	})

	it("restores pending selection on refocus and preserves it across unrelated saves and other-mode changes", async () => {
		const controller = Object.create(SdkController.prototype)
		const selection = { askProfileId: "P", actProfileId: "P", actModeReasoningEffort: "low" }
		const context = { apiSelection: selection, pendingApiSelection: undefined as TaskApiSelection | undefined }
		const profiles = ["P", "Q", "R"].map((id) => ({ id, name: id, provider: "openai", modelId: id }))
		const globals: Record<string, unknown> = { apiConfigProfiles: profiles, askProfileId: "P", actProfileId: "Q" }
		const config: Record<string, unknown> = { actModeReasoningEffort: "high" }
		Object.defineProperty(controller, "task", { value: { taskId: "live" } })
		Object.assign(controller, {
			taskSessions: new Map([["live", context]]),
			getTaskSessionContext: () => context,
			sessions: { getSession: () => ({ isRunning: true, apiSnapshot: { selection } }) },
			stateManager: {
				getGlobalStateKey: (key: string) => globals[key],
				getGlobalSettingsKey: () => "act",
				getApiConfiguration: () => config,
				setGlobalStateBatch: (updates: object) => Object.assign(globals, updates),
				setApiConfiguration: (updates: object) => Object.assign(config, updates),
				getSecretForKey: () => undefined,
				listSecretStorageKeys: () => [],
			},
			taskHistory: { setTaskApiSelection: vi.fn(async () => {}) },
			providerChanges: { handleApiConfigurationChanged: vi.fn() },
		})
		await controller.updateChatApiSelection("act", { taskId: "live", profileId: "Q", reasoningEffort: "high" })
		// Another chat changes globals before A regains focus.
		globals.actProfileId = "R"
		config.actModeReasoningEffort = "medium"
		controller.restoreTaskApiSelection({ id: "live", apiSelection: selection }, "act")
		expect(globals.actProfileId).toBe("R")
		expect(config.actModeReasoningEffort).toBe("medium")
		expect(controller.taskHistory.setTaskApiSelection).not.toHaveBeenCalled()
		// Saving a profile changes connection options, not the requested selection.
		controller.handleApiConfigurationChanged({ openAiBaseUrl: "old" }, { openAiBaseUrl: "new" })
		expect(context.pendingApiSelection).toEqual({ ...selection, actProfileId: "Q", actModeReasoningEffort: "high" })
		await controller.updateChatApiSelection("plan", { taskId: "live", profileId: "R" })
		expect(context.pendingApiSelection).toEqual({
			...selection,
			askProfileId: "R",
			planModeReasoningEffort: "none",
			actProfileId: "Q",
			actModeReasoningEffort: "high",
		})
		// Explicitly choosing the live profile again must cancel the pending switch.
		await controller.updateChatApiSelection("act", { taskId: "live", profileId: "P" })
		expect(context.pendingApiSelection?.actProfileId).toBe("P")
		expect(context.pendingApiSelection?.askProfileId).toBe("R")
		expect(context.apiSelection).toBe(selection)
	})

	it("commits mode and selection for a history-only chat after switching completes", async () => {
		const context = { mode: "plan" }
		const controller = {
			task: { taskId: "history" },
			getTaskSessionContext: () => context,
			sessions: { getSession: () => undefined },
			stateManager: { getGlobalSettingsKey: () => "act" },
			mode: { togglePlanActMode: vi.fn(async () => false) },
			recordTaskApiSelection: vi.fn(),
			taskHistory: { setTaskMode: vi.fn(async () => {}) },
		}
		await SdkController.prototype.togglePlanActMode.call(controller as never, "act")
		expect(context.mode).toBe("act")
		expect(controller.recordTaskApiSelection).toHaveBeenCalledWith("history")
		expect(controller.taskHistory.setTaskMode).toHaveBeenCalledWith("history", "act")
		expect(controller.taskHistory.setTaskMode.mock.invocationCallOrder[0]).toBeGreaterThan(
			controller.mode.togglePlanActMode.mock.invocationCallOrder[0],
		)
	})

	it("does not mutate the live mode snapshot before a failed rebuild", async () => {
		const session = { startConfig: { mode: "plan" } }
		const context = { mode: "plan" }
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const controller = {
			task: { taskId: "live" },
			getTaskSessionContext: () => context,
			sessions: { getSession: () => session },
			mode: {
				togglePlanActMode: async () => {
					await gate
					return false
				},
			},
		}
		const switchMode = SdkController.prototype.togglePlanActMode.call(controller as never, "act")
		expect(session.startConfig.mode).toBe("plan")
		expect(context.mode).toBe("plan")
		release()
		await switchMode
		expect(session.startConfig.mode).toBe("plan")
		expect(context.mode).toBe("plan")
	})
})

describe("composer selections", () => {
	function setup(focused = true) {
		const controller = Object.create(SdkController.prototype)
		const globals = {
			askProfileId: "P",
			actProfileId: "P",
			apiConfigProfiles: [
				{ id: "P", name: "Default", provider: "openai", modelId: "p" },
				{ id: "Q", name: "Override", provider: "openai", modelId: "q", reasoningEffort: "high" },
			],
		}
		const config = { planModeReasoningEffort: "low", actModeReasoningEffort: "low" }
		const original = { askProfileId: "P", actProfileId: "P", planModeReasoningEffort: "low", actModeReasoningEffort: "low" }
		const context: any = { apiSelection: original, mode: "act" }
		const session = { isRunning: false, queuedPromptCount: 0, sdkHost: {} }
		Object.defineProperty(controller, "task", { value: focused ? { taskId: "chat" } : undefined, writable: true })
		Object.assign(controller, {
			taskSessions: new Map([["chat", context]]),
			getTaskSessionContext: () => context,
			stateManager: {
				getGlobalStateKey: (key: keyof typeof globals) => globals[key],
				getApiConfiguration: () => config,
				setGlobalState: vi.fn(),
				setApiConfiguration: vi.fn(),
			},
			sessions: { getSession: () => session, markSendRunning: vi.fn(), setRunning: vi.fn(), fireAndForgetSend: vi.fn() },
			providerChanges: { handleApiConfigurationChanged: vi.fn() },
			taskHistory: { setTaskApiSelection: vi.fn(async () => {}) },
			sessionRebuilds: { sessionBecameIdle: vi.fn() },
		})
		return { controller, globals, config, context, session, original }
	}

	it("changes only the focused chat, retaining settings and the live build until replacement", async () => {
		const { controller, globals, config, context, original } = setup()
		await controller.updateChatApiSelection("act", { taskId: "chat", profileId: "Q" })
		expect(context.pendingApiSelection).toEqual({ ...original, actProfileId: "Q", actModeReasoningEffort: "high" })
		expect(context.apiSelection).toBe(original)
		expect(globals.actProfileId).toBe("P")
		expect(config.actModeReasoningEffort).toBe("low")
		expect(controller.stateManager.setGlobalState).not.toHaveBeenCalled()
		expect(controller.stateManager.setApiConfiguration).not.toHaveBeenCalled()
	})

	it("holds a home draft without updating settings and fences a stale home request", async () => {
		const { controller, globals } = setup(false)
		await controller.updateChatApiSelection("plan", { taskId: "", profileId: "Q", reasoningEffort: "xhigh" })
		expect(controller.draftApiSelection).toMatchObject({ askProfileId: "Q", planModeReasoningEffort: "xhigh" })
		expect(globals.askProfileId).toBe("P")
		controller.task = { taskId: "chat" }
		await expect(controller.updateChatApiSelection("act", { taskId: "", profileId: "Q" })).rejects.toThrow(
			"Focused chat changed",
		)
	})

	it("reverts the next-message choice only after its turn, before releasing deferred messages", async () => {
		const { controller, context, original, session } = setup()
		await controller.updateChatApiSelection("act", { taskId: "chat", nextMessageOnly: true })
		await controller.updateChatApiSelection("act", { taskId: "chat", profileId: "Q", reasoningEffort: "xhigh" })
		const temporary = context.pendingApiSelection
		controller.commitTaskApiSelection("chat", temporary, temporary)
		expect(controller.taskHistory.setTaskApiSelection).toHaveBeenCalledWith("chat", original)
		controller.handleSessionBecameIdle()
		expect(context.nextMessageSelection.restoring).toBeUndefined()
		context.nextMessageSelection.started = true
		session.isRunning = true
		expect(controller.deferOneTurnFollowup("chat", "later", ["image"], [], "queue")).toBe(true)
		controller.handleSessionBecameIdle()
		expect(context.pendingApiSelection).toBeUndefined()
		session.isRunning = false
		controller.handleSessionBecameIdle()
		expect(context.pendingApiSelection).toEqual(original)
		expect(controller.sessions.fireAndForgetSend).not.toHaveBeenCalled()
		controller.commitTaskApiSelection("chat", original, original)
		expect(context.nextMessageSelection).toBeUndefined()
		expect(context.apiSelection).toEqual(original)
		expect(controller.sessions.fireAndForgetSend).toHaveBeenCalledWith(
			session.sdkHost,
			"chat",
			"later",
			["image"],
			[],
			undefined,
		)
	})

	it("aborts through Core interject immediately and restores the one-message selection at idle", async () => {
		const { controller, context, session, original } = setup()
		await controller.updateChatApiSelection("act", { taskId: "chat", nextMessageOnly: true })
		await controller.updateChatApiSelection("act", { taskId: "chat", profileId: "Q" })
		controller.commitTaskApiSelection("chat", context.pendingApiSelection, context.pendingApiSelection)
		context.nextMessageSelection.started = true
		session.isRunning = true
		expect(context.apiSelection.actProfileId).toBe("Q")
		controller.deferOneTurnFollowup("chat", "older followup", [], [], "queue")
		const pending: any[] = []
		const runtime = Object.create(LocalRuntimeHost.prototype)
		Object.assign(runtime, {
			sessions: new Map([["chat", { sessionId: "chat", status: "running", agent: { canStartRun: () => false } }]]),
			turnsInFlight: new Map(),
			abort: vi.fn(async () => {
				session.isRunning = false
			}),
			pendingPromptsController: { enqueue: (_id: string, entry: any) => pending.unshift(entry) },
		})
		const host = {
			send: vi.fn((input: any) =>
				input.delivery === "interject" ? runtime.runTurn(input) : Promise.resolve(pending.push(input)),
			),
		}
		session.sdkHost = host
		const lifecycle = Object.create(SdkSessionLifecycle.prototype)
		Object.assign(lifecycle, {
			liveSessions: new Map([["chat", session]]),
			turnGenerations: new Map(),
			replacements: new Map(),
			sessionStatuses: {},
			assertTaskAvailable: vi.fn(),
			options: {
				deferSend: (...args: any[]) => controller.deferOneTurnFollowup(...args),
				onSendComplete: vi.fn(),
				onSendError: vi.fn(),
			},
		})
		controller.sessions.fireAndForgetSend = lifecycle.fireAndForgetSend.bind(lifecycle)
		const control = new SdkTaskControlCoordinator({
			sessions: {
				getActiveSession: () => ({ ...session, sessionId: "chat" }),
				fireAndForgetSend: controller.sessions.fireAndForgetSend,
			},
			interactions: { clearPending: vi.fn() },
			raiseCancelFence: vi.fn(),
		} as never)
		await control.cancelTask(false, { text: "priority" })
		expect(host.send).toHaveBeenCalledWith(expect.objectContaining({ prompt: "priority", delivery: "interject" }))
		expect(runtime.abort).toHaveBeenCalledOnce()
		expect(session.isRunning).toBe(false)
		// Core has admitted the priority prompt. Wait for it to drain before rebuilding.
		session.queuedPromptCount = 1
		controller.handleSessionBecameIdle()
		expect(context.pendingApiSelection).toBeUndefined()
		expect(context.nextMessageSelection.deferred).toHaveLength(1)
		expect(pending[0]).toMatchObject({ prompt: "priority", delivery: "interject" })
		session.queuedPromptCount = 0
		controller.handleSessionBecameIdle()
		expect(context.pendingApiSelection).toEqual(original)
		controller.commitTaskApiSelection("chat", original, original)
		expect(context.apiSelection).toEqual(original)
		expect(context.nextMessageSelection).toBeUndefined()
		await vi.waitFor(() => expect(pending.map((entry) => entry.prompt)).toEqual(["priority", "older followup"]))
	})

	it("persists the temporary choice when Keep for this chat is selected before sending", async () => {
		const { controller, context } = setup()
		await controller.updateChatApiSelection("act", { taskId: "chat", nextMessageOnly: true })
		await controller.updateChatApiSelection("act", { taskId: "chat", profileId: "Q" })
		const selected = context.pendingApiSelection
		controller.commitTaskApiSelection("chat", selected, selected)
		await controller.updateChatApiSelection("act", { taskId: "chat", nextMessageOnly: false })
		expect(context.nextMessageSelection).toBeUndefined()
		expect(controller.taskHistory.setTaskApiSelection).toHaveBeenLastCalledWith("chat", selected)
	})

	it("rejects arming during a running turn and resets only the requested mode", async () => {
		const { controller, context, session, original } = setup()
		session.isRunning = true
		await expect(controller.updateChatApiSelection("act", { taskId: "chat", nextMessageOnly: true })).rejects.toThrow(
			"Wait for this turn",
		)
		await controller.updateChatApiSelection("plan", { taskId: "chat", profileId: "Q" })
		await controller.updateChatApiSelection("act", { taskId: "chat", profileId: "Q" })
		await controller.updateChatApiSelection("act", { taskId: "chat", resetToDefault: true })
		expect(context.pendingApiSelection).toEqual({ ...original, askProfileId: "Q", planModeReasoningEffort: "high" })
	})

	it("settings changes keep chat overrides and captured defaults intact", async () => {
		const { controller, context, globals, config, original } = setup()
		await controller.updateChatApiSelection("act", { taskId: "chat", profileId: "Q" })
		const pending = context.pendingApiSelection
		controller.commitTaskApiSelection("chat", pending, pending)
		const inherited = { apiSelection: original }
		controller.taskSessions.set("default-chat", inherited)
		globals.actProfileId = "Q"
		config.actModeReasoningEffort = "high"
		controller.handleApiConfigurationChanged({}, config, { actProfileId: "Q" })
		expect(context.apiSelection).toBe(pending)
		expect(context.pendingApiSelection).toBeUndefined()
		expect(inherited.apiSelection).toBe(original)
	})

	it("reopens a persisted override without changing settings", () => {
		const { controller, globals, config, context } = setup()
		context.apiSelection = undefined
		controller.sessions.getSession = () => undefined
		controller.restoreTaskApiSelection(
			{ id: "chat", apiSelection: { actProfileId: "Q", actModeReasoningEffort: "xhigh" } },
			"act",
		)
		expect(context.apiSelection).toMatchObject({ actProfileId: "Q", actModeReasoningEffort: "xhigh", askProfileId: "P" })
		expect(globals.actProfileId).toBe("P")
		expect(config.actModeReasoningEffort).toBe("low")
	})
})
