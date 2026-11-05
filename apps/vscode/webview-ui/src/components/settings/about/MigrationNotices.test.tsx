import { BASE_URL_NEEDED, MODEL_ID_NEEDED, type ModelSettings } from "@shared/model-settings"
import type { ModelSettingsMigrationIssue } from "@shared/model-settings-migration-status"
import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { MigrationIssues, migrationIssueRow } from "./MigrationNotices"

const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown>, openRow: vi.fn() }))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("../shell/SettingsShellContext", () => ({ useSettingsShell: () => ({ openRow: mocks.openRow }) }))
vi.mock("@/services/grpc-client", () => ({ ModelsServiceClient: {} }))

const settings = (upstreamId: string, baseUrl: string) =>
	({
		connections: [{ id: "c", baseUrl }],
		models: [{ id: "m", connectionId: "c", upstreamId }],
	}) as unknown as ModelSettings
const issue = (over: Partial<ModelSettingsMigrationIssue>): ModelSettingsMigrationIssue => ({
	kind: "normalized",
	field: "modelId",
	source: "Local",
	modelId: "m",
	connectionId: "c",
	...over,
})

describe("a flagged row", () => {
	it("says the model ID is needed and links to the field", () => {
		expect(migrationIssueRow(issue({}), settings(MODEL_ID_NEEDED, "https://a.test"))).toEqual({
			text: "Local: no model ID was saved, so it can't run.",
			action: "Add the model ID",
			target: "model:m:upstreamId",
		})
	})
	it("says the base URL is needed and links to the connection", () => {
		expect(migrationIssueRow(issue({ field: "baseUrl" }), settings("real", BASE_URL_NEEDED))).toMatchObject({
			action: "Enter the base URL",
			target: "connection:c",
		})
	})
	it("goes once it's fixed", () => {
		expect(migrationIssueRow(issue({}), settings("real", "https://a.test"))).toBeUndefined()
		expect(migrationIssueRow(issue({ field: "baseUrl" }), settings("real", "https://a.test"))).toBeUndefined()
	})
	it("says a lowered reasoning level moved, and links to the model's levels", () => {
		expect(migrationIssueRow(issue({ field: "level" }), settings("real", "https://a.test"))).toEqual({
			text: "Local: the saved reasoning level isn't offered by this model, so it moved to the closest lower one.",
			action: "Change it",
			target: "model:m:levels",
		})
	})
	it("goes once its row is removed", () => {
		expect(migrationIssueRow(issue({ modelId: "gone" }), settings("real", "https://a.test"))).toBeUndefined()
	})
})

describe("other issues", () => {
	const ok = settings("real", "https://a.test")
	it("a value that wasn't valid links to that field", () => {
		expect(migrationIssueRow(issue({ field: "contextWindow" }), ok)).toMatchObject({
			text: "Local: the saved context window wasn't valid, so it wasn't kept.",
			target: "model:m:contextWindow",
		})
	})
	it("a header that couldn't be kept links to its connection", () => {
		expect(migrationIssueRow(issue({ kind: "dropped", field: "header 2" }), ok)).toMatchObject({
			text: "Local: the saved header 2 couldn't be kept.",
			target: "connection:c",
		})
	})
	it("something with no row left links to Models", () => {
		const dropped: ModelSettingsMigrationIssue = { kind: "dropped", field: "provider", source: "Old one" }
		expect(migrationIssueRow(dropped, ok)).toEqual({
			text: "Old one: couldn't be moved.",
			action: "Set it up again",
			target: "models",
		})
	})
	it("a subagent value links to Subagents", () => {
		const capped: ModelSettingsMigrationIssue = { kind: "normalized", field: "subagentsMaxConcurrent", source: "Subagents" }
		expect(migrationIssueRow(capped, ok)).toMatchObject({ target: "subagents" })
	})
})

describe("the list", () => {
	beforeEach(() => {
		mocks.openRow.mockClear()
		mocks.state = { modelSettings: { settings: settings(MODEL_ID_NEEDED, "https://a.test") } }
	})
	it("shows each row with a link that lands on its fix", () => {
		render(<MigrationIssues issues={[issue({})]} />)
		fireEvent.click(screen.getByRole("button", { name: "Add the model ID" }))
		expect(mocks.openRow).toHaveBeenCalledWith("model:m:upstreamId")
	})
	it("isn't there with nothing to say", () => {
		const { container } = render(<MigrationIssues issues={[]} />)
		expect(container).toBeEmptyDOMElement()
	})
})
