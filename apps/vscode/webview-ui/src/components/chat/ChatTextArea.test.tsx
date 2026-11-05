import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { StateServiceClient } from "@/services/grpc-client"
import ChatTextArea from "./ChatTextArea"

const mocks = vi.hoisted(() => ({
	supportsImages: true as boolean | undefined,
	navigateToSettingsModelPicker: vi.fn(),
	state: {} as Record<string, unknown>,
}))

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
		navigateToSettingsModelPicker: mocks.navigateToSettingsModelPicker,
		mcpServers: [],
		...mocks.state,
	}),
}))

vi.mock("@/context/PlatformContext", () => ({
	usePlatform: () => ({ togglePlanActKeys: "Meta+Shift+a" }),
}))

vi.mock("@/hooks/useNormalizedApiConfiguration", () => ({
	useNormalizedApiConfiguration: () => ({
		selectedProvider: "anthropic",
		selectedModelId: "text-only-model",
		selectedModelInfo: { supportsImages: mocks.supportsImages },
	}),
}))

vi.mock("@/services/grpc-client", () => ({
	FileServiceClient: {
		searchCommits: vi.fn(async () => ({ commits: [] })),
		searchFiles: vi.fn(async () => ({ results: [] })),
		getRelativePaths: vi.fn(async () => ({ paths: [] })),
		openImage: vi.fn(async () => ({})),
		openFile: vi.fn(async () => ({})),
	},
	StateServiceClient: {
		togglePlanActModeProto: vi.fn(async () => ({})),
	},
}))

vi.mock("../cline-rules/ClineRulesToggleModal", () => ({ default: () => null }))
vi.mock("./ServersToggleModal", () => ({ default: () => null }))

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgo="

function renderTextArea(selectedImages: string[] = []) {
	const setSelectedImages = vi.fn()
	render(
		<ChatTextArea
			inputValue=""
			onSelectFilesAndImages={vi.fn()}
			onSend={vi.fn()}
			placeholderText="Type a message"
			selectedFiles={[]}
			selectedImages={selectedImages}
			sendingDisabled={false}
			setInputValue={vi.fn()}
			setSelectedFiles={vi.fn()}
			setSelectedImages={setSelectedImages}
			shouldDisableFilesAndImages={false}
		/>,
	)
	return { textarea: screen.getByPlaceholderText("Type a message"), setSelectedImages }
}

function pasteImage(target: HTMLElement) {
	const file = new File(["png"], "screenshot.png", { type: "image/png" })
	return fireEvent.paste(target, {
		clipboardData: {
			items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
			getData: () => "",
		},
	})
}

describe("ChatTextArea image attachments vs. model capability", () => {
	beforeEach(() => {
		mocks.supportsImages = true
		mocks.navigateToSettingsModelPicker.mockReset()
	})

	it("still takes the image attach path on paste for a text-only model, without a refusal message", () => {
		mocks.supportsImages = false
		const { textarea } = renderTextArea()

		const notCanceled = pasteImage(textarea)

		expect(notCanceled).toBe(false) // preventDefault: the paste was handled as an image, not as text
		expect(screen.queryByText(/ignored/)).not.toBeInTheDocument()
	})

	it("badges attached images and offers a model switch when the model is text-only", () => {
		mocks.supportsImages = false
		renderTextArea([PNG_DATA_URL, PNG_DATA_URL])

		const notice = screen.getByTestId("images-unsupported-notice")
		expect(notice).toHaveTextContent("text-only-model doesn't support images, so the 2 attached images will be ignored.")
		expect(screen.getAllByTestId("image-unsupported-badge")).toHaveLength(2)

		// A native button, so keyboard users get Enter/Space activation without extra handlers.
		const chooseModel = screen.getByRole("button", { name: "Choose an image-capable model" })
		expect(chooseModel.tagName).toBe("BUTTON")
		fireEvent.click(chooseModel)
		expect(mocks.navigateToSettingsModelPicker).toHaveBeenCalledWith({ targetSection: "models" })
	})

	it("uses singular wording for one image", () => {
		mocks.supportsImages = false
		renderTextArea([PNG_DATA_URL])

		expect(screen.getByTestId("images-unsupported-notice")).toHaveTextContent("the attached image will be ignored")
		expect(screen.getByTestId("images-unsupported-notice")).toHaveTextContent("or remove it.")
	})

	it("shows nothing extra when the model supports images", () => {
		renderTextArea([PNG_DATA_URL])

		expect(screen.queryByTestId("images-unsupported-notice")).not.toBeInTheDocument()
		expect(screen.queryByTestId("image-unsupported-badge")).not.toBeInTheDocument()
	})

	it("fails open when the model's image support is unknown", () => {
		mocks.supportsImages = undefined
		renderTextArea([PNG_DATA_URL])

		expect(screen.queryByTestId("images-unsupported-notice")).not.toBeInTheDocument()
	})

	it("shows nothing for a text-only model while no images are attached", () => {
		mocks.supportsImages = false
		renderTextArea()

		expect(screen.queryByTestId("images-unsupported-notice")).not.toBeInTheDocument()
	})
})

