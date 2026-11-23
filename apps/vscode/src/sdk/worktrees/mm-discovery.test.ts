import { execFile } from "node:child_process"
import { expect, it, vi } from "vitest"
import { worktreePaths } from "@/utils/worktree-paths"
import { readMmWorkspace } from "./mm-discovery"

vi.mock("node:child_process", () => ({ execFile: vi.fn() }))
vi.mock("./repositories", () => ({ exists: async () => true }))

it("passes the canonical working directory to the mm subprocess on Windows", async () => {
	const failure = Object.assign(new Error("no config"), {
		stdout: JSON.stringify({ error: { code: "NO_CONFIG", message: "No config" } }),
	})
	vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
		const callback = args.at(-1) as (error: Error) => void
		callback(failure)
		return {} as ReturnType<typeof execFile>
	})
	await expect(
		readMmWorkspace(
			"z:\\Junction",
			{ mode: "mm", mmPath: "mm.js", nodePath: "node" },
			worktreePaths("win32", async () => "C:\\Users\\Example\\Project"),
		),
	).resolves.toBeUndefined()
	expect(execFile).toHaveBeenCalledWith(
		"node",
		["mm.js", "modules", "--json"],
		{ cwd: "C:\\Users\\Example\\Project", timeout: 10000 },
		expect.any(Function),
	)
})
