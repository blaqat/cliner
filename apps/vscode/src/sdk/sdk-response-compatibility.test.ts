import { AskResponseRequest } from "@shared/proto/cline/task"
import { describe, expect, it, vi } from "vitest"
import { askResponse as webviewAskResponse } from "@/core/controller/task/askResponse"
import { createClineAPI } from "@/exports"
import { Controller } from "./SdkController"
import { SdkFollowupCoordinator, type SdkFollowupCoordinatorOptions } from "./sdk-followup-coordinator"
import { SdkInteractionCoordinator } from "./sdk-interaction-coordinator"
import { SdkMessageCoordinator } from "./sdk-message-coordinator"
import { createTaskProxy } from "./task-proxy"

function setup(focusedAgent?: string) {
	const task = createTaskProxy(
		"root",
		(text, images, files, id) => Controller.prototype.askResponse.call(controller as never, text, images, files, id),
		vi.fn(),
	)
	const postStateToWebview = vi.fn(async () => {})
	const interactions = new SdkInteractionCoordinator({
		messages: new SdkMessageCoordinator({ getTask: () => task }),
		getSessionId: () => "root",
		postStateToWebview,
	})
	const getActiveSession = vi.fn(() => undefined)
	const followups = new SdkFollowupCoordinator({
		interactions,
		sessions: { getActiveSession },
	} as unknown as SdkFollowupCoordinatorOptions)
	const controller = {
		task,
		interactions,
		followups,
		postStateToWebview,
		getPendingDecisionId: Controller.prototype.getPendingDecisionId,
		sessions: { assertTaskAvailable: vi.fn() },
		taskHistory: { markTaskActive: vi.fn(async () => {}) },
		turnStateTracker: { get: () => ({ phase: "awaiting_followup" }), set: vi.fn() },
		messageTranslatorState: { clearTurnOutcome: vi.fn() },
		subagentThreads: new Map(),
		taskSessions: new Map([["root", { interactions }]]),
	}
	if (focusedAgent) {
		task.taskId = `root__${focusedAgent}`
		controller.subagentThreads.set(task.taskId, { parentTaskId: "root", agentId: focusedAgent })
	}
	return { controller, interactions, api: createClineAPI(controller as never), getActiveSession }
}

function requestApproval(interactions: SdkInteractionCoordinator, agentId = "root") {
	return interactions.handleRequestToolApproval({
		agentId,
		conversationId: agentId,
		iteration: 1,
		toolCallId: agentId,
		toolName: "editor",
		input: { path: "a.ts" },
		policy: { autoApprove: false },
	})
}