describe("ChatTextArea stash and mode toggle", () => {
	function renderComposer(props: Partial<React.ComponentProps<typeof ChatTextArea>> = {}) {
		render(
			<ChatTextArea
				inputValue=""
				onSelectFilesAndImages={vi.fn()}
				onSend={vi.fn()}
				placeholderText="Type a message"
				selectedFiles={[]}
				selectedImages={[]}
				sendingDisabled={false}
				setInputValue={vi.fn()}
				setSelectedFiles={vi.fn()}
				setSelectedImages={vi.fn()}
				shouldDisableFilesAndImages={false}
				{...props}
			/>,
		)
		return screen.getByPlaceholderText("Type a message")
	}

	it("stashes a non-empty draft on Escape", () => {
		const onStash = vi.fn(() => true)
		const textarea = renderComposer({ inputValue: "half-written prompt", onStash })

		fireEvent.keyDown(textarea, { key: "Escape" })

		expect(onStash).toHaveBeenCalledTimes(1)
	})

	it("stashes a quotes-only draft on Escape", () => {
		const onStash = vi.fn(() => true)
		const textarea = renderComposer({ hasQuotes: true, onStash })

		fireEvent.keyDown(textarea, { key: "Escape" })

		expect(onStash).toHaveBeenCalledTimes(1)
	})

	it("does not stash an empty draft", () => {
		const onStash = vi.fn(() => true)
		const textarea = renderComposer({ inputValue: "   ", onStash })

		fireEvent.keyDown(textarea, { key: "Escape" })

		expect(onStash).not.toHaveBeenCalled()
	})

	it("shows the stash icon only when the stash has entries", () => {
		renderComposer({ onDeleteStash: vi.fn(), onRestoreStash: vi.fn(), stashEntries: [] })
		expect(screen.queryByTestId("stash-button")).toBeNull()
	})

	it("shows the stash count next to send", () => {
		renderComposer({
			onDeleteStash: vi.fn(),
			onRestoreStash: vi.fn(),
			stashEntries: [
				{ id: "a", text: "one", quotes: [], ts: Date.now() },
				{ id: "b", text: "two", quotes: [], ts: Date.now() },
			],
		})
		expect(screen.getByTestId("stash-button")).toHaveAccessibleName("Stashed prompts (2)")
	})

	it("retains text, images and files when the host does not consume the mode-toggle draft", async () => {
		vi.mocked(StateServiceClient.togglePlanActModeProto).mockResolvedValueOnce({ value: false })
		const setInputValue = vi.fn()
		const setSelectedImages = vi.fn()
		const setSelectedFiles = vi.fn()
		const textarea = renderComposer({
			inputValue: "keep this draft",
			selectedImages: [PNG_DATA_URL],
			selectedFiles: ["/tmp/file.txt"],
			setInputValue,
			setSelectedImages,
			setSelectedFiles,
		})
		fireEvent.click(screen.getByTestId("mode-switch"))
		await waitFor(() => expect(StateServiceClient.togglePlanActModeProto).toHaveBeenCalled())
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 150))
		})
		expect(textarea).toHaveValue("keep this draft")
		expect(setInputValue).not.toHaveBeenCalledWith("")
		expect(setSelectedImages.mock.calls.some(([update]) => update([PNG_DATA_URL]).length === 0)).toBe(false)
		expect(setSelectedFiles.mock.calls.some(([update]) => update(["/tmp/file.txt"]).length === 0)).toBe(false)
	})

	it("shows the mode on a sliding Ask | Act switch beside the send icon", () => {
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		)
		renderComposer()
		expect(screen.getByTestId("mode-switch")).toHaveTextContent(/^AskAct$/)
		expect(screen.getByTestId("mode-switch")).toHaveAttribute("role", "switch")
		expect(screen.getByTestId("mode-switch").title).toMatch(/^Switch to Ask \(/)
		expect(screen.getByTestId("send-button").querySelector(".codicon-send")).not.toBeNull()
		expect(screen.queryAllByRole("menuitemradio")).toHaveLength(0)
	})
})

