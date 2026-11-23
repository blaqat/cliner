import {
	NO_COMMITS,
	type ThreadWorktree,
	WORKTREES_OFF,
	WORKTREES_OFF_HERE,
	type WorktreeState,
	type WorktreeSummary,
} from "@shared/thread-worktrees"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TaskWorktreeSection, useTaskWorktree } from "./TaskWorktreeSection"
import { ThreadWorktreeActions, worktreeStatusText } from "./ThreadWorktreeActions"
import { WorktreeSettings } from "./WorktreeSettings"

const mocks = vi.hoisted(() => ({ action: vi.fn(), state: {} as WorktreeState, thread: 0 }))
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ currentTaskItem: { id: String(mocks.thread) } }),
}))
vi.mock("@/services/grpc-client", () => ({
	WorktreeServiceClient: { threadWorktreeAction: (request: unknown) => mocks.action(request) },
}))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ children, checked, disabled, onChange }: any) => (
		<label>
			<input checked={checked} disabled={disabled} onChange={onChange} type="checkbox" />
			{children}
		</label>
	),
}))
// Radix Select measures and captures the pointer; jsdom has neither.
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.scrollIntoView ??= () => {}
const mapping: ThreadWorktree = {
	threadId: "thread",
	mode: "git",
	branch: "cline/test",
	workspace: "/workspace",
	cwd: "/isolate",
	modules: [],
	createdAt: 1,
	bringIns: [],
}
beforeEach(() => {
	mocks.thread++
	mocks.state = {
		settings: { mode: "git", mmPath: "", nodePath: "node" },
		availability: { mode: "git", available: true, workspaceOff: false },
		settled: [],
	}
	mocks.action.mockReset().mockImplementation(async (request) => ({
		json: JSON.stringify(request.action === "state" ? { state: mocks.state } : {}),
	}))
})
const SUMMARY: WorktreeSummary = {
	changedFiles: 2,
	commits: 1,
	uncommittedFiles: 1,
	uncopiedFiles: 2,
	copied: false,
	canUndo: false,
	loseOnRemove: 2,
	workspaceDirty: false,
	takenOver: false,
}
/** Answers "summary" with `summary` (updated by `after`) and every other action with `results[action]`. */
function serve(summary: WorktreeSummary, results: Record<string, object | ((request: any) => object)> = {}) {
	let current = summary
	mocks.action.mockImplementation(async (request) => {
		if (request.action === "summary") return { json: JSON.stringify({ summary: current }) }
		const result = results[request.action]
		const value = typeof result === "function" ? result(request) : (result ?? {})
		if ("after" in value) current = (value as { after: WorktreeSummary }).after
		return { json: JSON.stringify(value) }
	})
}
const rowNames = () => screen.getAllByRole("menuitem").map((row) => row.textContent)
const status = () => screen.getByTestId("worktree-status")

it("only offers to open the home workspace when a task worktree belongs elsewhere", async () => {
	mocks.state = {
		...mocks.state,
		mapping: { ...mapping, taskGroupId: "task" },
		taskWorktreeElsewhere: true,
	}
	function Section() {
		const worktree = useTaskWorktree("task")
		return <TaskWorktreeSection refreshKey="" worktree={worktree} />
	}
	render(<Section />)
	const open = await screen.findByRole("button", { name: "Open its workspace" })
	expect(screen.queryByRole("menuitem", { name: /Copy changes here|Remove worktree/ })).toBeNull()
	fireEvent.click(open)
	await waitFor(() =>
		expect(mocks.action).toHaveBeenCalledWith(expect.objectContaining({ action: "openTaskWorkspace", taskGroupId: "task" })),
	)
})

