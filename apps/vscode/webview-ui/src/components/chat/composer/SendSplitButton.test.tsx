import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import SendSplitButton, { type SendSplitButtonProps, shortcutGlyphs } from "./SendSplitButton"

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

	it("sends from the send icon part, saying what Send will do", () => {
		const { onSend, onPickMode } = renderButton()
		const send = screen.getByTestId("send-button")
		expect(send.querySelector(".codicon-send")).not.toBeNull()
		expect(send).toHaveAccessibleName("Send (Act)")
		expect(send.title).toContain("Send (Enter) · Aside (Alt+Enter)")
		expect(send.title).toContain("In Act mode, Cline will complete the task immediately")
		fireEvent.click(send)
		expect(onSend).toHaveBeenCalledOnce()
		expect(onPickMode).not.toHaveBeenCalled()
	})

	it("switches mode in one click on the sliding switch, with the shortcut in the tooltip", () => {
		const { onPickMode, onSend } = renderButton({ toggleKeys: "⌘+Shift+A" })
		const toggle = screen.getByTestId("mode-switch")
		expect(toggle).toHaveAttribute("role", "switch")
		expect(toggle).toHaveAttribute("aria-checked", "true")
		// Both labels, the current one over the thumb.
		expect(toggle).toHaveTextContent(/^AskAct$/)
		expect(toggle.title.split("\n")[0]).toBe("Switch to Ask (⌘⇧A)")
		expect(toggle).toHaveAccessibleName("Mode: Act. Switch to Ask (⌘⇧A)")
		fireEvent.click(toggle)
		expect(onPickMode).toHaveBeenCalledWith("plan")
		expect(onSend).not.toHaveBeenCalled()
		// No menu in between.
		expect(screen.queryByRole("menu")).toBeNull()
		expect(screen.queryByTestId("mode-menu")).toBeNull()
	})

	it("slides the thumb under Ask in Ask mode, toggles back to Act, and fills send with the Ask color", () => {
		const { onPickMode } = renderButton({ mode: "plan" })
		const toggle = screen.getByTestId("mode-switch")
		expect(toggle).toHaveAttribute("aria-checked", "false")
		expect(screen.getByTestId("mode-switch-thumb").style.transform).toBe("translateX(0)")
		expect(screen.getByTestId("mode-switch-thumb").style.background).toContain("--vscode-activityWarningBadge-background")
		expect(toggle.title.split("\n")[0]).toBe("Switch to Act (Ctrl+Shift+A)")
		fireEvent.click(toggle)
		expect(onPickMode).toHaveBeenCalledWith("act")
		expect(screen.getByTestId("send-split")).toHaveAttribute("data-mode", "plan")
		expect(screen.getByTestId("send-split").style.background).toContain("--vscode-activityWarningBadge-background")
	})

	it("draws a pill switch beside the filled send part: the thumb under Act in the button color", () => {
		renderButton()
		const toggle = screen.getByTestId("mode-switch")
		expect(toggle).toHaveClass("rounded-full", "border-input-border", "bg-transparent")
		const thumb = screen.getByTestId("mode-switch-thumb")
		expect(thumb.style.transform).toBe("translateX(100%)")
		expect(thumb.style.background).toContain("--vscode-button-background")
		expect(thumb).toHaveClass("motion-reduce:transition-none", "[.vscode-reduce-motion_&]:transition-none")
		// The switch sits outside the filled send part, before it.
		expect(screen.getByTestId("send-split")).not.toContainElement(toggle)
		expect(toggle.compareDocumentPosition(screen.getByTestId("send-split")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
		expect(screen.getByTestId("send-split").style.background).toContain("--vscode-button-background")
	})

	it("on the tightest row shows only the current mode, still one click", () => {
		const { onPickMode } = renderButton({ compactMode: true, mode: "plan" })
		const toggle = screen.getByTestId("mode-switch")
		expect(toggle).toHaveAttribute("data-compact", "true")
		expect(toggle).toHaveTextContent(/^Ask$/)
		expect(toggle).toHaveAccessibleName("Mode: Ask. Switch to Act (Ctrl+Shift+A)")
		fireEvent.click(toggle)
		expect(onPickMode).toHaveBeenCalledWith("act")
	})

	it("blocks sending, not switching, while send is disabled", () => {
		const { onSend, onPickMode } = renderButton({ disabled: true })
		const send = screen.getByTestId("send-button")
		expect(send).toBeDisabled()
		expect(send).toHaveClass("disabled")
		fireEvent.click(send)
		expect(onSend).not.toHaveBeenCalled()
		fireEvent.click(screen.getByTestId("mode-switch"))
		expect(onPickMode).toHaveBeenCalledWith("plan")
	})

	it("with Enter set to interject, the button still steers and the tooltip swaps the keys", () => {
		const onSteer = vi.fn()
		renderButton({ running: { enterSendsAs: "interject", modKey: "Ctrl", onSteer } })
		expect(screen.getByTestId("steer-button").title).toBe(
			"Steer (Ctrl+Enter): queue this message for after the current turn\nInterject (Enter): stop the current turn and send now",
		)
		fireEvent.click(screen.getByTestId("steer-button"))
		expect(onSteer).toHaveBeenCalledOnce()
	})

	it("while running, the one button steers, its tooltip gives both keys, and the mode switch stays one click", () => {
		const onSteer = vi.fn()
		const { onPickMode } = renderButton({ running: { enterSendsAs: "steer", modKey: "Ctrl", onSteer } })
		expect(screen.queryByTestId("send-button")).toBeNull()
		expect(screen.queryByTestId("interject-button")).toBeNull()
		expect(screen.getByTestId("steer-button").title).toBe(
			"Steer (Enter): queue this message for after the current turn\nInterject (Ctrl+Enter): stop the current turn and send now",
		)
		expect(screen.getByTestId("steer-button").querySelector(".codicon-send")).not.toBeNull()
		expect(screen.getByTestId("mode-switch")).toHaveTextContent("Act")
		fireEvent.click(screen.getByTestId("steer-button"))
		expect(onSteer).toHaveBeenCalledOnce()
		fireEvent.click(screen.getByTestId("mode-switch"))
		expect(onPickMode).toHaveBeenCalledWith("plan")
	})

	it("writes the shortcut with macOS glyphs only on macOS", () => {
		expect(shortcutGlyphs("⌘+Shift+A")).toBe("⌘⇧A")
		expect(shortcutGlyphs("Ctrl+Shift+A")).toBe("Ctrl+Shift+A")
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