describe("ChatTextArea steer / interject / aside keys", () => {
	function renderComposer(props: Partial<React.ComponentProps<typeof ChatTextArea>> = {}) {
		const onSend = vi.fn()
		const onSendAs = vi.fn()
		render(
			<ChatTextArea
				inputValue="draft"
				onSelectFilesAndImages={vi.fn()}
				onSend={onSend}
				onSendAs={onSendAs}
				placeholderText="Type a message"
				selectedFiles={[]}
				selectedImages={[]}
				sendingDisabled={false}
				setInputValue={vi.fn()}
				setSelectedFiles={vi.fn()}
				setSelectedImages={vi.fn()}
				shouldDisableFilesAndImages={false}
				{...props}
			/>,
		)
		return { textarea: screen.getByPlaceholderText("Type a message"), onSend, onSendAs }
	}

	it("sends normally with Enter when idle and as an aside with Alt+Enter", () => {
		const { textarea, onSend, onSendAs } = renderComposer()

		fireEvent.keyDown(textarea, { key: "Enter" })
		expect(onSend).toHaveBeenCalledTimes(1)

		fireEvent.keyDown(textarea, { key: "Enter", altKey: true })
		expect(onSendAs).toHaveBeenCalledWith("aside")
		expect(onSend).toHaveBeenCalledTimes(1)
	})

	it("starts a background chat with Ctrl/Cmd+Enter on the home composer", () => {
		const { textarea, onSend, onSendAs } = renderComposer({ isHome: true })

		fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true })
		expect(onSendAs).toHaveBeenCalledWith("background")
		expect(onSend).not.toHaveBeenCalled()

		fireEvent.keyDown(textarea, { key: "Enter", metaKey: true })
		expect(onSendAs).toHaveBeenLastCalledWith("background")

		// Plain Enter still sends a focused task.
		fireEvent.keyDown(textarea, { key: "Enter" })
		expect(onSend).toHaveBeenCalledTimes(1)
	})

	it("keeps Ctrl/Cmd+Enter as a normal send inside an idle chat", () => {
		const { textarea, onSend, onSendAs } = renderComposer()

		fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true })
		expect(onSend).toHaveBeenCalledTimes(1)
		expect(onSendAs).not.toHaveBeenCalled()
	})

	it("does not show a background button on home", () => {
		renderComposer({ isHome: true })
		expect(screen.queryByTestId("send-background-button")).toBeNull()
	})

	it("hides the background button inside a chat", () => {
		renderComposer()
		expect(screen.queryByTestId("send-background-button")).toBeNull()
	})

	it("steers with Enter and interjects with Ctrl/Cmd+Enter by default while running", () => {
		const { textarea, onSend, onSendAs } = renderComposer({ isRunning: true })

		fireEvent.keyDown(textarea, { key: "Enter" })
		expect(onSend).toHaveBeenCalledTimes(1)

		fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true })
		fireEvent.keyDown(textarea, { key: "Enter", metaKey: true })
		expect(onSendAs).toHaveBeenCalledTimes(2)
		expect(onSendAs).toHaveBeenLastCalledWith("interject")
	})

	it("swaps the keys when Enter sends as interject", () => {
		const { textarea, onSend, onSendAs } = renderComposer({ isRunning: true, enterSendsAs: "interject" })

		fireEvent.keyDown(textarea, { key: "Enter" })
		expect(onSendAs).toHaveBeenCalledWith("interject")

		fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true })
		expect(onSend).toHaveBeenCalledTimes(1)
	})

	it("does not send on Shift+Enter", () => {
		const { textarea, onSend, onSendAs } = renderComposer({ isRunning: true })

		fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true })

		expect(onSend).not.toHaveBeenCalled()
		expect(onSendAs).not.toHaveBeenCalled()
	})

	it("replaces send with steer + interject buttons while running, highlighting the default", () => {
		const { onSend, onSendAs } = renderComposer({ isRunning: true, enterSendsAs: "interject" })

		expect(screen.queryByTestId("send-button")).toBeNull()
		expect(screen.getByTestId("interject-button")).toHaveAttribute("data-default", "true")
		expect(screen.getByTestId("steer-button")).not.toHaveAttribute("data-default")

		fireEvent.click(screen.getByTestId("steer-button"))
		fireEvent.click(screen.getByTestId("interject-button"))
		expect(onSend).toHaveBeenCalledTimes(1)
		expect(onSendAs).toHaveBeenCalledWith("interject")
	})

	it("keeps the single send button when idle", () => {
		renderComposer()
		expect(screen.getByTestId("send-button")).toBeInTheDocument()
		expect(screen.queryByTestId("steer-button")).toBeNull()
	})
})

