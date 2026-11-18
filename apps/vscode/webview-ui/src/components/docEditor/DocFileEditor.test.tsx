import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DocFileEditor, docTitle } from "./DocFileEditor"

const mocks = vi.hoisted(() => ({ readDoc: vi.fn(), saveDoc: vi.fn(), openFile: vi.fn() }))
vi.mock("@/services/grpc-client", () => ({
	DocServiceClient: { readDoc: mocks.readDoc, saveDoc: mocks.saveDoc },
	FileServiceClient: { openFile: mocks.openFile },
}))

const skill = {
	path: "/g/skills/pdf-tools/SKILL.md",
	body: "# PDF tools",
	fieldsJson: JSON.stringify({ name: "pdf-tools", description: "Read PDFs", version: 2 }),
	revision: "r1",
	readOnlyReason: "",
}

beforeEach(() => {
	mocks.readDoc.mockReset().mockResolvedValue(skill)
	mocks.saveDoc
		.mockReset()
		.mockImplementation(async (request) => ({ ...skill, fieldsJson: request.fieldsJson, revision: "r2" }))
	mocks.openFile.mockReset().mockResolvedValue({})
})

describe("DocFileEditor", () => {
	it("names each kind the way the panel does", () => {
		expect(docTitle({ path: "/w/.clinerules/workflows/deploy.md", kind: "workflow", isGlobal: false })).toBe("/deploy")
		expect(docTitle({ path: "/g/skills/pdf-tools/SKILL.md", kind: "skill", isGlobal: true })).toBe("pdf-tools")
		expect(docTitle({ path: "/w/.clinerules/testing.md", kind: "rule", isGlobal: false })).toBe("testing")
	})

	it("shows a skill's front matter as fields, keeps unknown ones, and saves fields with the body", async () => {
		render(<DocFileEditor onBack={vi.fn()} target={{ path: skill.path, kind: "skill", isGlobal: true }} />)
		const description = await screen.findByDisplayValue("Read PDFs")
		expect(screen.getByText("Other fields · 1")).toBeInTheDocument()
		expect(screen.queryByText(/^---/)).not.toBeInTheDocument()
		fireEvent.change(description, { target: { value: "Extract text and tables" } })
		fireEvent.click(screen.getByRole("button", { name: "Save" }))
		await waitFor(() => expect(mocks.saveDoc).toHaveBeenCalled())
		const request = mocks.saveDoc.mock.calls[0][0]
		expect(request).toMatchObject({ path: skill.path, kind: "skill", body: "# PDF tools", baseRevision: "r1" })
		expect(JSON.parse(request.fieldsJson)).toEqual({ name: "pdf-tools", description: "Extract text and tables", version: 2 })
	})

	it("edits a rule's paths as a list", async () => {
		mocks.readDoc.mockResolvedValue({ ...skill, path: "/w/.clinerules/testing.md", fieldsJson: "{}" })
		render(<DocFileEditor onBack={vi.fn()} target={{ path: "/w/.clinerules/testing.md", kind: "rule", isGlobal: false }} />)
		fireEvent.change(await screen.findByPlaceholderText("src/**/*.test.ts, e2e/**"), {
			target: { value: "src/**, e2e/**," },
		})
		fireEvent.click(screen.getByRole("button", { name: "Save" }))
		await waitFor(() => expect(mocks.saveDoc).toHaveBeenCalled())
		expect(JSON.parse(mocks.saveDoc.mock.calls[0][0].fieldsJson)).toEqual({ paths: ["src/**", "e2e/**"] })
	})

	it("says why and offers Retry when the file can't be read", async () => {
		mocks.readDoc.mockRejectedValueOnce(new Error("That rule isn't in the Rules panel any more. Refresh the list."))
		render(<DocFileEditor onBack={vi.fn()} target={{ path: "/x.md", kind: "rule", isGlobal: true }} />)
		expect(await screen.findByText(/isn't in the Rules panel/)).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Retry" }))
		expect(await screen.findByTestId("doc-editor")).toHaveTextContent("PDF tools")
		expect(mocks.readDoc).toHaveBeenCalledTimes(2)
	})
})
