import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ModelPickButton } from "./ModelPickButton"
import { ModelSelector, type ModelSelectorProps, type SelectorRow } from "./ModelSelector"
import { STANDARD_LEVELS, sameAsThreadRow } from "./modelSelectorRows"

const ONLY_HIGH = [STANDARD_LEVELS[0], STANDARD_LEVELS[3], STANDARD_LEVELS[4]]

const rows: SelectorRow[] = [
	{ id: "sol", label: "GPT-6 Sol", detail: "gpt-6-sol", group: "Gateway", levels: STANDARD_LEVELS },
	{ id: "g54", label: "GPT-5.4", group: "Gateway", levels: ONLY_HIGH },
	{ id: "off", label: "Mistral 8", group: "Gateway", levels: null, disabledReason: "Connection credentials are missing." },
	{
		id: "qwen",
		label: "Qwen 3",
		group: "Local",
		levels: null,
		noLevelsReason: "This model has no reasoning control",
		noLevelId: "default",
	},
	{
		id: "tuned",
		label: "acme-tuned-coder",
		group: "Local",
		levels: null,
		noLevelsReason: "Reasoning is unknown",
		noLevelsNote: "Reasoning is unknown for acme-tuned-coder, so no level is sent.",
		noLevelId: "default",
	},
]

const onCommit = vi.fn()
const onManage = vi.fn()

const renderSelector = (props: Partial<ModelSelectorProps> = {}) =>
	render(
		<ModelSelector
			ladder={STANDARD_LEVELS}
			modelsLabel="Chat model"
			onCommit={onCommit}
			onManage={onManage}
			pick={{ rowId: "sol", levelId: "medium" }}
			rows={rows}
			trigger={<button type="button">open</button>}
			{...props}
		/>,
	)

const options = (column: HTMLElement) => within(column).getAllByRole("option")
const option = (column: HTMLElement, name: string) => within(column).getByRole("option", { name })
const selected = (column: HTMLElement) => within(column).getByRole("option", { selected: true })
const models = () => screen.getByTestId("model-list")
const levels = () => screen.getByTestId("effort-list")

async function openMenu(trigger = screen.getByRole("button", { name: "open" })) {
	fireEvent.click(trigger)
	const menu = await screen.findByTestId("model-menu")
	// Radix starts listening for outside clicks a tick after it opens.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0))
	})
	return menu
}