it("reads the worktree again when the view regains focus, so edits made by hand show up", async () => {
	const clean = { ...SUMMARY, changedFiles: 0, commits: 0, uncommittedFiles: 0, uncopiedFiles: 0, loseOnRemove: 0 }
	serve(clean)
	const onChanged = vi.fn(async () => {})
	render(<ThreadWorktreeActions mapping={mapping} onChanged={onChanged} threadId="thread" />)
	await waitFor(() => expect(status()).toHaveTextContent("No changes yet"))
	serve(SUMMARY)
	fireEvent.focus(window)
	await waitFor(() => expect(status()).toHaveTextContent("2 files changed · 1 commit · not copied here"))
	// Another window may have replaced the worktree: the caller reads its state again too.
	expect(onChanged).toHaveBeenCalled()
})

it("says where the changes stand and lists only what applies", async () => {
	serve(SUMMARY)
	render(<ThreadWorktreeActions mapping={mapping} threadId="thread" />)
	await waitFor(() => expect(status()).toHaveTextContent("2 files changed · 1 commit · not copied here"))
	expect(screen.getByTestId("workspace-current")).toHaveTextContent("cline/test")
	// Nothing was copied, so there's nothing to undo.
	expect(rowNames()).toEqual([
		"Open in new window",
		"Copy changes here2 files",
		"Switch workspace to this branch",
		"Remove worktree",
	])
})

it("reports a copy on the status line with Undo, and only then lists Undo", async () => {
	const copied = { ...SUMMARY, uncopiedFiles: 0, copied: true, canUndo: true, loseOnRemove: 0, workspaceDirty: true }
	serve(SUMMARY, { bring: { message: "Copied 2 files into your workspace", files: 2, after: copied } })
	const onChanged = vi.fn(async () => {})
	render(<ThreadWorktreeActions mapping={mapping} onChanged={onChanged} threadId="thread" />)
	fireEvent.click(await screen.findByRole("menuitem", { name: /Copy changes here/ }))
	await waitFor(() => expect(status()).toHaveTextContent("Copied 2 files into your workspace·Undo"))
	expect(status()).toHaveAttribute("data-tone", "ok")
	expect(onChanged).toHaveBeenCalled()
	expect(rowNames()).toEqual(["Open in new window", "Undo the copy", "Switch workspace to this branch", "Remove worktree"])
	// The copy made the workspace dirty: switching says what to do first.
	expect(screen.getByRole("menuitem", { name: "Switch workspace to this branch" })).toBeDisabled()
	expect(screen.getByTestId("worktree-switch-hint")).toHaveTextContent("Undo the copy (or commit it) first")
	// No notice box: the menu is the same rows plus the hint.
	expect(screen.queryByRole("alert")).toBeNull()
})

it("links to Source Control when the workspace's own changes block switching", async () => {
	serve({ ...SUMMARY, workspaceDirty: true })
	const onClose = vi.fn()
	render(<ThreadWorktreeActions mapping={mapping} onClose={onClose} threadId="thread" />)
	const hint = await screen.findByTestId("worktree-switch-hint")
	expect(hint).toHaveTextContent("Workspace has uncommitted changes · Source Control")
	fireEvent.click(within(hint).getByRole("button", { name: "Source Control" }))
	expect(onClose).toHaveBeenCalled()
	expect(mocks.action).toHaveBeenCalledWith(expect.objectContaining({ action: "sourceControl" }))
})

