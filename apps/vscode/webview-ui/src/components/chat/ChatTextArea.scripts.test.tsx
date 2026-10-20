import { RefreshedScripts, ScriptInfo, ScriptOptionInfo } from "@shared/proto/cline/file"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { useState } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { resetScriptsForTest } from "@/hooks/useScripts"
import ChatTextArea from "./ChatTextArea"

const mocks = vi.hoisted(() => ({ refreshScripts: vi.fn(), onScriptRun: vi.fn() }))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		mode: "act",
		apiConfiguration: {},
		openRouterModels: {},
		platform: "darwin",
		localWorkflowToggles: {},
		globalWorkflowToggles: {},
		remoteWorkflowToggles: {},
		remoteConfigSettings: undefined,
		navigateToSettingsModelPicker: vi.fn(),
		mcpServers: [],
	}),
}))
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ togglePlanActKeys: "Meta+Shift+a" }) }))
vi.mock("@/hooks/useNormalizedApiConfiguration", () => ({
	useNormalizedApiConfiguration: () => ({
		selectedProvider: "anthropic",
		selectedModelId: "model",
		selectedModelInfo: { supportsImages: true },
	}),
}))
vi.mock("@/services/grpc-client", () => ({
	FileServiceClient: {
		searchCommits: vi.fn(async () => ({ commits: [] })),
		searchFiles: vi.fn(async () => ({ results: [] })),
		getRelativePaths: vi.fn(async () => ({ paths: [] })),
		openImage: vi.fn(async () => ({})),
		openFile: vi.fn(async () => ({})),
		refreshScripts: (request: unknown) => mocks.refreshScripts(request),
		refreshRules: vi.fn(async () => ({})),
		refreshHooks: vi.fn(async () => ({})),
		refreshSkills: vi.fn(async () => ({})),
	},
	StateServiceClient: { togglePlanActModeProto: vi.fn(async () => ({})) },
	McpServiceClient: { getLatestMcpServers: vi.fn(async () => ({ mcpServers: [] })) },
}))
vi.mock("@/hooks/useRemoteConfigSettings", () => ({ default: () => ({ settings: [], isLoading: false }) }))

const scriptsResponse = () =>
	RefreshedScripts.create({
		workspaceScripts: [
			ScriptInfo.create({
				name: "test-module",
				description: "Run one module's tests",
				path: "/repo/.clinerules/scripts/test-module.md",
				enabled: true,
				approval: "ask_in_ask_mode",
				options: [
					ScriptOptionInfo.create({
						name: "module",
						kind: "choice",
						required: true,
						description: "Module to test",
						choices: ["api", "web"],
					}),
					ScriptOptionInfo.create({ name: "watch", kind: "flag", description: "Re-run on change" }),
				],
			}),
			ScriptInfo.create({
				name: "no-options",
				description: "Runs with nothing to set",
				path: "/repo/.clinerules/scripts/no-options.md",
				enabled: true,
				approval: "always_allow",
			}),
			ScriptInfo.create({
				name: "off-script",
				description: "Switched off",
				path: "/repo/.clinerules/scripts/off.md",
				enabled: false,
				approval: "always_allow",
			}),
		],
	})

function Harness({ initial = "", onSend }: { initial?: string; onSend: () => void }) {
	const [value, setValue] = useState(initial)
	return (
		<ChatTextArea
			inputValue={value}
			onScriptRun={mocks.onScriptRun}
			onSelectFilesAndImages={vi.fn()}
			onSend={onSend}
			placeholderText="Type a message"
			selectedFiles={[]}
			selectedImages={[]}
			sendingDisabled={false}
			setInputValue={setValue}
			setSelectedFiles={vi.fn()}
			setSelectedImages={vi.fn()}
			shouldDisableFilesAndImages={false}
		/>
	)
}

async function renderComposer(initial = "") {
	const onSend = vi.fn()
	render(<Harness initial={initial} onSend={onSend} />)
	const textarea = screen.getByPlaceholderText("Type a message") as HTMLTextAreaElement
	await waitFor(() => expect(mocks.refreshScripts).toHaveBeenCalled())
	// Let the shared script list settle into the composer.
	await act()
	return { onSend, textarea }
}

const act = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function type(textarea: HTMLTextAreaElement, value: string) {
	fireEvent.change(textarea, { target: { value, selectionStart: value.length, selectionEnd: value.length } })
}

