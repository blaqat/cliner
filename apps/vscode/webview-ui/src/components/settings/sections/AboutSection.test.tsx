import { fireEvent, render, screen, within } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import AboutSection from "./AboutSection"
import { PICTURE_KEYS } from "./about/AboutPictures"
import { buildShortcuts, FEATURE_GROUPS, IMPROVEMENT_GROUPS, UPSTREAM_CLINE_VERSION } from "./about/aboutContent"
import { RELEASE_NOTES } from "./about/releaseNotes"

const mocks = vi.hoisted(() => ({ platform: "darwin", enterSendsAs: "steer" }))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ platform: mocks.platform, enterSendsAs: mocks.enterSendsAs }),
}))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}))

const renderAbout = () => render(<AboutSection renderSectionHeader={() => null} version="4.1.22-fork.24" />)

describe("AboutSection", () => {
	beforeEach(() => {
		mocks.platform = "darwin"
		mocks.enterSendsAs = "steer"
	})

	it("shows the fork name, extension version and upstream base", () => {
		renderAbout()
		expect(screen.getByText(/Cline \(Fork\)/)).toBeTruthy()
		expect(screen.getByTestId("about-version").textContent).toBe(`v4.1.22-fork.24 · based on Cline ${UPSTREAM_CLINE_VERSION}`)
	})

	it("renders both tabs and switches between them", () => {
		renderAbout()
		expect(screen.getByRole("tab", { name: "Features" }).getAttribute("aria-selected")).toBe("true")
		expect(screen.getByTestId("about-features")).toBeTruthy()
		expect(screen.queryByTestId("about-improvements")).toBeNull()

		fireEvent.click(screen.getByRole("tab", { name: "Improvements & fixes" }))
		expect(screen.getByRole("tab", { name: "Improvements & fixes" }).getAttribute("aria-selected")).toBe("true")
		expect(screen.queryByTestId("about-features")).toBeNull()
		for (const group of IMPROVEMENT_GROUPS) {
			const section = screen.getByTestId(`about-fixes-${group.id}`)
			expect(within(section).getByText(group.title)).toBeTruthy()
			expect(within(section).getAllByRole("listitem")).toHaveLength(group.items.length)
		}
		expect(screen.getByText(/⌘K \/ Ctrl\+K is claimed while Cline is focused/)).toBeTruthy()
		expect(screen.getByText(/⌘ shortcuts use Ctrl on Windows and Linux/)).toBeTruthy()
	})

	it("renders every feature group with its pictures", () => {
		renderAbout()
		expect(FEATURE_GROUPS.map((g) => g.title)).toEqual(
			expect.arrayContaining([
				"Threads & inbox",
				"Tasks & notebook",
				"References",
				"Tags",
				"Search",
				"Subagents",
				"Ask mode",
				"Configurations",
				"Composer",
				"Toasts & Back",
				"Profiles",
				"Terminal environment",
				"Worktrees",
				"Change walkthrough",
				"Scripts",
				"MCP & hooks",
			]),
		)
		for (const group of FEATURE_GROUPS) {
			const section = screen.getByTestId(`about-group-${group.id}`)
			expect(within(section).getByText(group.title)).toBeTruthy()
			const rows = within(section).getAllByRole("listitem")
			expect(rows).toHaveLength(group.items.length)
			group.items.forEach((item, index) => {
				expect(within(rows[index]).getByText(item.text)).toBeTruthy()
				expect(item.pictures.length).toBeGreaterThan(0)
				expect(within(rows[index]).getAllByRole("img")).toHaveLength(item.pictures.length)
				for (const picture of item.pictures) {
					expect(within(rows[index]).getByTestId(`about-picture-${picture}`)).toBeTruthy()
				}
			})
		}
	})

	it("has a picture for every key used in the feature list, with no Show me links", () => {
		renderAbout()
		const used = FEATURE_GROUPS.flatMap((g) => g.items.flatMap((i) => i.pictures))
		for (const key of used) {
			expect(PICTURE_KEYS).toContain(key)
		}
		expect(screen.queryByText("Show me")).toBeNull()
	})

	it("mentions Azure on the Responses endpoint and the Scripts line", () => {
		renderAbout()
		expect(screen.getByText(/Azure: newer models that need the Responses endpoint work/)).toBeTruthy()
		expect(screen.getByText("Saved commands with typed options, run by you or the agent")).toBeTruthy()
	})

	it("labels shortcuts with ⌘ on macOS", () => {
		renderAbout()
		const table = within(screen.getByTestId("about-shortcuts"))
		expect(table.getByText("⌘+K")).toBeTruthy()
		expect(table.getByText("⌘+Shift+A")).toBeTruthy()
		expect(table.getByText("⌘+'")).toBeTruthy()
		expect(table.getByText("⌥+Enter")).toBeTruthy()
		expect(table.getAllByText("⌘+Enter").length).toBe(2)
		expect(table.queryByText(/Ctrl/)).toBeNull()
	})

	it("labels shortcuts with Ctrl on Windows and Linux", () => {
		for (const platform of ["win32", "linux"]) {
			mocks.platform = platform
			const { unmount } = renderAbout()
			const table = within(screen.getByTestId("about-shortcuts"))
			expect(table.getByText("Ctrl+K")).toBeTruthy()
			expect(table.getByText("Ctrl+Shift+A")).toBeTruthy()
			expect(table.getByText("Ctrl+'")).toBeTruthy()
			expect(table.getByText("Alt+Enter")).toBeTruthy()
			expect(table.getAllByText("Ctrl+Enter").length).toBe(2)
			expect(table.queryByText(/⌘/)).toBeNull()
			unmount()
		}
	})

	it("follows the Enter setting for steer and interject", () => {
		mocks.enterSendsAs = "interject"
		renderAbout()
		const table = within(screen.getByTestId("about-shortcuts"))
		expect(table.getByText("While running: Interject")).toBeTruthy()
		expect(table.getByText("While running: Steer")).toBeTruthy()
	})

	it("buildShortcuts maps the keys onto the platform", () => {
		const rows = buildShortcuts({ mod: "Ctrl", alt: "Alt", toggleKeys: "Meta+Shift+a", enterSendsAs: "steer" })
		expect(rows.find((r) => r.id === "mode")?.keys).toBe("Ctrl+Shift+A")
		expect(rows.find((r) => r.id === "running")?.label).toBe("While running: Steer")
	})

	it("renders collapsible release notes from the data file", () => {
		renderAbout()
		const whatsNew = screen.getByTestId("about-whats-new")
		expect(screen.queryByTestId(`about-release-${RELEASE_NOTES[0].version}`)).toBeNull()

		fireEvent.click(within(whatsNew).getByRole("button", { name: /What's new/ }))
		for (const release of RELEASE_NOTES) {
			expect(screen.getByTestId(`about-release-${release.version}`)).toBeTruthy()
		}
		// The newest entry starts open, older ones start closed.
		const [newest, older] = RELEASE_NOTES
		expect(screen.getByText(newest.notes[0])).toBeTruthy()
		expect(screen.queryByText(older.notes[0])).toBeNull()
		fireEvent.click(within(screen.getByTestId(`about-release-${older.version}`)).getByRole("button"))
		expect(screen.getByText(older.notes[0])).toBeTruthy()
		expect(screen.getByText("upcoming")).toBeTruthy()
	})
})