beforeEach(() => {
	vi.stubGlobal(
		"ResizeObserver",
		class ResizeObserver {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	onCommit.mockReset()
	onManage.mockReset()
})

describe("ModelSelector", () => {
	describe("keys and saving", () => {
		it("arrow keys work across the lists; Enter saves both in one call", async () => {
			renderSelector()
			await openMenu()
			await waitFor(() => expect(models()).toHaveFocus())
			fireEvent.keyDown(models(), { key: "ArrowDown" })
			expect(selected(models())).toHaveTextContent("GPT-5.4")
			fireEvent.keyDown(models(), { key: "ArrowRight" })
			expect(levels()).toHaveFocus()
			// GPT-5.4 moved the level to Default; ↓ steps over Low and Medium, which it doesn't offer.
			fireEvent.keyDown(levels(), { key: "ArrowDown" })
			expect(selected(levels())).toHaveTextContent("High")
			fireEvent.keyDown(levels(), { key: "ArrowLeft" })
			expect(models()).toHaveFocus()
			fireEvent.keyDown(models(), { key: "Enter" })
			expect(screen.queryByTestId("model-menu")).toBeNull()
			expect(onCommit).toHaveBeenCalledExactlyOnceWith({ rowId: "g54", levelId: "high" })
		})

		it("a click saves at once and leaves the menu open for the other list", async () => {
			renderSelector()
			await openMenu()
			fireEvent.click(option(models(), "GPT-5.4"))
			expect(onCommit).toHaveBeenCalledExactlyOnceWith({ rowId: "g54", levelId: "default" })
			expect(screen.getByTestId("model-menu")).toBeInTheDocument()
			fireEvent.click(option(levels(), "High"))
			expect(onCommit).toHaveBeenLastCalledWith({ rowId: "g54", levelId: "high" })
			expect(onCommit).toHaveBeenCalledTimes(2)
			expect(screen.getByTestId("model-menu")).toBeInTheDocument()
		})

		it("closing after a click saves nothing more, even before the host has answered", async () => {
			renderSelector()
			await openMenu()
			fireEvent.click(option(levels(), "Low"))
			fireEvent.pointerDown(document.body)
			expect(screen.queryByTestId("model-menu")).toBeNull()
			expect(onCommit).toHaveBeenCalledExactlyOnceWith({ rowId: "sol", levelId: "low" })
		})

		it("clicking the pick that's already saved saves nothing", async () => {
			renderSelector()
			await openMenu()
			fireEvent.click(option(models(), "GPT-6 Sol"))
			fireEvent.click(option(levels(), "Medium"))
			expect(onCommit).not.toHaveBeenCalled()
		})

		it("clicking back to the first model saves that too, though the prop hasn't caught up", async () => {
			renderSelector()
			await openMenu()
			fireEvent.click(option(models(), "GPT-5.4"))
			fireEvent.click(option(models(), "GPT-6 Sol"))
			expect(onCommit).toHaveBeenCalledTimes(2)
			expect(onCommit).toHaveBeenLastCalledWith({ rowId: "sol", levelId: "default" })
		})

		it("a click on the row the keys moved to saves it", async () => {
			renderSelector()
			await openMenu()
			fireEvent.keyDown(models(), { key: "ArrowDown" })
			expect(onCommit).not.toHaveBeenCalled()
			fireEvent.click(option(models(), "GPT-5.4"))
			expect(onCommit).toHaveBeenCalledExactlyOnceWith({ rowId: "g54", levelId: "default" })
		})

		it("a refused click puts the lists back, and the same click tries again", async () => {
			onCommit.mockResolvedValueOnce(false)
			renderSelector()
			await openMenu()
			fireEvent.click(option(models(), "GPT-5.4"))
			await waitFor(() => expect(selected(models())).toHaveTextContent("GPT-6 Sol"))
			expect(selected(levels())).toHaveTextContent("Medium")
			fireEvent.click(option(models(), "GPT-5.4"))
			expect(onCommit).toHaveBeenCalledTimes(2)
			expect(onCommit).toHaveBeenLastCalledWith({ rowId: "g54", levelId: "default" })
		})

		it("closing after a refused click sends nothing more", async () => {
			onCommit.mockResolvedValueOnce(false)
			renderSelector()
			await openMenu()
			fireEvent.click(option(models(), "GPT-5.4"))
			await waitFor(() => expect(selected(models())).toHaveTextContent("GPT-6 Sol"))
			fireEvent.pointerDown(document.body)
			expect(onCommit).toHaveBeenCalledOnce()
		})

		it("a late refusal leaves a newer pick alone", async () => {
			let refuse: (accepted: boolean) => void = () => {}
			onCommit.mockImplementationOnce(() => new Promise((resolve) => (refuse = resolve)))
			renderSelector()
			await openMenu()
			fireEvent.click(option(models(), "GPT-5.4"))
			fireEvent.click(option(models(), "Qwen 3"))
			await act(async () => refuse(false))
			expect(selected(models())).toHaveTextContent("Qwen 3")
		})

		it("a click outside saves what the keys moved", async () => {
			renderSelector()
			await openMenu()
			fireEvent.keyDown(models(), { key: "ArrowDown" })
			expect(onCommit).not.toHaveBeenCalled()
			fireEvent.pointerDown(document.body)
			expect(screen.queryByTestId("model-menu")).toBeNull()
			expect(onCommit).toHaveBeenCalledExactlyOnceWith({ rowId: "g54", levelId: "default" })
		})

		it("a row that left the list when its save landed isn't saved again on close", async () => {
			// "Add allowed model" drops a model from its own list once it's added.
			const { rerender } = renderSelector({ pick: null })
			await openMenu()
			fireEvent.click(option(models(), "Qwen 3"))
			rerender(
				<ModelSelector
					ladder={STANDARD_LEVELS}
					modelsLabel="Chat model"
					onCommit={onCommit}
					onManage={onManage}
					pick={null}
					rows={rows.filter((row) => row.id !== "qwen")}
					trigger={<button type="button">open</button>}
				/>,
			)
			fireEvent.pointerDown(document.body)
			expect(onCommit).toHaveBeenCalledExactlyOnceWith({ rowId: "qwen", levelId: "default" })
		})

		it("saves a model without levels when nothing was picked yet", async () => {
			renderSelector({ pick: null })
			await openMenu()
			fireEvent.click(option(models(), "acme-tuned-coder"))
			fireEvent.pointerDown(document.body)
			expect(onCommit).toHaveBeenCalledExactlyOnceWith({ rowId: "tuned", levelId: "default" })
		})

		it("Escape discards, and the next open starts from the saved pick", async () => {
			renderSelector()
			await openMenu()
			fireEvent.keyDown(models(), { key: "End" })
			fireEvent.keyDown(models(), { key: "Escape" })
			expect(screen.queryByTestId("model-menu")).toBeNull()
			expect(onCommit).not.toHaveBeenCalled()
			await openMenu()
			expect(selected(models())).toHaveTextContent("GPT-6 Sol")
			expect(selected(levels())).toHaveTextContent("Medium")
		})

		it("Escape only drops what the keys moved: a click is already saved", async () => {
			renderSelector()
			await openMenu()
			fireEvent.click(option(models(), "GPT-5.4"))
			fireEvent.keyDown(models(), { key: "End" })
			fireEvent.keyDown(models(), { key: "Escape" })
			expect(screen.queryByTestId("model-menu")).toBeNull()
			expect(onCommit).toHaveBeenCalledExactlyOnceWith({ rowId: "g54", levelId: "default" })
		})

		it("keeping the same pick saves nothing", async () => {
			renderSelector()
			await openMenu()
			fireEvent.keyDown(models(), { key: "Enter" })
			expect(onCommit).not.toHaveBeenCalled()
		})
	})

	describe("levels a model doesn't offer", () => {
		it("show greyed, with the reason, and can't be picked by click or key", async () => {
			renderSelector({ pick: { rowId: "g54", levelId: "high" } })
			await openMenu()
			expect(options(levels()).map((row) => row.textContent)).toEqual(["Default", "Low", "Medium", "High", "XHigh"])
			const low = option(levels(), "Low")
			expect(low).toHaveAttribute("aria-disabled", "true")
			expect(low).toHaveAttribute("title", "GPT-5.4 doesn't offer Low")
			expect(low).toHaveClass("opacity-50", "cursor-not-allowed")
			fireEvent.click(low)
			expect(selected(levels())).toHaveTextContent("High")
			// ↑ from High steps over Medium and Low, to Default.
			fireEvent.keyDown(models(), { key: "ArrowRight" })
			fireEvent.keyDown(levels(), { key: "ArrowUp" })
			expect(selected(levels())).toHaveTextContent("Default")
		})

		it("moving to a model without the current level goes to the nearest one below, and says so", async () => {
			renderSelector()
			await openMenu()
			fireEvent.click(option(models(), "GPT-5.4"))
			expect(selected(levels())).toHaveTextContent("Default")
			expect(screen.getByTestId("model-menu-note")).toHaveTextContent("Moved to Default: GPT-5.4 doesn't offer Medium.")
			fireEvent.keyDown(models(), { key: "Enter" })
			expect(onCommit).toHaveBeenCalledExactlyOnceWith({ rowId: "g54", levelId: "default" })
		})

		it("a saved level it doesn't offer stays marked, won't start, and links to the fix", async () => {
			renderSelector({ pick: { rowId: "g54", levelId: "medium" } })
			await openMenu()
			expect(selected(levels())).toHaveTextContent("Medium")
			expect(selected(levels())).toHaveClass("text-warning")
			expect(screen.getByTestId("model-menu-note")).toHaveTextContent(
				"GPT-5.4 doesn't offer Medium, so this pick won't start.",
			)
			fireEvent.click(screen.getByTestId("model-menu-fix"))
			expect(onManage).toHaveBeenCalledOnce()
			expect(onCommit).not.toHaveBeenCalled()
		})

		it("a model without reasoning shows a lone dash with the reason and saves its fixed level", async () => {
			renderSelector()
			await openMenu()
			fireEvent.click(option(models(), "Qwen 3"))
			expect(options(levels()).map((row) => row.textContent)).toEqual(["—"])
			expect(levels()).toHaveAttribute("title", "This model has no reasoning control")
			fireEvent.keyDown(models(), { key: "Enter" })
			expect(onCommit).toHaveBeenCalledExactlyOnceWith({ rowId: "qwen", levelId: "default" })
		})

		it("unknown reasoning says so and links to where it's set", async () => {
			renderSelector({ pick: { rowId: "tuned", levelId: "default" } })
			await openMenu()
			expect(screen.getByTestId("model-menu-note")).toHaveTextContent("Reasoning is unknown for acme-tuned-coder")
			expect(screen.getByTestId("model-menu-fix")).toHaveTextContent("Set it")
		})
	})

	describe("the model list", () => {
		it("shows every row under its group, and no heading when there's only one group", async () => {
			const { unmount } = renderSelector()
			await openMenu()
			expect(options(models()).map((row) => row.textContent)).toEqual(rows.map((row) => row.label))
			expect(screen.getAllByTestId("list-group").map((group) => group.textContent)).toEqual(["Gateway", "Local"])
			unmount()
			renderSelector({ rows: rows.filter((row) => row.group === "Gateway") })
			await openMenu()
			expect(screen.queryByTestId("list-group")).toBeNull()
		})

		it("drops a suffix the heading already says from the list, but not the row's name", async () => {
			const shared: SelectorRow[] = [
				{ id: "a", label: "Sol · Gateway", groupedLabel: "Sol", group: "Gateway", levels: null },
				{ id: "b", label: "Sol · Local", groupedLabel: "Sol", group: "Local", levels: null },
			]
			const { unmount } = renderSelector({ pick: { rowId: "a", levelId: "default" }, rows: shared })
			await openMenu()
			const [first, second] = options(models())
			expect(first).toHaveTextContent(/^Sol$/)
			expect(first).toHaveAccessibleName("Sol · Gateway")
			expect(second).toHaveAccessibleName("Sol · Local")
			unmount()
			// With one group there's no heading to lean on.
			renderSelector({ pick: { rowId: "a", levelId: "default" }, rows: [shared[0]] })
			await openMenu()
			expect(options(models())[0]).toHaveTextContent("Sol · Gateway")
		})

		it("a model that can't run is greyed, says why and where, and the keys skip it", async () => {
			renderSelector({ pick: { rowId: "g54", levelId: "high" } })
			await openMenu()
			const off = option(models(), "Mistral 8")
			expect(off).toHaveAttribute("aria-disabled", "true")
			expect(off).toHaveAttribute("title", "Connection credentials are missing. Fix it in Settings › Models.")
			fireEvent.click(off)
			expect(selected(models())).toHaveTextContent("GPT-5.4")
			fireEvent.keyDown(models(), { key: "ArrowDown" })
			expect(selected(models())).toHaveTextContent("Qwen 3")
		})

		it("a pick on a model that can't run says why and links to the fix", async () => {
			renderSelector({ pick: { rowId: "off", levelId: "default" } })
			await openMenu()
			expect(screen.getByTestId("model-menu-note")).toHaveTextContent("Connection credentials are missing.")
			expect(screen.getByTestId("model-menu-fix")).toHaveTextContent("Fix it in Settings › Models")
		})

		it("the fix link goes to the control the host named", async () => {
			const fixable = rows.map((row) => (row.id === "off" ? { ...row, fixTarget: "connection:c1" as const } : row))
			renderSelector({ pick: { rowId: "off", levelId: "default" }, rows: fixable })
			await openMenu()
			fireEvent.click(screen.getByTestId("model-menu-fix"))
			expect(onManage).toHaveBeenCalledWith("connection:c1")
		})

		it("takes Same as the thread as an ordinary entry, with its own level on top", async () => {
			renderSelector({ pick: { rowId: "thread", levelId: "inherit" }, rows: [sameAsThreadRow(STANDARD_LEVELS), ...rows] })
			await openMenu()
			expect(options(models())[0]).toHaveTextContent("Same as the thread")
			expect(selected(levels())).toHaveTextContent("Thread's level")
			expect(options(levels()).map((row) => row.textContent)).toEqual([
				"Thread's level",
				"Default",
				"Low",
				"Medium",
				"High",
				"XHigh",
			])
			// Picking a real model drops the thread's level for that model's own column.
			fireEvent.click(option(models(), "GPT-6 Sol"))
			expect(selected(levels())).toHaveTextContent("Medium")
			expect(within(levels()).queryByRole("option", { name: "Thread's level" })).toBeNull()
		})

		it("without that entry there is no such choice", async () => {
			renderSelector()
			await openMenu()
			expect(within(models()).queryByRole("option", { name: "Same as the thread" })).toBeNull()
		})

		it("with no models says so and links to Settings › Models", async () => {
			renderSelector({ pick: null, rows: [] })
			await openMenu()
			expect(screen.queryByTestId("model-menu-scroll")).toBeNull()
			expect(screen.getByTestId("model-menu-empty")).toHaveTextContent("No models set up yet.")
			fireEvent.click(screen.getByTestId("model-menu-fix"))
			expect(onManage).toHaveBeenCalledOnce()
			expect(onCommit).not.toHaveBeenCalled()
		})

		it("never carries a level onto a model without one: saves Default and sends no effort", async () => {
			renderSelector({ pick: { rowId: "sol", levelId: "high" } })
			await openMenu()
			fireEvent.click(option(models(), "acme-tuned-coder"))
			fireEvent.keyDown(models(), { key: "Enter" })
			expect(onCommit).toHaveBeenCalledExactlyOnceWith({ rowId: "tuned", levelId: "default" })
		})

		it("moves a carried level down on a model that only offers Default, and says so", async () => {
			const defaultOnly: SelectorRow = { id: "plain", label: "Plain", group: "Local", levels: [STANDARD_LEVELS[0]] }
			renderSelector({ pick: { rowId: "sol", levelId: "low" }, rows: [...rows, defaultOnly] })
			await openMenu()
			fireEvent.click(option(models(), "Plain"))
			expect(screen.getByTestId("model-menu-note")).toHaveTextContent("Moved to Default")
			fireEvent.keyDown(models(), { key: "Enter" })
			expect(onCommit).toHaveBeenCalledExactlyOnceWith({ rowId: "plain", levelId: "default" })
		})

		it("with no pick yet, the first pick takes the middle level", async () => {
			renderSelector({ pick: null })
			await openMenu()
			expect(within(models()).queryByRole("option", { selected: true })).toBeNull()
			expect(levels()).toHaveAttribute("title", "Pick a model first")
			fireEvent.click(option(models(), "GPT-6 Sol"))
			fireEvent.keyDown(models(), { key: "Enter" })
			expect(onCommit).toHaveBeenCalledExactlyOnceWith({ rowId: "sol", levelId: "medium" })
		})
	})

	describe("layout and slots", () => {
		it("has one scroll region holding both lists, capped to the viewport", async () => {
			renderSelector()
			const menu = await openMenu()
			expect(menu).toHaveClass("max-h-(--radix-popover-content-available-height)", "flex", "flex-col")
			const scroll = screen.getByTestId("model-menu-scroll")
			expect(scroll).toHaveClass("overflow-y-auto", "min-h-0")
			for (const column of [models(), levels()]) {
				expect(scroll).toContainElement(column)
				expect(column.className).not.toMatch(/overflow-(y-)?(auto|scroll|hidden)/)
			}
		})

		it("uses neither slot unless given, and shows both when they are", async () => {
			const { unmount } = renderSelector()
			const bare = await openMenu()
			expect(bare.querySelector("hr")).toBeNull()
			expect(within(bare).queryByTestId("top-slot")).toBeNull()
			unmount()
			renderSelector({
				top: <div data-testid="top-slot" />,
				footer: ({ moved, close }) => (
					<button data-moved={moved} data-testid="foot-slot" onClick={() => close(false)} type="button" />
				),
			})
			await openMenu()
			expect(screen.getByTestId("top-slot")).toBeInTheDocument()
			expect(screen.getByTestId("foot-slot")).toHaveAttribute("data-moved", "false")
			fireEvent.keyDown(models(), { key: "ArrowDown" })
			expect(screen.getByTestId("foot-slot")).toHaveAttribute("data-moved", "true")
			fireEvent.click(screen.getByTestId("foot-slot"))
			expect(screen.queryByTestId("model-menu")).toBeNull()
			expect(onCommit).not.toHaveBeenCalled()
		})

		it("makes the lists inert, saying why, while disabled", async () => {
			renderSelector({ disabledReason: "Locked for now" })
			await openMenu()
			expect(models()).toHaveAttribute("title", "Locked for now")
			expect(screen.getByTestId("model-menu-note")).toHaveTextContent("Locked for now")
			fireEvent.click(option(models(), "GPT-5.4"))
			fireEvent.keyDown(models(), { key: "ArrowDown" })
			fireEvent.keyDown(models(), { key: "Enter" })
			expect(onCommit).not.toHaveBeenCalled()
		})
	})
})

describe("ModelPickButton", () => {
	const renderButton = (props: Partial<ModelSelectorProps> = {}) =>
		render(
			<ModelPickButton
				ladder={STANDARD_LEVELS}
				modelsLabel="Chat"
				onCommit={onCommit}
				onManage={onManage}
				pick={{ rowId: "sol", levelId: "medium" }}
				rows={rows}
				{...props}
			/>,
		)
	const button = () => screen.getByTestId("model-pick-button")

	it("reads as the model and short level, and opens the same selector with no composer extras", async () => {
		renderButton()
		expect(button()).toHaveTextContent(/^GPT-6 SolMed$/)
		expect(button()).toHaveAccessibleName("Chat: GPT-6 Sol Med")
		const menu = await openMenu(button())
		expect(within(menu).getByTestId("model-effort-lists")).toBeInTheDocument()
		expect(menu.querySelector("hr")).toBeNull()
		expect(within(menu).queryByTestId("approval-tiles")).toBeNull()
		expect(within(menu).queryByTestId("menu-next-message")).toBeNull()
		expect(within(menu).queryByTestId("menu-make-default")).toBeNull()
		fireEvent.click(option(models(), "GPT-5.4"))
		fireEvent.keyDown(models(), { key: "Enter" })
		expect(onCommit).toHaveBeenCalledExactlyOnceWith({ rowId: "g54", levelId: "default" })
	})

	it("drops the level for a model without one, and marks a saved level it doesn't offer", () => {
		const { unmount } = renderButton({ pick: { rowId: "qwen", levelId: "default" } })
		expect(button()).toHaveTextContent(/^Qwen 3$/)
		unmount()
		renderButton({ pick: { rowId: "g54", levelId: "medium" } })
		expect(within(button()).getByText("Med")).toHaveClass("text-warning")
	})

	it("says what's missing, and still opens to the fix, when nothing can be picked", async () => {
		const { unmount } = renderButton({ pick: null })
		expect(button()).toHaveTextContent("Pick a model")
		unmount()
		renderButton({ pick: null, rows: [] })
		expect(button()).toHaveTextContent("No models yet")
		await openMenu(button())
		expect(screen.getByTestId("model-menu-empty")).toBeInTheDocument()
	})
})

describe("a very short window", () => {
	const setHeights = (available: number) => {
		const real = window.getComputedStyle
		vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
			const style = real(element)
			return new Proxy(style, {
				get: (target, name) => {
					if (name === "getPropertyValue") {
						return (key: string) =>
							key === "--radix-popover-content-available-height" ? `${available}px` : target.getPropertyValue(key)
					}
					const value = Reflect.get(target, name)
					return typeof value === "function" ? value.bind(target) : value
				},
			})
		})
		vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(80)
		vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(80)
		vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(400)
	}

	const openWith = async (available: number) => {
		setHeights(available)
		renderSelector({ top: <div>tiles</div>, footer: () => <div>footer</div> })
		fireEvent.click(screen.getByRole("button", { name: "open" }))
		return screen.findByTestId("model-menu")
	}

	it("the whole menu scrolls and the lists keep their full height, so one scrollbar and the lists stay reachable", async () => {
		const menu = await openWith(170)
		await waitFor(() => expect(menu).toHaveAttribute("data-menu-scroll", "whole"))
		expect(menu).toHaveClass("overflow-y-auto")
		const lists = screen.getByTestId("model-menu-scroll")
		expect(lists).toHaveClass("shrink-0")
		expect(lists.className).not.toMatch(/overflow|min-h-0/)
		vi.restoreAllMocks()
	})

	it("with room to spare the lists scroll on their own and the menu doesn't", async () => {
		const menu = await openWith(900)
		await waitFor(() => expect(menu).toHaveAttribute("data-menu-scroll", "lists"))
		expect(menu).toHaveClass("overflow-hidden")
		expect(screen.getByTestId("model-menu-scroll")).toHaveClass("overflow-y-auto", "min-h-0")
		vi.restoreAllMocks()
	})
})
