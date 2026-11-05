import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ThreadCwdTag } from "./ThreadCwdTag"

const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))

describe("ThreadCwdTag", () => {
	beforeEach(() => {
		mocks.state = { workspaceRoots: [{ path: "/work/here", vcs: "git" }], platform: "darwin" }
	})

	it("names the folder of a thread outside what's open, with the full path on hover", () => {
		render(<ThreadCwdTag cwd="/work/other/api" />)
		expect(screen.getByTestId("thread-cwd-tag")).toHaveTextContent("api")
		expect(screen.getByTestId("thread-cwd-tag").title).toContain("/work/other/api")
	})

	it.each([
		["the open folder", "/work/here"],
		["a folder inside it", "/work/here/packages/app"],
		["a worktree inside it", "/work/here/.worktrees/thread-1"],
		["nowhere known", ""],
		["nowhere recorded", undefined],
	])("says nothing for a thread in %s", (_where, cwd) => {
		render(<ThreadCwdTag cwd={cwd} />)
		expect(screen.queryByTestId("thread-cwd-tag")).toBeNull()
	})

	it("doesn't call out a sibling that only shares a prefix as inside", () => {
		render(<ThreadCwdTag cwd="/work/here-too" />)
		expect(screen.getByTestId("thread-cwd-tag")).toHaveTextContent("here-too")
	})

	it("says nothing until it knows what's open, rather than flagging every row", () => {
		mocks.state = { workspaceRoots: [], platform: "darwin" }
		render(<ThreadCwdTag cwd="/work/other" />)
		expect(screen.queryByTestId("thread-cwd-tag")).toBeNull()
	})

	it("checks every folder in a multi-root window", () => {
		mocks.state = { workspaceRoots: [{ path: "/a" }, { path: "/b" }], platform: "darwin" }
		render(<ThreadCwdTag cwd="/b/src" />)
		expect(screen.queryByTestId("thread-cwd-tag")).toBeNull()
	})
})