describe("ChatTextArea mode flash reduced motion", () => {
	it("drops the Send button's mode flash under VS Code's reduce-motion body class", () => {
		renderTextArea()

		const rules = Array.from(document.querySelectorAll("style")).flatMap((style) => {
			try {
				return Array.from(style.sheet?.cssRules ?? []).map((rule) => rule.cssText)
			} catch {
				return [style.textContent ?? ""]
			}
		})

		expect(rules.some((rule) => rule.includes("vscode-reduce-motion") && rule.includes("animation"))).toBe(true)
	})
})

describe("ChatTextArea when the mode has no model to run on", () => {
	const lostModel = {
		autoApprovalSettings: DEFAULT_AUTO_APPROVAL_SETTINGS,
		modelSettings: {
			settings: {
				connections: [{ id: "c", name: "Gateway", kind: "openai-compatible", baseUrl: "https://x", defaults: {} }],
				models: [{ id: "new", connectionId: "c", upstreamId: "new", name: "New", kind: "chat", overrides: {} }],
				roles: {
					chat: null,
					ask: { enabled: false, pick: null },
					subagents: { kind: "thread", level: "inherit" },
					background: { pick: null, titlesEnabled: false, overrides: {} },
				},
			},
			effective: {},
			availability: {},
		},
		composerApiSelection: {
			modelSelectionV1: { version: 1, act: { modelId: "old", levelId: "default" }, ask: null },
		},
	}

	const renderBlocked = (inputValue = "hello") => {
		const onSend = vi.fn()
		render(
			<ChatTextArea
				inputValue={inputValue}
				onSelectFilesAndImages={vi.fn()}
				onSend={onSend}
				placeholderText="Type a message"
				selectedFiles={[]}
				selectedImages={[]}
				sendingDisabled={false}
				setInputValue={vi.fn()}
				setSelectedFiles={vi.fn()}
				setSelectedImages={vi.fn()}
				shouldDisableFilesAndImages={false}
			/>,
		)
		return { onSend, textarea: screen.getByPlaceholderText("Type a message") }
	}

	beforeEach(() => {
		mocks.state = lostModel
		vi.mocked(StateServiceClient.togglePlanActModeProto).mockClear()
	})
	afterEach(() => {
		mocks.state = {}
	})

	it("blocks sending, says why, and Pick another opens the model menu", async () => {
		const { onSend, textarea } = renderBlocked()
		expect(screen.getByTestId("model-send-block")).toHaveTextContent("The model this chat used is gone.")
		const send = screen.getByTestId("send-button")
		expect(send).toBeDisabled()
		expect(send).toHaveAttribute("title", "The model this chat used is gone.")
		fireEvent.keyDown(textarea, { key: "Enter" })
		expect(onSend).not.toHaveBeenCalled()
		fireEvent.click(screen.getByTestId("model-send-block-fix"))
		expect(await screen.findByTestId("model-menu-note")).toHaveTextContent("Pick another")
	})

	it("switching modes still works", async () => {
		renderBlocked()
		fireEvent.click(screen.getByTestId("mode-switch"))
		await waitFor(() => expect(StateServiceClient.togglePlanActModeProto).toHaveBeenCalledTimes(1))
	})

	it("/ask alone goes through, since it only switches modes", () => {
		const { onSend, textarea } = renderBlocked("/ask")
		fireEvent.keyDown(textarea, { key: "Enter" })
		expect(onSend).toHaveBeenCalledTimes(1)
	})

	it("/act with text is blocked by Act's model, and /ask with text is judged by Ask's", () => {
		const blocked = renderBlocked("/act hello")
		fireEvent.keyDown(blocked.textarea, { key: "Enter" })
		expect(blocked.onSend).not.toHaveBeenCalled()
		cleanup()
		mocks.state = {
			...lostModel,
			composerApiSelection: {
				modelSelectionV1: {
					version: 1,
					act: { modelId: "old", levelId: "default" },
					ask: { modelId: "new", levelId: "default" },
				},
			},
		}
		const allowed = renderBlocked("/ask hello")
		fireEvent.keyDown(allowed.textarea, { key: "Enter" })
		expect(allowed.onSend).toHaveBeenCalledTimes(1)
	})

	it("says nothing and sends normally once the mode has a model", () => {
		mocks.state = {
			...lostModel,
			composerApiSelection: { modelSelectionV1: { version: 1, act: { modelId: "new", levelId: "default" }, ask: null } },
		}
		const { onSend, textarea } = renderBlocked()
		expect(screen.queryByTestId("model-send-block")).toBeNull()
		fireEvent.keyDown(textarea, { key: "Enter" })
		expect(onSend).toHaveBeenCalledTimes(1)
	})
})
