import * as DialogPrimitive from "@radix-ui/react-dialog"
import { useLayoutEffect, useRef } from "react"
import McpServersPanel from "@/components/chat/composer/McpServersPanel"
import { HEADER_ICON_BUTTON_CLASS } from "@/components/chat/task-header/HeaderIconButton"
import ClineRulesPanel from "@/components/cline-rules/ClineRulesPanel"
import { openTopBarPanel, requestScriptDraft, type TopBarPanel, useTopBarPanel } from "./topBarPanels"

const TITLES: Record<TopBarPanel, { title: string; icon: string; description: string }> = {
	mcp: { title: "MCP servers", icon: "server", description: "Turn MCP servers on or off for every chat." },
	rules: {
		title: "Rules & workflows",
		icon: "book",
		description: "Rules, workflows, skills, hooks and saved scripts for every chat.",
	},
}

/**
 * The view title bar's MCP servers and Rules & workflows buttons open their panels here: a large,
 * dismissable overlay over the webview (Escape, ✕ or a click on the backdrop closes it). Focus
 * stays inside while it is open and goes back where it was after. The panels scroll inside; the
 * overlay itself never does, so there is one scrollbar.
 */
export function TopBarPanelOverlay() {
	const panel = useTopBarPanel()
	const close = () => openTopBarPanel(null)
	// Opened from the title bar, the dialog has no trigger to return to: remember what had focus.
	const returnFocusRef = useRef<HTMLElement | null>(null)
	const isOpen = !!panel
	useLayoutEffect(() => {
		if (isOpen) returnFocusRef.current = document.activeElement as HTMLElement | null
	}, [isOpen])
	const meta = panel ? TITLES[panel] : undefined

	return (
		<DialogPrimitive.Root
			onOpenChange={(next) => {
				if (!next) close()
			}}
			open={!!panel}>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Overlay
					className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0 motion-reduce:animate-none"
					data-testid="top-bar-panel-backdrop"
				/>
				<DialogPrimitive.Content
					aria-describedby={undefined}
					className="fixed inset-x-2 top-2 bottom-2 z-50 mx-auto flex max-h-[720px] max-w-[560px] flex-col overflow-hidden rounded-xs border border-solid border-menu-foreground/10 bg-menu text-menu-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 motion-reduce:animate-none"
					data-testid="top-bar-panel"
					onCloseAutoFocus={(event) => {
						event.preventDefault()
						const target = returnFocusRef.current
						returnFocusRef.current = null
						if (target?.isConnected && target !== document.body) target.focus()
					}}>
					{panel && meta && (
						<>
							<div className="flex shrink-0 items-center gap-2 border-b border-solid border-x-0 border-t-0 border-menu-foreground/10 py-1.5 pr-1.5 pl-3">
								<span aria-hidden className={`codicon codicon-${meta.icon} text-[14px]! text-description`} />
								<div className="flex min-w-0 flex-1 flex-col">
									<DialogPrimitive.Title className="m-0 text-[13px] font-semibold">
										{meta.title}
									</DialogPrimitive.Title>
									<span className="truncate text-[11px] text-description">{meta.description}</span>
								</div>
								<DialogPrimitive.Close
									aria-label="Close"
									className={HEADER_ICON_BUTTON_CLASS}
									data-testid="top-bar-panel-close">
									<span aria-hidden className="codicon codicon-close text-[14px]!" />
								</DialogPrimitive.Close>
							</div>
							{panel === "mcp" && <McpServersPanel onOpenSettings={close} />}
							{panel === "rules" && (
								<ClineRulesPanel
									onUseScript={(name) => {
										close()
										requestScriptDraft(name)
									}}
								/>
							)}
						</>
					)}
				</DialogPrimitive.Content>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	)
}
