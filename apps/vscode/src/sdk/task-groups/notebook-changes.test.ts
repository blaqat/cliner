import type { ClineMessage } from "@shared/ExtensionMessage"
import { ClineSay } from "@shared/proto/cline/ui"
import { convertClineMessageToProto, convertProtoToClineMessage } from "@shared/proto-conversions/cline-message"
import type { NotebookChangesPayload } from "@shared/task-groups"
import { describe, expect, it } from "vitest"
import { mergeNotebookChangesMessages, notebookChangesMessage, restoreNotebookChanges } from "./notebook-changes"

const payload: NotebookChangesPayload = {
	taskGroupId: "group",
	threadId: "root",
	status: "pending",
	changes: [{ op: "create", slug: "plan", name: "Plan", description: "Steps", content: "Draft" }],
}

describe("notebook changes message protocol", () => {
	it.each(["pending", "applied", "discarded"] as const)("round-trips the exact %s card contract through proto", (status) => {
		const message = notebookChangesMessage(
			{ ...payload, status, ...(status === "applied" ? { appliedSlugs: ["plan"] } : {}) },
			10,
		)
		const proto = convertClineMessageToProto(message)
		expect(proto.say).toBe(ClineSay.NOTEBOOK_CHANGES)
		expect(convertProtoToClineMessage(proto)).toMatchObject({ say: "notebook_changes", text: message.text })
		expect(JSON.parse(proto.text)).toEqual(JSON.parse(message.text!))
	})

	it("refreshes only the newest pending card from the current pending file on reopen", () => {
		const older = notebookChangesMessage(payload, 1)
		const latest = notebookChangesMessage(payload, 2)
		const changes = [{ ...payload.changes[0], content: "Current pending" }]
		const restored = restoreNotebookChanges([older, latest], "root", { groupId: "group", changes }, () => 3)
		expect(restored[0]).toBe(older)
		expect(restored[1].ts).toBe(2)
		expect(JSON.parse(restored[1].text!)).toEqual({ ...payload, changes })
	})

	it("recovers pending work without a saved card and settles a stale pending card", () => {
		const restored = restoreNotebookChanges([], "root", { groupId: "group", changes: payload.changes }, () => 3)
		expect(JSON.parse(restored[0].text!)).toEqual(payload)
		expect(JSON.parse(restoreNotebookChanges(restored, "root", undefined, () => 4)[0].text!).status).toBe("discarded")
	})

	it("preserves applied summaries and places saved cards after their turn with fresh identities", () => {
		const summary = {
			...notebookChangesMessage({ ...payload, status: "applied", appliedSlugs: ["plan"] }, 1),
			sdkMessageIndex: 1,
		}
		const messages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "First", sdkMessageIndex: 0 },
			{ ts: 2, type: "say", say: "completion_result", text: "Done", sdkMessageIndex: 1 },
			{ ts: 3, type: "say", say: "user_feedback", text: "Next", sdkMessageIndex: 2 },
		]
		let id = 10
		const merged = mergeNotebookChangesMessages(messages, [summary], () => ++id)
		expect(merged.map((message) => message.say)).toEqual(["task", "completion_result", "notebook_changes", "user_feedback"])
		expect(merged.map((message) => message.ts)).toEqual([11, 12, 13, 14])
		expect(restoreNotebookChanges(merged, "root", undefined, () => ++id)).toEqual(merged)
	})
})
