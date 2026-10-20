import type { ClineRulesToggles } from "@shared/cline-rules"
import { memo, useEffect, useRef, useState } from "react"
import { HEADER_ICON_BUTTON_CLASS } from "@/components/chat/task-header/HeaderIconButton"
import ClineRulesPanel from "@/components/cline-rules/ClineRulesPanel"
import {
	COMPOSER_ICON_BUTTON_CLASS,
	COMPOSER_ICON_BUTTON_OPEN_CLASS,
	MENU_ICON_CLASS,
	MENU_SEPARATOR_CLASS,
} from "@/components/common/menuStyles"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { COMPOSER_PANEL_CLASS } from "./ComposerPanelButtons"
import McpServersPanel from "./McpServersPanel"
import { handleMenuKeyDown, MENU_ROW_CLASS } from "./menuKeyboard"

export interface PlusMenuProps {
	/** Inserts "@" and opens the mention menu (focuses the input). */
	onMention: () => void
	onAddFiles: () => void
	filesDisabled: boolean
	/**
	 * The MCP servers and rules buttons are folded into ＋ (narrow rows): list them here as inline
	 * panels. Otherwise they are their own buttons beside ＋ and the menu is just mention and files.
	 */
	foldedPanels?: boolean
	/** "Use" on a script in the rules panel's Scripts tab. */
	onUseScript?: (name: string) => void
}

type PlusMenuView = "menu" | "mcp" | "rules"

const VIEW_TITLES: Record<Exclude<PlusMenuView, "menu">, string> = {
	mcp: "MCP servers",
	rules: "Rules, workflows, skills & scripts",
}

function countOn(...toggles: (ClineRulesToggles | undefined)[]): number {
	return toggles.reduce((sum, map) => sum + Object.values(map ?? {}).filter(Boolean).length, 0)
}

/**
 * The composer's ＋: mention and files & images. When the row is too narrow for the MCP servers and
 * rules buttons, they fold in here as rows that open the same panels inline (not modals).
 */
