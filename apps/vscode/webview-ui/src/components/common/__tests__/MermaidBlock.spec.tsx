import { act, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mermaidMock = vi.hoisted(() => ({
	initialize: vi.fn(),
	parse: vi.fn(async () => true),
	render: vi.fn(async (_id: string, code: string) => ({ svg: `<svg data-testid="diagram"><text>${code}</text></svg>` })),
}))
vi.mock("mermaid", () => ({ default: mermaidMock }))
vi.mock("@/services/grpc-client", () => ({ FileServiceClient: { openImage: vi.fn() } }))

import MermaidBlock from "../MermaidBlock"

describe("MermaidBlock", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		mermaidMock.render.mockClear()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	const renderAndSettle = async (code: string) => {
		const view = render(<MermaidBlock code={code} />)
		await act(async () => {
			await vi.advanceTimersByTimeAsync(500)
		})
		return view
	}

	it("restores a rendered diagram on re-mount without waiting or re-rendering", async () => {
		const first = await renderAndSettle("graph TD; A-->B")
		expect(first.container.querySelector("svg")).not.toBeNull()
		first.unmount()
		mermaidMock.render.mockClear()

		// A row scrolled back into view: the diagram is there on the first paint, with no loader.
		const again = render(<MermaidBlock code="graph TD; A-->B" />)
		expect(again.container.querySelector("svg")).not.toBeNull()
		expect(again.container.textContent).not.toContain("Generating mermaid diagram")

		await act(async () => {
			await vi.advanceTimersByTimeAsync(1_000)
		})
		expect(mermaidMock.render).not.toHaveBeenCalled()
		expect(again.container.querySelectorAll("svg")).toHaveLength(1)
	})

	it("renders a new diagram after the debounce", async () => {
		const view = render(<MermaidBlock code="graph TD; C-->D" />)
		expect(view.container.textContent).toContain("Generating mermaid diagram")
		expect(view.container.querySelector("svg")).toBeNull()

		await act(async () => {
			await vi.advanceTimersByTimeAsync(500)
		})
		expect(mermaidMock.render).toHaveBeenCalledTimes(1)
		expect(view.container.querySelector("svg")).not.toBeNull()
	})
})
