import type React from "react"
import { memo, useRef, useState } from "react"
import ClineRulesPanel from "@/components/cline-rules/ClineRulesPanel"
import { COMPOSER_ICON_BUTTON_CLASS, COMPOSER_ICON_BUTTON_OPEN_CLASS } from "@/components/common/menuStyles"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import McpServersPanel from "./McpServersPanel"

/** Popover width and height shared by the composer's panels (also the ＋ menu's folded-in views). */
export const COMPOSER_PANEL_CLASS =
	"flex max-h-[min(70vh,520px,var(--radix-popover-content-available-height))] w-[min(400px,calc(100vw-16px))] flex-col overflow-hidden p-0"

interface ComposerPanelButtonProps {
	/** Codicon name without the `codicon-` prefix. */
	icon: string
	/** Button label (aria-label and tooltip) and the popover's heading. */
	label: string
	testId: string
	/** The panel; gets `close(keepFocus)` to dismiss the popover after an action. */
	children: (close: (keepFocus?: boolean) => void) => React.ReactNode
}

/**
 * An icon button beside the composer's ＋ that opens a panel in a popover (not a modal). Escape and
 * clicking outside close it and return focus to the button, unless an action handed focus elsewhere.
 */
const ComposerPanelButton = ({ icon, label, testId, children }: ComposerPanelButtonProps) => {
	const [open, setOpen] = useState(false)
	// Actions that hand focus to the input must not have it pulled back to the button on close.
	const keepFocusRef = useRef(false)
	const close = (keepFocus = false) => {
		keepFocusRef.current = keepFocus
		setOpen(false)
	}

	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger asChild>
				<button
					aria-label={label}
					className={cn(COMPOSER_ICON_BUTTON_CLASS, open && COMPOSER_ICON_BUTTON_OPEN_CLASS)}
					data-testid={`${testId}-button`}
					title={label}
					type="button">
					<span aria-hidden className={`codicon codicon-${icon} text-[13px]!`} />
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				aria-label={label}
				className={cn("menu-rise", COMPOSER_PANEL_CLASS)}
				data-testid={testId}
				onCloseAutoFocus={(event) => {
					if (keepFocusRef.current) {
						event.preventDefault()
						keepFocusRef.current = false
					}
				}}
				side="top">
				<div className="flex shrink-0 items-center border-b border-solid border-x-0 border-t-0 border-menu-foreground/10 px-3 py-1.5">
					<span className="text-[12px] font-medium">{label}</span>
				</div>
				{children(close)}
			</PopoverContent>
		</Popover>
	)
}

/** MCP server toggles (the button fork.24 folded into ＋, back beside it). */
export const McpServersButton = memo(() => (
	<ComposerPanelButton icon="server" label="MCP servers" testId="mcp-servers">
		{(close) => <McpServersPanel onOpenSettings={() => close()} />}
	</ComposerPanelButton>
))

/** Rules, workflows, skills (and hooks) toggles plus saved scripts; "Use" on a script starts a draft. */
export const RulesButton = memo(({ onUseScript }: { onUseScript: (name: string) => void }) => (
	<ComposerPanelButton icon="law" label="Rules, workflows, skills & scripts" testId="rules">
		{(close) => (
			<ClineRulesPanel
				onUseScript={(name) => {
					close(true)
					onUseScript(name)
				}}
			/>
		)}
	</ComposerPanelButton>
))