describe("ChatTextArea scripts", () => {
	beforeEach(() => {
		resetScriptsForTest()
		mocks.onScriptRun.mockReset()
		mocks.refreshScripts.mockReset().mockResolvedValue(scriptsResponse())
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		)
	})

	it("lists enabled scripts in the slash menu next to workflows", async () => {
		const { textarea } = await renderComposer()
		type(textarea, "/")
		const menu = await screen.findByTestId("slash-commands-menu")
		expect(menu).toHaveTextContent("Scripts")
		expect(menu).toHaveTextContent("/test-module")
		expect(menu).toHaveTextContent("Run one module's tests")
		expect(menu).toHaveTextContent("/no-options")
		expect(menu).not.toHaveTextContent("off-script")
	})

	it("offers scripts only when the slash starts the message", async () => {
		const { textarea } = await renderComposer()
		type(textarea, "please run /")
		const menu = await screen.findByTestId("slash-commands-menu")
		expect(menu).not.toHaveTextContent("test-module")
	})

	it("choosing a script from the menu starts a draft and shows the options helper", async () => {
		const { textarea } = await renderComposer()
		type(textarea, "/test-m")
		await screen.findByTestId("slash-commands-menu")
		fireEvent.keyDown(textarea, { key: "Enter" })
		await waitFor(() => expect(textarea.value).toBe("/test-module "))
		const helper = await screen.findByTestId("script-helper")
		expect(helper).toHaveTextContent("test-module")
		expect(screen.getByTestId("script-option-module")).toHaveTextContent("required")
		expect(screen.getByTestId("script-option-watch")).toHaveTextContent("optional")
	})

	it("reports a typed script run only once it is complete and valid", async () => {
		const { textarea } = await renderComposer()
		type(textarea, "/test-module ")
		expect(mocks.onScriptRun).toHaveBeenLastCalledWith(undefined)
		type(textarea, "/test-module module:api watch")
		expect(mocks.onScriptRun).toHaveBeenLastCalledWith({ name: "test-module", values: { module: "api", watch: true } })
		type(textarea, "please /test-module module:api")
		expect(mocks.onScriptRun).toHaveBeenLastCalledWith(undefined)
	})

	it("reports the script run when the user picks the script from the menu", async () => {
		const { textarea } = await renderComposer()
		type(textarea, "/no-")
		await screen.findByTestId("slash-commands-menu")
		fireEvent.keyDown(textarea, { key: "Enter" })
		await waitFor(() => expect(textarea.value).toBe("/no-options "))
		expect(mocks.onScriptRun).toHaveBeenLastCalledWith({ name: "no-options", values: {} })
	})

	it("does not report a run for a draft the user never edited", async () => {
		await renderComposer("/test-module module:api")
		await screen.findByTestId("script-helper")
		expect(mocks.onScriptRun).not.toHaveBeenCalled()
	})

	it("does not show the helper for ordinary messages", async () => {
		const { textarea } = await renderComposer()
		type(textarea, "just a message")
		expect(screen.queryByTestId("script-helper")).not.toBeInTheDocument()
	})

	it("blocks send with a hint while a required option is missing, then sends", async () => {
		const { onSend, textarea } = await renderComposer("/test-module ")
		expect(await screen.findByTestId("script-helper-status")).toHaveTextContent("Needs module")
		fireEvent.keyDown(textarea, { key: "Enter" })
		expect(onSend).not.toHaveBeenCalled()
		expect(screen.getByTestId("send-button")).toHaveClass("disabled")
		fireEvent.click(screen.getByTestId("send-button"))
		expect(onSend).not.toHaveBeenCalled()

		type(textarea, "/test-module module:api")
		expect(screen.getByTestId("script-helper-status")).toHaveTextContent("Ready")
		fireEvent.keyDown(textarea, { key: "Enter" })
		expect(onSend).toHaveBeenCalledTimes(1)
	})

	it("blocks send for an unknown option or a choice that isn't declared", async () => {
		const { onSend, textarea } = await renderComposer("/test-module module:zzz")
		await screen.findByTestId("script-helper")
		fireEvent.keyDown(textarea, { key: "Enter" })
		expect(onSend).not.toHaveBeenCalled()
		type(textarea, "/test-module module:api bogus")
		fireEvent.keyDown(textarea, { key: "Enter" })
		expect(onSend).not.toHaveBeenCalled()
	})

	it("sends a script without options straight away", async () => {
		const { onSend, textarea } = await renderComposer("/no-options ")
		await screen.findByTestId("script-helper")
		fireEvent.keyDown(textarea, { key: "Enter" })
		expect(onSend).toHaveBeenCalledTimes(1)
	})

	it("Tab jumps to the next missing required option, then completes it", async () => {
		const { textarea } = await renderComposer("/test-module ")
		await screen.findByTestId("script-helper")
		fireEvent.keyDown(textarea, { key: "Tab" })
		expect(textarea.value).toBe("/test-module module:")
		fireEvent.keyDown(textarea, { key: "Tab" })
		expect(textarea.value).toBe("/test-module module:api ")
		type(textarea, "/test-module module:api wa")
		fireEvent.keyDown(textarea, { key: "Tab" })
		expect(textarea.value).toBe("/test-module module:api watch ")
	})

	it("filters the helper as the user types and fills a clicked choice", async () => {
		const { textarea } = await renderComposer("/test-module ")
		await screen.findByTestId("script-helper")
		type(textarea, "/test-module module:w")
		expect(screen.getByTestId("script-choice-module-web")).toBeInTheDocument()
		expect(screen.queryByTestId("script-choice-module-api")).not.toBeInTheDocument()
		fireEvent.click(screen.getByTestId("script-choice-module-web"))
		expect(textarea.value).toBe("/test-module module:web ")
	})

	it("starts a script draft from the rules button's Scripts tab, keeping what was typed as a note", async () => {
		const { textarea } = await renderComposer("then fix the failures")
		fireEvent.click(screen.getByTestId("rules-button"))
		fireEvent.click(within(screen.getByTestId("rules-panel")).getByRole("button", { name: "Scripts" }))
		fireEvent.click(await screen.findByTestId("script-use-test-module"))
		await waitFor(() => expect(textarea.value).toBe("/test-module \nthen fix the failures"))
		expect(screen.queryByTestId("rules")).not.toBeInTheDocument()
		expect(await screen.findByTestId("script-helper")).toBeInTheDocument()
	})
})
