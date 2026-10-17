import type { ClineRulesToggles } from "@shared/cline-rules"
import { PlusIcon } from "lucide-react"
import type React from "react"
import { memo, useEffect, useRef, useState } from "react"
import ClineRulesPanel from "@/components/cline-rules/ClineRulesPanel"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import McpServersPanel from "./McpServersPanel"
import { handleMenuKeyDown, MENU_ROW_CLASS } from "./menuKeyboard"

/**
 * Scripts entry for the ＋ menu. Unused until scripts land (PLAN step 7): pass it to show a
 * "Scripts" row that opens `panel` inline, like MCP servers and rules.
 */
export interface PlusMenuScriptsSlot {
	/** Short status beside the row, e.g. "4 saved". */
	summary?: string
	panel: React.ReactNode
}

export interface PlusMenuProps {
	/** Inserts "@" and opens the mention menu (focuses the input). */
	onMention: () => void
	onAddFiles: () => void
	filesDisabled: boolean
	scripts?: PlusMenuScriptsSlot
}

type PlusMenuView = "menu" | "mcp" | "rules" | "scripts"

const VIEW_TITLES: Record<Exclude<PlusMenuView, "menu">, string> = {
	mcp: "MCP servers",
	rules: "Rules, workflows & skills",
	scripts: "Scripts",
}

function countOn(...toggles: (ClineRulesToggles | undefined)[]): number {
	return toggles.reduce((sum, map) => sum + Object.values(map ?? {}).filter(Boolean).length, 0)
}

/**
 * The composer's ＋: mention, files & images, and the less frequent MCP servers and rules toggles
 * (inline panels inside the same popover, not modals). Scripts get a slot for later.
 */
const PlusMenu = ({ onMention, onAddFiles, filesDisabled, scripts }: PlusMenuProps) => {
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
		icon: React.ReactNode
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
			<span aria-hidden className="flex w-4 shrink-0 justify-center text-description">
				{props.icon}
			</span>
			<span className="min-w-0 flex-1 truncate">{props.label}</span>
			{props.detail && <span className="shrink-0 text-[10.5px] text-description">{props.detail}</span>}
			{props.submenu && <span aria-hidden className="codicon codicon-chevron-right text-[11px]! text-description" />}
		</button>
	)

	return (
		<Popover
			onOpenChange={(next) => {
				setOpen(next)
				if (next) setView("menu")
			}}
			open={open}>
			<PopoverTrigger asChild>
				<button
					aria-label="Add context, files, MCP servers and rules"
					className={cn(
						"flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent p-0 text-description hover:bg-toolbar-hover hover:text-foreground",
						open && "bg-toolbar-hover text-foreground",
					)}
					data-testid="plus-menu-button"
					title="Add context, files, MCP servers and rules"
					type="button">
					<PlusIcon size={14} />
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className={cn(
					"menu-rise p-1",
					view === "menu"
						? "w-60"
						: "flex max-h-[min(70vh,520px)] w-[min(400px,calc(100vw-16px))] flex-col overflow-hidden p-0",
				)}
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
							icon: "@",
							label: "Mention a file, folder or problem",
							testId: "plus-menu-mention",
							onClick: () => {
								close(true)
								onMention()
							},
						})}
						{row({
							icon: <span className="codicon codicon-file-media text-[12px]!" />,
							label: "Files & images",
							testId: "plus-menu-files",
							disabled: filesDisabled,
							onClick: () => {
								close()
								onAddFiles()
							},
						})}
						<div className="my-1 border-t border-menu-foreground/10" />
						{row({
							icon: <span className="codicon codicon-server text-[12px]!" />,
							label: "MCP servers",
							detail: serversOn > 0 ? `${serversOn} on` : undefined,
							testId: "plus-menu-mcp",
							submenu: true,
							onClick: () => setView("mcp"),
						})}
						{row({
							icon: <span className="codicon codicon-law text-[12px]!" />,
							label: "Rules, workflows & skills",
							detail: rulesOn > 0 ? `${rulesOn} on` : undefined,
							testId: "plus-menu-rules",
							submenu: true,
							onClick: () => setView("rules"),
						})}
						{scripts &&
							row({
								icon: <span className="codicon codicon-play text-[12px]!" />,
								label: "Scripts",
								detail: scripts.summary,
								testId: "plus-menu-scripts",
								submenu: true,
								onClick: () => setView("scripts"),
							})}
					</div>
				) : (
					<>
						<div className="flex shrink-0 items-center gap-1 border-b border-menu-foreground/10 px-1 py-1">
							<button
								aria-label="Back to the ＋ menu"
								autoFocus
								className="flex size-5 cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent p-0 text-description hover:bg-list-hover hover:text-foreground focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
								data-testid="plus-menu-back"
								onClick={backToMenu}
								type="button">
								<span aria-hidden className="codicon codicon-arrow-left text-[12px]!" />
							</button>
							<span className="text-xs font-medium">{VIEW_TITLES[view]}</span>
						</div>
						{view === "mcp" && <McpServersPanel onOpenSettings={() => close()} />}
						{view === "rules" && <ClineRulesPanel />}
						{view === "scripts" && scripts?.panel}
					</>
				)}
			</PopoverContent>
		</Popover>
	)
}

export default memo(PlusMenu)