it("shows the cache warning on the Remove row before discarding uncopied files", async () => {
	const warning = "vendor has a local branch (local-only) in this worktree. Preserve it before removing the worktree."
	serve(SUMMARY, {
		remove: (request) =>
			request.removalConfirmation === "reviewed"
				? { message: "Worktree removed" }
				: { warning, removalConfirmation: "reviewed" },
	})
	const onChanged = vi.fn(async () => {})
	render(<ThreadWorktreeActions mapping={mapping} onChanged={onChanged} threadId="thread" />)
	fireEvent.click(await screen.findByRole("menuitem", { name: "Remove worktree" }))
	const confirm = await screen.findByTestId("worktree-remove-confirm")
	expect(confirm).toHaveTextContent(warning)
	expect(mocks.action).toHaveBeenCalledWith(expect.objectContaining({ action: "remove", confirmed: false }))
	fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }))
	expect(screen.getByRole("menuitem", { name: "Remove worktree" })).toBeInTheDocument()
	fireEvent.click(screen.getByRole("menuitem", { name: "Remove worktree" }))
	fireEvent.click(within(await screen.findByTestId("worktree-remove-confirm")).getByRole("button", { name: "Remove" }))
	await waitFor(() => expect(mocks.action).toHaveBeenCalledWith(expect.objectContaining({ action: "remove", confirmed: true })))
	await waitFor(() => expect(onChanged).toHaveBeenCalled())
	expect(screen.queryByRole("dialog")).toBeNull()
})

it("when the worktree can't be read, says why, offers Try again, and still lets you remove it", async () => {
	let fail = true
	mocks.action.mockImplementation(async (request) => {
		if (request.action === "summary") {
			if (fail) throw new Error("Error: ENOENT: no such file or directory '/isolate'")
			return { json: JSON.stringify({ summary: SUMMARY }) }
		}
		return { json: JSON.stringify({ warning: "Couldn't check every submodule cache. Remove this worktree anyway?" }) }
	})
	render(<ThreadWorktreeActions mapping={mapping} threadId="thread" />)
	await waitFor(() => expect(status()).toHaveTextContent("Couldn't read this worktree: ENOENT: no such file or directory"))
	const remove = screen.getByRole("menuitem", { name: "Remove worktree" })
	expect(remove).toBeEnabled()
	fireEvent.click(remove)
	expect(await screen.findByTestId("worktree-remove-confirm")).toBeInTheDocument()
	fireEvent.click(within(screen.getByTestId("worktree-remove-confirm")).getByRole("button", { name: "Cancel" }))
	fail = false
	fireEvent.click(within(status()).getByRole("button", { name: "Try again" }))
	await waitFor(() => expect(status()).toHaveTextContent(worktreeStatusText(SUMMARY)))
})

it("removes without asking when nothing would be lost", async () => {
	serve({ ...SUMMARY, uncopiedFiles: 0, copied: true, loseOnRemove: 0 }, { remove: { message: "Worktree removed" } })
	render(<ThreadWorktreeActions mapping={mapping} threadId="thread" />)
	fireEvent.click(await screen.findByRole("menuitem", { name: "Remove worktree" }))
	await waitFor(() =>
		expect(mocks.action).toHaveBeenCalledWith(expect.objectContaining({ action: "remove", confirmed: false })),
	)
	expect(screen.queryByTestId("worktree-remove-confirm")).toBeNull()
})

it("after switching, says so and offers opening or removing the leftover folder", async () => {
	const switched = { ...SUMMARY, takenOver: true, loseOnRemove: 0, workspaceDirty: true }
	serve(SUMMARY, {
		takeOver: { message: "Your workspace is on this branch now, with its 1 uncommitted file", files: 1, after: switched },
	})
	render(<ThreadWorktreeActions mapping={mapping} threadId="thread" />)
	fireEvent.click(await screen.findByRole("menuitem", { name: "Switch workspace to this branch" }))
	await waitFor(() => expect(rowNames()).toEqual(["Open the leftover worktree", "Remove the leftover worktree folder"]))
	expect(status()).toHaveTextContent("Your workspace is on this branch now, with its 1 uncommitted file")
	expect(status()).toHaveAttribute("data-tone", "ok")
})

