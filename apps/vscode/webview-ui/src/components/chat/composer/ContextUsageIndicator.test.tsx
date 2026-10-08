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

	it("opens the details popover on click", () => {
		renderIndicator()
		fireEvent.click(screen.getByTestId("context-usage-button"))
		const details = screen.getByTestId("context-usage-details")
		expect(details).toHaveTextContent("Context168.0k / 200.0k · 84%")
		expect(details).toHaveTextContent("Input / Output41.2k / 6.1k")
		expect(details).toHaveTextContent("Cache read / write120.0k / 8.0k")
		expect(details).toHaveTextContent("Cost (this chat)$0.42")
		expect(details).toHaveTextContent("ModelOpenAI Compatible · gpt-5.6-sol · Responses")
	})

	it("triggers compaction from Compact now and closes the popover", () => {
		renderIndicator()
		fireEvent.click(screen.getByTestId("context-usage-button"))
		fireEvent.click(screen.getByTestId("compact-now-button"))
		expect(onCompact).toHaveBeenCalledTimes(1)
		expect(screen.queryByTestId("context-usage-details")).not.toBeInTheDocument()
	})

	it("disables Compact now when compaction isn't allowed", () => {
		renderIndicator({ canCompact: false })
		fireEvent.click(screen.getByTestId("context-usage-button"))
		expect(screen.getByTestId("compact-now-button")).toBeDisabled()
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

	it("hides the nudge while compaction isn't allowed (mid-turn or already compacting)", () => {
		renderIndicator({ usedTokens: 190_000, canCompact: false })
		expect(screen.queryByTestId("compact-nudge")).not.toBeInTheDocument()
	})

	it("narrow rows hide the cost text but keep it in the details", () => {
		renderIndicator({ showCost: false })
		expect(screen.queryByTestId("context-usage-cost")).not.toBeInTheDocument()
		expect(screen.getByTestId("context-usage-button")).toHaveAccessibleName("Context 84% used · $0.42")
		fireEvent.click(screen.getByTestId("context-usage-button"))
		expect(screen.getByText("Cost (this chat)")).toBeInTheDocument()
	})

	it("narrow rows move the Compact pill into the details", () => {
		renderIndicator({ usedTokens: 190_000, inlineCompactNudge: false })
		expect(screen.queryByTestId("compact-nudge")).not.toBeInTheDocument()
		fireEvent.click(screen.getByTestId("context-usage-button"))
		const compactNow = screen.getByTestId("compact-now-button")
		expect(compactNow).toBeEnabled()
		expect(compactNow).toHaveAttribute("data-nudge", "true")
	})

	it("renders an empty ring when the context window is unknown", () => {
		renderIndicator({ contextWindow: undefined, cost: undefined })
		expect(screen.getByTestId("context-usage-button")).toHaveAccessibleName("Context usage unknown")
		expect(screen.queryByTestId("compact-nudge")).not.toBeInTheDocument()
	})
})
