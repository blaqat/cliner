import { RefreshedScripts, ScriptInfo, ScriptOptionInfo } from "@shared/proto/cline/file"
import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { resetScriptsForTest, usableScripts, useScripts } from "../useScripts"

const mocks = vi.hoisted(() => ({ refreshScripts: vi.fn() }))
vi.mock("@/services/grpc-client", () => ({
	FileServiceClient: { refreshScripts: (request: unknown) => mocks.refreshScripts(request) },
}))

const info = (overrides: Partial<ScriptInfo>) =>
	ScriptInfo.create({ name: "a", description: "d", path: "/a.md", enabled: true, approval: "always_ask", ...overrides })

describe("useScripts", () => {
	beforeEach(() => {
		resetScriptsForTest()
		mocks.refreshScripts.mockReset()
	})

	it("loads scripts on mount and converts the options", async () => {
		mocks.refreshScripts.mockResolvedValue(
			RefreshedScripts.create({
				workspaceScripts: [
					info({
						options: [
							ScriptOptionInfo.create({
								name: "mod",
								kind: "choice",
								required: true,
								choices: ["api"],
								choicesFrom: "mmrc",
							}),
							ScriptOptionInfo.create({ name: "dry", kind: "flag", hasDefault: true, defaultValue: "true" }),
						],
					}),
				],
			}),
		)
		const { result } = renderHook(() => useScripts())
		await waitFor(() => expect(result.current.workspace).toHaveLength(1))
		expect(result.current.workspace[0].options).toEqual([
			{ name: "mod", kind: "choice", required: true, description: "", choices: ["api"], choicesFrom: "mmrc" },
			{ name: "dry", kind: "flag", required: false, description: "", default: true },
		])
	})

	it("keeps working when the extension can't list scripts", async () => {
		mocks.refreshScripts.mockRejectedValue(new Error("not a function"))
		const { result } = renderHook(() => useScripts())
		await waitFor(() => expect(mocks.refreshScripts).toHaveBeenCalled())
		expect(result.current).toEqual({ global: [], workspace: [] })
	})

	it("offers enabled, valid scripts once each, workspace first", () => {
		const entry = (name: string, extra = {}) => ({
			name,
			description: "",
			path: `/${name}.md`,
			scope: "workspace" as const,
			enabled: true,
			approval: "always_ask" as const,
			options: [],
			errors: [],
			...extra,
		})
		const usable = usableScripts({
			workspace: [entry("a"), entry("off", { enabled: false }), entry("bad", { errors: ["x"], approval: "" })],
			global: [entry("a", { scope: "global" }), entry("b", { scope: "global" })],
		})
		expect(usable.map((script) => [script.name, script.scope])).toEqual([
			["a", "workspace"],
			["b", "global"],
		])
	})
})