it("shows a blocked action's reason on the status line, not in a new box", async () => {
	serve(SUMMARY, {
		bring: () => {
			throw new Error("Error: Your workspace has its own changes to `file.txt` that clash with this thread's.")
		},
	})
	render(<ThreadWorktreeActions mapping={mapping} threadId="thread" />)
	fireEvent.click(await screen.findByRole("menuitem", { name: /Copy changes here/ }))
	await waitFor(() => expect(status()).toHaveAttribute("data-tone", "warning"))
	expect(status()).toHaveTextContent("Your workspace has its own changes to `file.txt` that clash with this thread's.")
	expect(status()).not.toHaveTextContent("Error:")
	expect(within(status()).getByRole("button", { name: "Source Control" })).toBeInTheDocument()
})

it("lists undo conflicts on the status line", async () => {
	serve({ ...SUMMARY, canUndo: true, copied: true }, { undo: { conflicts: ["api/file.ts"], message: "Undid the copy." } })
	render(<ThreadWorktreeActions mapping={mapping} threadId="thread" />)
	fireEvent.click(await screen.findByRole("menuitem", { name: "Undo the copy" }))
	await waitFor(() => expect(status()).toHaveTextContent("Undid the copy. api/file.ts"))
})

it("waits for a running thread before copying, switching or removing", async () => {
	serve({ ...SUMMARY, running: true })
	render(<ThreadWorktreeActions mapping={mapping} threadId="thread" />)
	await waitFor(() => expect(screen.getByRole("menuitem", { name: /Copy changes here/ })).toBeDisabled())
	expect(screen.getByRole("menuitem", { name: "Switch workspace to this branch" })).toBeDisabled()
	expect(screen.getByRole("menuitem", { name: "Remove worktree" })).toBeDisabled()
	expect(screen.getByTestId("worktree-switch-hint")).toHaveTextContent("Wait for the thread to finish")
})

describe("worktreeStatusText", () => {
	it("words each state", () => {
		expect(worktreeStatusText({ ...SUMMARY, changedFiles: 0, commits: 0, loseOnRemove: 0 })).toBe("No changes yet")
		expect(worktreeStatusText({ ...SUMMARY, changedFiles: 0, commits: 0, loseOnRemove: 1 })).toBe(
			"Staged changes not copied here",
		)
		expect(worktreeStatusText({ ...SUMMARY, changedFiles: 1, commits: 0, uncopiedFiles: 1 })).toBe(
			"1 file changed · not copied here",
		)
		expect(worktreeStatusText({ ...SUMMARY, uncopiedFiles: 0, copied: true })).toBe(
			"2 files changed · 1 commit · copied here",
		)
		expect(worktreeStatusText({ ...SUMMARY, uncopiedFiles: 1, copied: true })).toBe(
			"2 files changed · 1 commit · 1 not copied yet",
		)
	})
})
/** Serves "state" from mocks.state; configure and workspaceOff change it the way the host would. */
function serveSettings() {
	mocks.action.mockImplementation(async (request) => {
		const data = request.json ? JSON.parse(request.json) : {}
		if (request.action === "configure") {
			// A save names only what changed; the host merges it into what it has.
			const settings = { ...mocks.state.settings, ...data }
			mocks.state = {
				...mocks.state,
				settings,
				mmFound: settings.mmPath ? settings.mmPath === "/tools/mm.js" : undefined,
				availability: {
					...mocks.state.availability,
					mode: settings.mode,
					available: settings.mode !== "off",
					reason: settings.mode === "off" ? WORKTREES_OFF : undefined,
				},
			}
		}
		if (request.action === "workspaceOff")
			mocks.state = {
				...mocks.state,
				availability: {
					...mocks.state.availability,
					workspaceOff: data.disabled,
					available: !data.disabled,
					reason: data.disabled ? WORKTREES_OFF_HERE : undefined,
				},
			}
		return { json: JSON.stringify(request.action === "state" ? { state: mocks.state } : {}) }
	})
}
const configured = () =>
	mocks.action.mock.calls.filter(([request]) => request.action === "configure").map(([request]) => JSON.parse(request.json))

