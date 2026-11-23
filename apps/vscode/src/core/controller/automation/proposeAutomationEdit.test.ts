import { ProposeAutomationEditRequest } from "@shared/proto/cline/automation"
import { expect, it, vi } from "vitest"
import { serializeAutomation } from "@/sdk/automations/automation-file"
import { ticketToPr } from "@/sdk/automations/automation-fixtures"
import { generateAutomationFile } from "./draftAutomation"
import { proposeAutomationEdit } from "./proposeAutomationEdit"

vi.mock("./draftAutomation", () => ({ generateAutomationFile: vi.fn() }))

it("returns the loaded disk fingerprint for a proposal built from a dirty editor", async () => {
	const definition = ticketToPr()
	const edited = { ...definition, description: "Window A draft" }
	const controller = {
		getWorkspaceRoot: vi.fn(),
		automations: {
			store: {
				findByPath: vi.fn().mockResolvedValue({
					name: definition.name,
					content: serializeAutomation({ ...definition, description: "Window B save" }),
					fingerprint: "b",
				}),
			},
		},
	}
	vi.mocked(generateAutomationFile).mockResolvedValue({
		reply: serializeAutomation({ ...edited, description: "Proposed edit" }),
		model: "test",
	})
	const request = {
		...ProposeAutomationEditRequest.create({ path: "ticket-to-pr.md", request: "Update the description" }),
		editorDefinitionJson: JSON.stringify(edited),
		editorBaseFingerprint: "a",
	}
	const response = await proposeAutomationEdit(controller as never, request)
	expect(response.fingerprint).toBe("a")
	expect(response.diff).toContain("Window A draft")
	const fromDisk = await proposeAutomationEdit(controller as never, { ...request, editorDefinitionJson: undefined })
	expect(fromDisk.fingerprint).toBe("b")
	expect(fromDisk.diff).toContain("Window B save")
})