const PlusMenu = ({ onMention, onAddFiles, filesDisabled, foldedPanels = false, onUseScript }: PlusMenuProps) => {
	const {
		mcpServers,
		globalClineRulesToggles,
		localClineRulesToggles,
		localCursorRulesToggles,
		localWindsurfRulesToggles,
		localAgentsRulesToggles,
	} = useExtensionState()
	const [open, setOpen] = useState(false)
	const [view, setView] = useState<PlusMenuView>("menu")
	// Actions that hand focus to the input must not have it pulled back to the ＋ on close.
	const keepFocusRef = useRef(false)
	const menuRef = useRef<HTMLDivElement>(null)
	// The panel just left, so its row gets focus back in the list.
	const returnToRef = useRef<PlusMenuView | null>(null)
	useEffect(() => {
		if (view === "menu" && returnToRef.current) {
			menuRef.current?.querySelector<HTMLElement>(`[data-testid="plus-menu-${returnToRef.current}"]`)?.focus()
			returnToRef.current = null
		}
	}, [view])
	const backToMenu = () => {
		returnToRef.current = view
		setView("menu")
	}
	const serversOn = (mcpServers ?? []).filter((server) => !server.disabled).length
	const rulesOn = countOn(
		globalClineRulesToggles,
		localClineRulesToggles,
		localCursorRulesToggles,
		localWindsurfRulesToggles,
		localAgentsRulesToggles,
	)

	const close = (keepFocus = false) => {
		keepFocusRef.current = keepFocus
		setOpen(false)
	}

	const row = (props: {
		/** Codicon name without the `codicon-` prefix. */
		icon: string
		label: string
		detail?: string
		onClick: () => void
		disabled?: boolean
		submenu?: boolean
		testId: string
	}) => (
		<button
			aria-haspopup={props.submenu ? "true" : undefined}
			className={MENU_ROW_CLASS}
			data-testid={props.testId}
			disabled={props.disabled}
			onClick={props.onClick}
			onKeyDown={(event) => {
				if (props.submenu && event.key === "ArrowRight") {
					event.preventDefault()
					props.onClick()
				}
			}}
			role="menuitem"
			type="button">
			<span aria-hidden className={cn(MENU_ICON_CLASS, `codicon-${props.icon} text-description`)} />
			<span className="min-w-0 flex-1 truncate">{props.label}</span>
			{props.detail && <span className="shrink-0 text-[11px] text-description">{props.detail}</span>}
			{props.submenu && <span aria-hidden className={cn(MENU_ICON_CLASS, "codicon-chevron-right text-description")} />}
		</button>
	)

	const label = foldedPanels ? "Add context and files, MCP servers and rules" : "Add context and files"

	return (
		<Popover
			onOpenChange={(next) => {
				setOpen(next)
				if (next) setView("menu")
			}}
			open={open}>
			<PopoverTrigger asChild>
				<button
					aria-label={label}
					className={cn(COMPOSER_ICON_BUTTON_CLASS, open && COMPOSER_ICON_BUTTON_OPEN_CLASS)}
					data-testid="plus-menu-button"
					title={label}
					type="button">
					<span aria-hidden className="codicon codicon-add text-[14px]!" />
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className={cn("menu-rise p-1", view === "menu" ? "w-60" : COMPOSER_PANEL_CLASS)}
				data-testid="plus-menu"
				onCloseAutoFocus={(event) => {
					if (keepFocusRef.current) {
						event.preventDefault()
						keepFocusRef.current = false
					}
				}}
				onEscapeKeyDown={(event) => {
					// Escape in a panel steps back to the list; a second one closes the menu.
					if (view !== "menu") {
						event.preventDefault()
						backToMenu()
					}
				}}
				side="top">
				{view === "menu" ? (
					<div aria-label="Add to message" onKeyDown={handleMenuKeyDown} ref={menuRef} role="menu">
						{row({
							icon: "mention",
							label: "Mention a file, folder or problem",
							testId: "plus-menu-mention",
							onClick: () => {
								close(true)
								onMention()
							},
						})}
						{row({
							icon: "file-media",
							label: "Files & images",
							testId: "plus-menu-files",
							disabled: filesDisabled,
							onClick: () => {
								close()
								onAddFiles()
							},
						})}
						{foldedPanels && (
							<>
								<div className={MENU_SEPARATOR_CLASS} />
								{row({
									icon: "server",
									label: "MCP servers",
									detail: serversOn > 0 ? `${serversOn} on` : undefined,
									testId: "plus-menu-mcp",
									submenu: true,
									onClick: () => setView("mcp"),
								})}
								{row({
									icon: "law",
									label: "Rules, workflows, skills & scripts",
									detail: rulesOn > 0 ? `${rulesOn} on` : undefined,
									testId: "plus-menu-rules",
									submenu: true,
									onClick: () => setView("rules"),
								})}
							</>
						)}
					</div>
				) : (
					<>
						<div className="flex shrink-0 items-center gap-1 border-b border-solid border-x-0 border-t-0 border-menu-foreground/10 px-1 py-1">
							<button
								aria-label="Back to the ＋ menu"
								autoFocus
								className={HEADER_ICON_BUTTON_CLASS}
								data-testid="plus-menu-back"
								onClick={backToMenu}
								type="button">
								<span aria-hidden className="codicon codicon-arrow-left text-[14px]!" />
							</button>
							<span className="text-[12px] font-medium">{VIEW_TITLES[view]}</span>
						</div>
						{view === "mcp" && <McpServersPanel onOpenSettings={() => close()} />}
						{view === "rules" && (
							<ClineRulesPanel
								onUseScript={(name) => {
									close(true)
									onUseScript?.(name)
								}}
							/>
						)}
					</>
				)}
			</PopoverContent>
		</Popover>
	)
}

export default memo(PlusMenu)
