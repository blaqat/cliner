import { renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { modelSettingsFixture } from "@/components/models/modelSelector.fixture"
import { useComposerContextUsage } from "./ContextUsageIndicator"
const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => mocks.state }))
vi.mock("./useFocusedChatModel", () => ({
	useFocusedChatModel: () => ({ provider: "openai", modelId: "legacy", contextWindow: 200_000 }),
}))
vi.mock("@/hooks/useTaskCostVisible", () => ({ useTaskCostVisible: () => true }))
describe("composer planning metadata", () => {
	it.each([true, false])("reads the selected model planning window, known=%s", (known) => {
		const settings = modelSettingsFixture()
		settings.planning.sol = { contextWindowKnown: known, planningContextWindow: known ? 256_000 : 128_000 }
		mocks.state = {
			modelSettings: settings,
			composerApiSelection: { modelSelectionV1: { act: { modelId: "sol", levelId: "medium" } } },
		}
		const { result } = renderHook(() => useComposerContextUsage("act", 0))
		expect(result.current.contextWindow).toBe(known ? 256_000 : 128_000)
		expect(result.current.contextWindowEstimated).toBe(!known)
	})
	it("retains the legacy context when modelSettings is absent", () => {
		mocks.state = {}
		const { result } = renderHook(() => useComposerContextUsage("act", 0))
		expect(result.current.contextWindow).toBe(200_000)
		expect(result.current.contextWindowEstimated).toBe(false)
	})
})
