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