describe("approval response compatibility", () => {
	it.each([true, false])("public API answers an approval, approved=%s", async (approved) => {
		const { controller, interactions, api, getActiveSession } = setup()
		const approval = requestApproval(interactions)
		await vi.waitFor(() => expect(interactions.getPendingDecision()?.kind).toBe("approval"))
		const id = interactions.getPendingDecision()!.id
		const response = vi.spyOn(controller.task, "handleWebviewAskResponse")
		if (approved) await api.pressPrimaryButton()
		else await api.pressSecondaryButton()
		expect(response).toHaveBeenCalledWith(approved ? "yesButtonClicked" : "noButtonClicked", "", [], undefined, id)
		await expect(approval).resolves.toMatchObject({ approved })
		expect(getActiveSession).not.toHaveBeenCalled()
	})

	it("public API sends the current question ID and resolves the answer", async () => {
		const { controller, interactions, api, getActiveSession } = setup()
		const answer = interactions.handleAskQuestion("Which file?", [])
		const id = interactions.getPendingDecision()!.id
		const response = vi.spyOn(controller.task, "handleWebviewAskResponse")
		await api.sendMessage("a.ts")
		expect(response).toHaveBeenCalledWith("messageResponse", "a.ts", [], undefined, id)
		await expect(answer).resolves.toBe("a.ts")
		expect(getActiveSession).not.toHaveBeenCalled()
	})

	it.each(["approval", "question"] as const)("accepts an id-less webview %s response", async (kind) => {
		const { controller, interactions, getActiveSession } = setup()
		const result = kind === "approval" ? requestApproval(interactions) : interactions.handleAskQuestion("Which file?", [])
		await vi.waitFor(() => expect(interactions.getPendingDecision()).toBeDefined())
		await webviewAskResponse(
			controller as never,
			AskResponseRequest.create({
				responseType: kind === "approval" ? "yesButtonClicked" : "messageResponse",
				text: "a.ts",
			}),
		)
		await expect(result).resolves.toEqual(kind === "approval" ? { approved: true } : "a.ts")
		expect(getActiveSession).not.toHaveBeenCalled()
	})

	it("uses the projected question when multiple id-less answers are possible", async () => {
		const { controller, interactions } = setup()
		const first = interactions.handleAskQuestion("First?", [])
		const second = interactions.handleAskQuestion("Second?", [])
		const projected = interactions.getPendingDecision()!
		await webviewAskResponse(
			controller as never,
			AskResponseRequest.create({ responseType: "messageResponse", text: "Second answer" }),
		)
		await expect(second).resolves.toBe("Second answer")
		expect(interactions.hasPendingDecision(projected.id)).toBe(false)
		expect(interactions.getPendingDecision()?.message.text).toContain("First?")
		interactions.clearPending("cleanup")
		await expect(first).resolves.toBe("")
	})

	it.each(["approval", "question"] as const)("rejects a mismatched %s ID", async (kind) => {
		const { controller, interactions, getActiveSession } = setup()
		const result = kind === "approval" ? requestApproval(interactions) : interactions.handleAskQuestion("Question?", [])
		await vi.waitFor(() => expect(interactions.getPendingDecision()).toBeDefined())
		const pending = interactions.getPendingDecision()!
		await webviewAskResponse(
			controller as never,
			AskResponseRequest.create({
				responseType: kind === "approval" ? "yesButtonClicked" : "messageResponse",
				decisionId: "stale",
				text: "stale",
			}),
		)
		expect(interactions.getPendingDecision()?.id).toBe(pending.id)
		expect(getActiveSession).not.toHaveBeenCalled()
		interactions.clearPending("cleanup")
		await result
	})

	it("does not move an id-less response to the next approval while metadata is saving", async () => {
		const { controller, interactions } = setup()
		const saving = Promise.withResolvers<void>()
		controller.taskHistory.markTaskActive.mockImplementationOnce(() => saving.promise)
		const a = requestApproval(interactions, "a")
		const b = requestApproval(interactions, "b")
		await vi.waitFor(() => expect(interactions.getPendingDecision("a")).toBeDefined())
		const response = webviewAskResponse(controller as never, AskResponseRequest.create({ responseType: "yesButtonClicked" }))
		await vi.waitFor(() => expect(controller.taskHistory.markTaskActive).toHaveBeenCalled())
		interactions.resolvePendingToolApproval(
			undefined,
			"yesButtonClicked",
			undefined,
			undefined,
			interactions.getPendingDecision("a")!.id,
		)
		await a
		await vi.waitFor(() => expect(interactions.getPendingDecision("b")).toBeDefined())
		const bId = interactions.getPendingDecision("b")!.id
		saving.resolve()
		await response
		expect(interactions.getPendingDecision("b")?.id).toBe(bId)
		expect(controller.turnStateTracker.set).not.toHaveBeenCalled()
		interactions.clearPending("cleanup")
		await b
	})

	it.each(["approval", "question"] as const)("id-less child %s responses stay within the focused child", async (kind) => {
		const { controller, interactions } = setup("a")
		const a =
			kind === "approval" ? requestApproval(interactions, "a") : interactions.handleAskQuestion("A?", [], { agentId: "a" })
		const b =
			kind === "approval" ? requestApproval(interactions, "b") : interactions.handleAskQuestion("B?", [], { agentId: "b" })
		await vi.waitFor(() => expect(interactions.getPendingDecision("a")).toBeDefined())
		await webviewAskResponse(
			controller as never,
			AskResponseRequest.create({
				responseType: kind === "approval" ? "yesButtonClicked" : "messageResponse",
				text: "A answer",
			}),
		)
		await expect(a).resolves.toEqual(kind === "approval" ? { approved: true } : "A answer")
		await vi.waitFor(() => expect(interactions.getPendingDecision("b")).toBeDefined())
		const bId = interactions.getPendingDecision("b")!.id
		await expect(
			webviewAskResponse(
				controller as never,
				AskResponseRequest.create({
					responseType: kind === "approval" ? "yesButtonClicked" : "messageResponse",
					text: "Wrong child",
				}),
			),
		).rejects.toThrow("read-only")
		expect(interactions.getPendingDecision("b")?.id).toBe(bId)
		await webviewAskResponse(
			controller as never,
			AskResponseRequest.create({
				responseType: kind === "approval" ? "yesButtonClicked" : "messageResponse",
				decisionId: bId,
			}),
		)
		expect(interactions.getPendingDecision("b")?.id).toBe(bId)
		interactions.clearPending("cleanup")
		await b
	})
})
