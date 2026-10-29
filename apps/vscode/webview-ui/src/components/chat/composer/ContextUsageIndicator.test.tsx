import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ContextUsageIndicator, type ContextUsageIndicatorProps } from "./ContextUsageIndicator"

const onCompact = vi.fn()

function renderIndicator(props: Partial<ContextUsageIndicatorProps> = {}) {
	return render(
		<ContextUsageIndicator
			cacheReads={120_000}
			cacheWrites={8_000}
			canCompact={true}
			contextWindow={200_000}
			cost={0.42}
			modelLabel="OpenAI Compatible · gpt-5.6-sol · Responses"
			onCompact={onCompact}
			tokensIn={41_200}
			tokensOut={6_100}
			usedTokens={168_000}
			{...props}
		/>,
	)
}

describe("ContextUsageIndicator", () => {
	beforeEach(() => {
		onCompact.mockReset()
		vi.stubGlobal(
			"ResizeObserver",
			class ResizeObserver {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		)
	})

	it("labels the button with usage and cost for screen readers and the tooltip", () => {
		renderIndicator()
		const button = screen.getByTestId("context-usage-button")
		expect(button).toHaveAccessibleName("Context 84% used · $0.42")
		expect(button).toHaveAttribute("title", "Context 84% used · $0.42")
		expect(screen.getByTestId("context-usage-cost")).toHaveTextContent("$0.42")
	})

	it.each([
		[100_000, "ok", "var(--vscode-charts-green)"],
		[140_000, "warn", "var(--vscode-charts-yellow)"],
		[182_000, "high", "var(--vscode-charts-red)"],
	])("colors the ring for %i used tokens as %s", (usedTokens, level, color) => {
		renderIndicator({ usedTokens })
		expect(screen.getByTestId("context-usage-button")).toHaveAttribute("data-level", level)
		expect(screen.getByTestId("context-ring-progress")).toHaveAttribute("stroke", color)
	})

	it("hides the cost when it is zero or unavailable", () => {
		const { rerender } = renderIndicator({ cost: 0 })
		expect(screen.queryByTestId("context-usage-cost")).not.toBeInTheDocument()
		expect(screen.getByTestId("context-usage-button")).toHaveAccessibleName("Context 84% used")
		rerender(
			<ContextUsageIndicator
				canCompact={true}
				contextWindow={200_000}
				modelLabel="m"
				onCompact={onCompact}
				tokensIn={0}
				tokensOut={0}
			/>,
		)
		expect(screen.queryByTestId("context-usage-cost")).not.toBeInTheDocument()
	})

	it("opens one card: how full the window is, cost by model, and Compact", () => {
		renderIndicator({
			modelId: "gpt-5.6-sol",
			breakdown: [
				{
					key: "model:anthropic:claude-x",
					kind: "model",
					modelId: "claude-x",
					providerId: "anthropic",
					tokensIn: 30_000,
					tokensOut: 4_000,
					cacheTokens: 0,
					cost: 0.3,
				},
				{
					key: "model:openai-native:gpt-5.6-sol",
					kind: "model",
					modelId: "gpt-5.6-sol",
					providerId: "openai-native",
					tokensIn: 10_000,
					tokensOut: 2_000,
					cacheTokens: 0,
					cost: 0.1,
				},
				{ key: "subagents", kind: "subagents", tokensIn: 1_200, tokensOut: 100, cacheTokens: 0, cost: 0.02 },
			],
		})
		fireEvent.click(screen.getByTestId("context-usage-button"))
		const context = screen.getByTestId("context-usage-context")
		expect(context).toHaveTextContent("168.0k of 200.0k")
		expect(context).toHaveTextContent("84%")
		expect(context).toHaveTextContent("gpt-5.6-sol window")
		expect(screen.getByTestId("context-usage-auto")).toHaveTextContent("12.0k left before auto-compact (90%)")
		expect(screen.getByTestId("auto-compact-marker")).toBeInTheDocument()

		const costSection = screen.getByTestId("context-usage-cost-section")
		expect(costSection).toHaveTextContent("Cost · this thread$0.42")
		const rows = screen.getAllByTestId("cost-breakdown-row")
		expect(rows.map((row) => row.textContent)).toEqual([
			"claude-xAnthropic · 30.0k in · 4.0k out$0.3071%",
			"gpt-5.6-solOpenAI · 10.0k in · 2.0k out$0.1024%",
			"Subagents1.2k in · 100 out$0.025%",
		])

		// Raw token totals are folded away until asked for.
		expect(screen.queryByTestId("context-usage-tokens")).not.toBeInTheDocument()
		fireEvent.click(screen.getByTestId("context-usage-token-toggle"))
		const tokens = screen.getByTestId("context-usage-tokens")
		expect(tokens).toHaveTextContent("Input41.2k")
		expect(tokens).toHaveTextContent("Output6.1k")
		expect(tokens).toHaveTextContent("Cache read120.0k")
		expect(tokens).toHaveTextContent("Cache write8.0k")
	})

	it("says when auto-compact is off and leaves the marker out", () => {
		renderIndicator({ autoCompact: false })
		fireEvent.click(screen.getByTestId("context-usage-button"))
		expect(screen.getByTestId("context-usage-auto")).toHaveTextContent("Auto-compact is off")
		expect(screen.queryByTestId("auto-compact-marker")).not.toBeInTheDocument()
	})

	it("shows usage without amounts when the provider's cost isn't meaningful", () => {
		renderIndicator({
			cost: undefined,
			breakdown: [{ key: "earlier", kind: "earlier", tokensIn: 5_000, tokensOut: 500, cacheTokens: 0, cost: 0 }],
		})
		fireEvent.click(screen.getByTestId("context-usage-button"))
		const section = screen.getByTestId("context-usage-cost-section")
		expect(section).toHaveTextContent("Usage · this thread")
		expect(section).not.toHaveTextContent("$")
		expect(screen.getByTestId("cost-breakdown-row")).toHaveTextContent(
			"Earlier requestsmodel not recorded · 5.0k in · 500 out",
		)
	})

	it("triggers compaction from Compact now and closes the popover", () => {
		renderIndicator()
		fireEvent.click(screen.getByTestId("context-usage-button"))
		fireEvent.click(screen.getByTestId("compact-now-button"))
		expect(onCompact).toHaveBeenCalledTimes(1)
		expect(screen.queryByTestId("context-usage-details")).not.toBeInTheDocument()
	})

	it("disables Compact now when compaction isn't allowed, without a hint line", () => {
		renderIndicator({ canCompact: false })
		fireEvent.click(screen.getByTestId("context-usage-button"))
		expect(screen.getByTestId("compact-now-button")).toBeDisabled()
		expect(screen.queryByText(/between turns/)).toBeNull()
		expect(screen.queryByText("Summarizes the history to free up context")).toBeNull()
	})

	it("shows the Compact nudge from 85% usage", () => {
		const { rerender } = renderIndicator({ usedTokens: 169_000 }) // 84.5%
		expect(screen.queryByTestId("compact-nudge")).not.toBeInTheDocument()
		rerender(
			<ContextUsageIndicator
				canCompact={true}
				contextWindow={200_000}
				modelLabel="m"
				onCompact={onCompact}
				tokensIn={0}
				tokensOut={0}
				usedTokens={170_000}
			/>,
		)
		fireEvent.click(screen.getByTestId("compact-nudge"))
		expect(onCompact).toHaveBeenCalledTimes(1)
	})

	it("reads Compact and the tokens in use, in the composer's chip style", () => {
		renderIndicator({ usedTokens: 190_000 })
		const nudge = screen.getByTestId("compact-nudge")
		expect(nudge).toHaveTextContent("Compact190k")
		expect(nudge).toHaveClass("rounded-xs", "bg-toolbar-hover")
	})

	it("hides the nudge while compaction isn't allowed (mid-turn or already compacting)", () => {
		renderIndicator({ usedTokens: 190_000, canCompact: false })
		expect(screen.queryByTestId("compact-nudge")).not.toBeInTheDocument()
	})

	it("narrow rows hide the cost text but keep it in the details", () => {
		renderIndicator({ showCost: false })
		expect(screen.queryByTestId("context-usage-cost")).not.toBeInTheDocument()
		expect(screen.getByTestId("context-usage-button")).toHaveAccessibleName("Context 84% used · $0.42")
		fireEvent.click(screen.getByTestId("context-usage-button"))
		expect(screen.getByTestId("context-usage-cost-section")).toHaveTextContent("$0.42")
	})

	it("narrow rows keep the Compact pill as its icon", () => {
		renderIndicator({ usedTokens: 190_000, inlineCompactNudge: false })
		const nudge = screen.getByTestId("compact-nudge")
		expect(nudge).toHaveAttribute("data-icon-only", "true")
		expect(nudge).toHaveAccessibleName("Compact context (190k used)")
		expect(nudge).not.toHaveTextContent("Compact")
		fireEvent.click(nudge)
		expect(onCompact).toHaveBeenCalledTimes(1)
	})

	it("renders an empty ring when the context window is unknown", () => {
		renderIndicator({ contextWindow: undefined, cost: undefined })
		expect(screen.getByTestId("context-usage-button")).toHaveAccessibleName("Context usage unknown")
		expect(screen.queryByTestId("compact-nudge")).not.toBeInTheDocument()
	})
})