describe("WorktreeSettings", () => {
	it.each([true, false])("shows where mm runs when availability is %s", async (available) => {
		const cwd = "C:\\Users\\Example\\Project"
		const config = cwd + "\\.mmrc"
		mocks.state = {
			...mocks.state,
			settings: { mode: "mm", mmPath: "C:\\Tools\\mm.js", nodePath: "node" },
			mmFound: true,
			availability: {
				mode: "mm",
				available,
				workspaceOff: false,
				mmCwd: cwd,
				...(available ? { mmConfigPath: config, modules: ["api"] } : { reason: "Couldn't run Node." }),
			},
		}
		serveSettings()
		render(<WorktreeSettings />)
		expect(await screen.findByTitle(cwd)).toHaveTextContent(cwd)
		expect(screen.queryByTitle(config)?.textContent).toBe(available ? `Config file ${config}` : undefined)
		expect(screen.getByTestId("worktrees-status")).toHaveTextContent(available ? "Ready." : "Couldn't run Node.")
	})

	it("saves the mode as it changes and paths on Enter or leaving the box, with no Save button", async () => {
		serveSettings()
		render(<WorktreeSettings />)
		fireEvent.keyDown(await screen.findByRole("combobox", { name: "Worktrees mode" }), { key: "Enter" })
		fireEvent.keyDown(await screen.findByRole("option", { name: "mm" }), { key: "Enter" })
		await waitFor(() => expect(configured()).toEqual([{ mode: "mm" }]))
		expect(screen.queryByText(/Save worktree settings/)).toBeNull()

		const mmPath = await screen.findByLabelText("Path to mm.js")
		expect(screen.getByTestId("worktrees-mm-found")).toHaveTextContent("Set the path to mm.js to use mm.")
		fireEvent.change(mmPath, { target: { value: "/tools/missing.js" } })
		fireEvent.keyDown(mmPath, { key: "Enter" })
		await waitFor(() =>
			expect(screen.getByTestId("worktrees-mm-found")).toHaveTextContent("Couldn't find mm.js at /tools/missing.js."),
		)
		fireEvent.change(mmPath, { target: { value: " /tools/mm.js " } })
		fireEvent.blur(mmPath)
		await waitFor(() => expect(screen.getByTestId("worktrees-mm-found")).toHaveTextContent("Found mm.js."))
		expect(configured().at(-1)).toEqual({ mmPath: "/tools/mm.js" })

		// Escape puts back the saved path; leaving an unchanged box saves nothing.
		const saves = configured().length
		fireEvent.change(mmPath, { target: { value: "/elsewhere" } })
		fireEvent.keyDown(mmPath, { key: "Escape" })
		expect(mmPath).toHaveValue("/tools/mm.js")
		fireEvent.blur(mmPath)
		const node = screen.getByLabelText("Path to node")
		fireEvent.change(node, { target: { value: "/usr/local/bin/node" } })
		fireEvent.blur(node)
		await waitFor(() => expect(configured().at(-1)).toEqual({ nodePath: "/usr/local/bin/node" }))
		expect(configured()).toHaveLength(saves + 1)
	})

	it("keeps a path typed while the last one is still saving", async () => {
		serveSettings()
		const serve = mocks.action.getMockImplementation()!
		let finish!: () => void
		mocks.action.mockImplementation(async (request) => {
			if (request.action !== "configure") return serve(request)
			await new Promise<void>((resolve) => {
				finish = resolve
			})
			return serve(request)
		})
		mocks.state = { ...mocks.state, settings: { mode: "mm", mmPath: "/tools/mm.js", nodePath: "node" } }
		render(<WorktreeSettings />)
		const node = await screen.findByLabelText("Path to node")
		fireEvent.change(node, { target: { value: "/first/node" } })
		fireEvent.blur(node)
		await waitFor(() => expect(configured()).toHaveLength(1))
		// The save hasn't come back yet; the user keeps typing.
		fireEvent.change(node, { target: { value: "/second/node" } })
		finish()
		await waitFor(() => expect(screen.getByLabelText("Path to node")).toBeEnabled())
		expect(screen.getByLabelText("Path to node")).toHaveValue("/second/node")
		// Leaving the box saves what was typed after.
		fireEvent.blur(screen.getByLabelText("Path to node"))
		await waitFor(() => expect(configured()).toHaveLength(2))
		finish()
		expect(configured().at(-1)).toEqual({ nodePath: "/second/node" })
	})

	it("with Mode off says so instead of offering the workspace switch, and offers mm in an mm folder", async () => {
		mocks.state = {
			...mocks.state,
			settings: { mode: "off", mmPath: "", nodePath: "node" },
			availability: { mode: "off", available: false, workspaceOff: false, reason: WORKTREES_OFF, fix: "mode" },
			mmConfigFile: ".mmrc",
		}
		serveSettings()
		render(<WorktreeSettings />)
		expect(await screen.findByTestId("worktrees-status")).toHaveTextContent(WORKTREES_OFF)
		expect(screen.queryByLabelText("Use worktrees in this workspace")).toBeNull()
		expect(screen.getByTestId("worktrees-mm-hint")).toHaveTextContent("This folder is an mm workspace (.mmrc).")
		fireEvent.click(screen.getByRole("button", { name: "Use mm" }))
		await waitFor(() => expect(configured()).toEqual([{ mode: "mm" }]))
		// mm.js still needs its path: the path box takes focus and says so; the hint has done its job.
		await waitFor(() => expect(screen.getByLabelText("Path to mm.js")).toHaveFocus())
		expect(screen.getByTestId("worktrees-mm-found")).toHaveTextContent("Set the path to mm.js to use mm.")
		expect(screen.queryByTestId("worktrees-mm-hint")).toBeNull()
	})

	it("says on means on for this workspace, keeping the stored off state's meaning", async () => {
		// Stored before this wording: worktreeToggles.disabled = true.
		mocks.state = {
			...mocks.state,
			availability: { mode: "off", available: false, workspaceOff: true, reason: WORKTREES_OFF_HERE, fix: "workspace" },
		}
		serveSettings()
		render(<WorktreeSettings />)
		const toggle = await screen.findByRole("switch", { name: "Use worktrees in this workspace" })
		expect(toggle).not.toBeChecked()
		expect(screen.getByTestId("worktrees-status")).toHaveTextContent(WORKTREES_OFF_HERE)
		fireEvent.click(toggle)
		await waitFor(() =>
			expect(mocks.action).toHaveBeenCalledWith(
				expect.objectContaining({ action: "workspaceOff", json: JSON.stringify({ disabled: false }) }),
			),
		)
		await waitFor(() => expect(toggle).toBeChecked())
		expect(screen.getByTestId("worktrees-status")).toHaveTextContent("Ready. Pick New worktree under the message box")
	})

	// The Settings shell highlights the row a link points at; the row then lands on what fixes things now.
	const renderAsLinkTarget = () => {
		const row = document.createElement("div")
		row.id = "setting-tools-worktrees"
		document.body.append(row)
		const view = render(<WorktreeSettings />, { container: row })
		row.classList.add("settings-target-highlight")
		return { ...view, row }
	}

	it.each([
		[
			"this workspace's switch",
			{ workspaceOff: true, reason: WORKTREES_OFF_HERE, fix: "workspace" as const },
			"switch",
			"Use worktrees in this workspace",
		],
		[
			"the mm.js path",
			{ reason: "Couldn't find mm.js. mm.js path: /x/mm.js", fix: "mm" as const },
			"textbox",
			"Path to mm.js",
		],
	])("a link lands on %s once its settings have loaded", async (_, availability, role, name) => {
		mocks.state = {
			...mocks.state,
			settings: { mode: availability.fix === "mm" ? "mm" : "git", mmPath: "", nodePath: "node" },
			availability: { mode: "git", available: false, workspaceOff: false, ...availability },
		}
		const { row } = renderAsLinkTarget()
		await waitFor(() => expect(screen.getByRole(role, { name })).toHaveFocus())
		row.remove()
	})

	it("a link lands on Use mm when worktrees are off in an mm folder, and nowhere without a link", async () => {
		mocks.state = {
			...mocks.state,
			settings: { mode: "off", mmPath: "", nodePath: "node" },
			availability: { mode: "off", available: false, workspaceOff: false, reason: WORKTREES_OFF, fix: "mode" },
			mmConfigFile: ".mm.json",
		}
		const { unmount } = render(<WorktreeSettings />)
		await screen.findByRole("button", { name: "Use mm" })
		expect(document.activeElement).toBe(document.body)
		unmount()
		const { row } = renderAsLinkTarget()
		await waitFor(() => expect(screen.getByRole("button", { name: "Use mm" })).toHaveFocus())
		row.remove()
	})

	it("picking a mode from Off also turns this workspace back on", async () => {
		mocks.state = {
			...mocks.state,
			settings: { mode: "off", mmPath: "", nodePath: "node" },
			availability: { mode: "off", available: false, workspaceOff: true, reason: WORKTREES_OFF, fix: "mode" },
		}
		serveSettings()
		render(<WorktreeSettings />)
		expect(await screen.findByTestId("worktrees-status")).toHaveTextContent(WORKTREES_OFF)
		fireEvent.keyDown(screen.getByRole("combobox", { name: "Worktrees mode" }), { key: "Enter" })
		fireEvent.keyDown(await screen.findByRole("option", { name: "Git worktree" }), { key: "Enter" })
		await waitFor(() => expect(screen.getByTestId("worktrees-status")).toHaveTextContent("Ready."))
		expect(configured()).toEqual([{ mode: "git" }])
		expect(mocks.action).toHaveBeenCalledWith(
			expect.objectContaining({ action: "workspaceOff", json: JSON.stringify({ disabled: false }) }),
		)
		expect(screen.getByRole("switch", { name: "Use worktrees in this workspace" })).toBeChecked()
	})

	it("names mm's modules when ready, and links git problems to Source Control", async () => {
		mocks.state = {
			...mocks.state,
			availability: { mode: "mm", available: true, workspaceOff: false, modules: ["api", "web"] },
		}
		const { unmount } = render(<WorktreeSettings />)
		expect(await screen.findByTestId("worktrees-status")).toHaveTextContent(
			"Ready. Pick New worktree under the message box to start a thread in mm worktrees of api, web.",
		)
		unmount()
		mocks.state = {
			...mocks.state,
			availability: { mode: "git", available: false, workspaceOff: false, reason: NO_COMMITS, fix: "commit" },
		}
		render(<WorktreeSettings />)
		expect(await screen.findByTestId("worktrees-status")).toHaveTextContent(NO_COMMITS)
		fireEvent.click(screen.getByRole("button", { name: "Open Source Control" }))
		await waitFor(() => expect(mocks.action).toHaveBeenCalledWith(expect.objectContaining({ action: "openSourceControl" })))
	})

	it("provides selective settled-worktree cleanup", async () => {
		mocks.state.settled = [mapping, { ...mapping, threadId: "keep", branch: "cline/keep" }]
		render(<WorktreeSettings />)
		expect(await screen.findByText("2 settled worktrees")).toBeVisible()
		fireEvent.click(screen.getByRole("checkbox", { name: /cline\/test/ }))
		fireEvent.click(screen.getByText("Remove 1 selected"))
		await waitFor(() =>
			expect(mocks.action).toHaveBeenCalledWith(
				expect.objectContaining({ action: "remove", threadId: "thread", confirmed: false }),
			),
		)
		expect(mocks.action).not.toHaveBeenCalledWith(expect.objectContaining({ action: "remove", threadId: "keep" }))
	})
})
