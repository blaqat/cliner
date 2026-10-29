import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import SendSplitButton, { type SendSplitButtonProps } from "./SendSplitButton"

const renderButton = (props: Partial<SendSplitButtonProps> = {}) => {
	const onSend = vi.fn()
	const onPickMode = vi.fn()
	render(
		<SendSplitButton
			disabled={false}
			mode="act"
			onPickMode={onPickMode}
			onSend={onSend}
			sendTitle="Send (Enter) · Aside (Alt+Enter)"
			toggleKeys="Ctrl+Shift+A"
			{...props}
		/>,
	)
	return { onSend, onPickMode }
}

describe("SendSplitButton", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		)
	})

	it("says what Send will do and sends", () => {
		const { onSend } = renderButton()
		const send = screen.getByTestId("send-button")
		expect(send).toHaveTextContent(/^Act$/)
		expect(send).toHaveAccessibleName("Act: send")
		expect(send.title).toContain("Send (Enter) · Aside (Alt+Enter)")
		expect(send.title).toContain("In Act mode, Cline will complete the task immediately")
		fireEvent.click(send)
		expect(onSend).toHaveBeenCalledOnce()
	})

	it("reads Ask in Ask mode, filled with the Ask color", () => {
		renderButton({ mode: "plan" })
		expect(screen.getByTestId("send-button")).toHaveTextContent(/^Ask$/)
		expect(screen.getByTestId("send-split")).toHaveAttribute("data-mode", "plan")
		expect(screen.getByTestId("send-split").style.background).toContain("--vscode-activityWarningBadge-background")
	})

	it("its ⌄ switches the mode from a small menu that shows the toggle shortcut", () => {
		const { onPickMode, onSend } = renderButton()
		const toggle = screen.getByTestId("mode-switch")
		expect(toggle).toHaveAccessibleName("Mode: Act. Switch Ask/Act (Ctrl+Shift+A)")
		fireEvent.click(toggle)
		const menu = screen.getByTestId("mode-menu")
		const items = within(menu).getAllByRole("menuitemradio")
		expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual(["true", "false"])
		expect(items[1]).toHaveTextContent("Ask")
		expect(items[1]).toHaveTextContent("Cline will answer questions and explore the codebase")
		expect(within(menu).getByTestId("mode-shortcut")).toHaveTextContent("Ctrl+Shift+A")
		fireEvent.click(items[1])
		expect(onPickMode).toHaveBeenCalledWith("plan")
		expect(onSend).not.toHaveBeenCalled()
		expect(screen.queryByTestId("mode-menu")).toBeNull()
	})

	it("picking the current mode changes nothing", () => {
		const { onPickMode } = renderButton()
		fireEvent.click(screen.getByTestId("mode-switch"))
		fireEvent.click(screen.getByTestId("mode-option-act"))
		expect(onPickMode).not.toHaveBeenCalled()
	})

	it("blocks sending, not switching, while send is disabled", () => {
		const { onSend, onPickMode } = renderButton({ disabled: true })
		const send = screen.getByTestId("send-button")
		expect(send).toBeDisabled()
		expect(send).toHaveClass("disabled")
		fireEvent.click(send)
		expect(onSend).not.toHaveBeenCalled()
		fireEvent.click(screen.getByTestId("mode-switch"))
		fireEvent.click(screen.getByTestId("mode-option-plan"))
		expect(onPickMode).toHaveBeenCalledWith("plan")
	})

	it("while running, splits send into steer and interject and keeps the mode's name", () => {
		const onSteer = vi.fn()
		const onInterject = vi.fn()
		renderButton({ running: { enterSendsAs: "interject", modKey: "Ctrl", onSteer, onInterject } })
		expect(screen.queryByTestId("send-button")).toBeNull()
		expect(screen.getByTestId("interject-button")).toHaveAttribute("data-default", "true")
		expect(screen.getByTestId("interject-button").title).toBe("Interject (Enter): stop the current turn and send now")
		expect(screen.getByTestId("steer-button").title).toBe("Steer (Ctrl+Enter): queue this message for after the current turn")
		expect(screen.getByTestId("mode-switch")).toHaveTextContent("Act")
		fireEvent.click(screen.getByTestId("steer-button"))
		fireEvent.click(screen.getByTestId("interject-button"))
		expect(onSteer).toHaveBeenCalledOnce()
		expect(onInterject).toHaveBeenCalledOnce()
	})

	it("flashes on a mode change, but not under reduced motion", () => {
		const { container } = render(
			<SendSplitButton
				disabled={false}
				flash
				mode="act"
				onPickMode={vi.fn()}
				onSend={vi.fn()}
				sendTitle=""
				toggleKeys="⌘+Shift+A"
			/>,
		)
		const shell = container.querySelector('[data-testid="send-split"]') as HTMLElement
		const css = [...document.querySelectorAll("style")].map((style) => style.textContent).join("\n")
		const shellClass = [...shell.classList].find((name) => css.includes(`.${name}`))
		expect(shellClass).toBeDefined()
		expect(css).toMatch(new RegExp(`body\\.vscode-reduce-motion \\.${shellClass}\\s*\\{\\s*animation:\\s*none`))
	})
})
