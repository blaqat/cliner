import { fireEvent, render, screen } from "@testing-library/react"
import type React from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ChatTextArea from "./ChatTextArea"

const mocks = vi.hoisted(() => ({
	supportsImages: true as boolean | undefined,
	navigateToSettingsModelPicker: vi.fn(),
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
		expect(mocks.navigateToSettingsModelPicker).toHaveBeenCalledWith({ targetSection: "api-config" })
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

	it("labels the modes Ask and Act", () => {
		renderComposer()
		const switches = screen.getAllByRole("switch")
		expect(switches.map((el) => el.textContent)).toEqual(["Ask", "Act"])
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
		expect(screen.getByTestId("interject-button")).toHaveClass("text-link")
		expect(screen.getByTestId("steer-button")).not.toHaveClass("text-link")

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

describe("ChatTextArea mode slider reduced motion", () => {
	it("disables the slider transition under VS Code's reduce-motion body class", () => {
		renderTextArea()

		const rules = Array.from(document.querySelectorAll("style")).flatMap((style) => {
			try {
				return Array.from(style.sheet?.cssRules ?? []).map((rule) => rule.cssText)
			} catch {
				return [style.textContent ?? ""]
			}
		})

		expect(rules.some((rule) => rule.includes("vscode-reduce-motion") && rule.includes("transition"))).toBe(true)
	})
})
