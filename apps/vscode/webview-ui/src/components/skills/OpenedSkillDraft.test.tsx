import type { NotebookChange } from "@shared/task-groups"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { OpenedSkillDraft } from "./OpenedSkillDraft"

const change = {
	op: "create",
	slug: "skill-release-checklist",
	name: "release-checklist",
	description: "Before a release",
	content: "Steps",
	skill: { kind: "skill", scope: "global" },
} as NotebookChange

const renderDraft = () => {
	const onKeep = vi.fn()
	const onAction = vi.fn()
	render(<OpenedSkillDraft change={change} hasWorkspace onAction={onAction} onDrop={vi.fn()} onKeep={onKeep} sending={false} />)
	return { onKeep, onAction }
}

describe("OpenedSkillDraft Keep", () => {
	it("keeps as is when no field was edited", () => {
		const { onKeep, onAction } = renderDraft()
		fireEvent.click(screen.getByRole("button", { name: "Keep release-checklist" }))
		expect(onKeep).toHaveBeenCalledTimes(1)
		expect(onAction).not.toHaveBeenCalled()
	})

	it("takes a description the user hasn't left yet with the keep", () => {
		const { onKeep, onAction } = renderDraft()
		const field = screen.getByLabelText("Skill description")
		fireEvent.focus(field)
		fireEvent.change(field, { target: { value: "Before every release" } })
		const keep = screen.getByRole("button", { name: "Keep release-checklist" })
		// Pressing Keep must not blur the field (its own save would race the keep).
		expect(fireEvent.mouseDown(keep)).toBe(false)
		fireEvent.click(keep)
		expect(onKeep).not.toHaveBeenCalled()
		expect(onAction).toHaveBeenCalledWith(
			"skill_target_keep",
			expect.objectContaining({ description: "Before every release", name: "release-checklist", isGlobal: true }),
		)
	})
})

describe("OpenedSkillDraft body", () => {
	const steps = Array.from({ length: 40 }, (_, i) => `${i + 1}. Check item ${i + 1}.`)
	const edit = {
		op: "update",
		slug: "workflow-release",
		name: "release",
		description: "",
		content: steps.join("\n").replace("20. Check item 20.", "20. Check item 20, then tag it."),
		diff: [
			{ kind: "collapsed", text: steps.slice(0, 16).join("\n") },
			...steps.slice(16, 19).map((text) => ({ kind: "context", text })),
			{ kind: "remove", text: "20. Check item 20." },
			{ kind: "add", text: "20. Check item 20, then tag it." },
			...steps.slice(20, 23).map((text) => ({ kind: "context", text })),
			{ kind: "collapsed", text: steps.slice(23).join("\n") },
		],
		skill: { kind: "workflow", scope: "global", targetPath: "/w/release.md" },
	} as NotebookChange

	it("opens an edit on what changed, in a capped scroll box, with the whole workflow a click away", () => {
		render(
			<OpenedSkillDraft change={edit} hasWorkspace onAction={vi.fn()} onDrop={vi.fn()} onKeep={vi.fn()} sending={false} />,
		)
		expect(screen.getByTestId("skill-draft-body")).toHaveClass("max-h-[50vh]", "overflow-y-auto")
		expect(screen.getByTestId("notebook-diff")).toBeInTheDocument()
		expect(screen.queryByTestId("marked-note")).not.toBeInTheDocument()
		// Only the words the edit added are highlighted.
		expect(screen.getByText(", then tag it").tagName).toBe("MARK")
		// Long unchanged runs fold and open in place.
		const fold = screen.getByRole("button", { name: "Show 17 unchanged lines" })
		// The ⋯ sits in the +/− gutter.
		expect(fold).toHaveTextContent(/^⋯\s*17 unchanged lines$/)
		fireEvent.click(fold)
		expect(screen.getByText("40. Check item 40.")).toBeInTheDocument()

		fireEvent.click(screen.getByRole("button", { name: "Show whole workflow" }))
		expect(screen.getByTestId("marked-note")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Show changes" }))
		expect(screen.getByTestId("notebook-diff")).toBeInTheDocument()
	})

	it("shows a new workflow whole: it's all new", () => {
		render(
			<OpenedSkillDraft
				change={change}
				hasWorkspace
				onAction={vi.fn()}
				onDrop={vi.fn()}
				onKeep={vi.fn()}
				sending={false}
			/>,
		)
		expect(screen.getByTestId("marked-note")).toBeInTheDocument()
		expect(screen.queryByRole("button", { name: /Show whole/ })).not.toBeInTheDocument()
	})
})
