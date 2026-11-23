import { act, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { dismissMenus } from "@/utils/dismissMenus"
import { Popover, PopoverContent, PopoverTrigger } from "./popover"

describe("Popover", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"ResizeObserver",
			class ResizeObserver {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		)
	})

	it("uses the matched VS Code menu background and foreground theme tokens", () => {
		render(
			<Popover defaultOpen>
				<PopoverTrigger>Open</PopoverTrigger>
				<PopoverContent>Popover content</PopoverContent>
			</Popover>,
		)

		expect(screen.getByText("Popover content")).toHaveClass("bg-menu", "text-menu-foreground")
		expect(screen.getByText("Popover content")).not.toHaveClass("text-popover-foreground")
	})

	// VS Code's title bar buttons (Settings, History, +) live outside the webview and keep focus,
	// so Radix never sees an outside click; the header handlers call dismissMenus instead.
	it("closes an uncontrolled popover when a title bar button is clicked", () => {
		render(
			<Popover defaultOpen>
				<PopoverTrigger>Open</PopoverTrigger>
				<PopoverContent>Popover content</PopoverContent>
			</Popover>,
		)
		expect(screen.getByText("Popover content")).toBeInTheDocument()
		act(() => dismissMenus())
		expect(screen.queryByText("Popover content")).not.toBeInTheDocument()
		// The trigger still opens it again on the first click.
		fireEvent.click(screen.getByText("Open"))
		expect(screen.getByText("Popover content")).toBeInTheDocument()
	})

	it("tells a controlled owner to close when the page loses focus", () => {
		const onOpenChange = vi.fn()
		const Controlled = () => {
			const [open, setOpen] = useState(true)
			return (
				<Popover
					onOpenChange={(next) => {
						onOpenChange(next)
						setOpen(next)
					}}
					open={open}>
					<PopoverTrigger>Open</PopoverTrigger>
					<PopoverContent>Popover content</PopoverContent>
				</Popover>
			)
		}
		render(<Controlled />)
		act(() => {
			window.dispatchEvent(new Event("blur"))
		})
		expect(onOpenChange).toHaveBeenCalledWith(false)
		expect(screen.queryByText("Popover content")).not.toBeInTheDocument()
	})

	it("leaves closed popovers alone", () => {
		const onOpenChange = vi.fn()
		render(
			<Popover onOpenChange={onOpenChange} open={false}>
				<PopoverTrigger>Open</PopoverTrigger>
				<PopoverContent>Popover content</PopoverContent>
			</Popover>,
		)
		act(() => dismissMenus())
		expect(onOpenChange).not.toHaveBeenCalled()
	})
})
