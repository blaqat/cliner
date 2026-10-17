import * as PopoverPrimitive from "@radix-ui/react-popover"
import { useEffect, useRef, useState } from "react"
import { HEADER_ICON_BUTTON_CLASS, HeaderIconButton } from "@/components/chat/task-header/HeaderIconButton"
import { Popover, PopoverContent } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { useNavigationHistory } from "./NavigationHistoryContext"
import { shouldNameBack } from "./navHistory"

const LONG_PRESS_MS = 450

const MENU_ITEM_CLASS =
	"flex h-6 w-full min-w-0 items-center gap-1.5 rounded-xs border-0 bg-transparent px-2 text-left text-[12px] text-menu-foreground cursor-pointer hover:bg-list-hover focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"

interface BackButtonProps {
	/** Ids of the breadcrumbs on screen; Back names its target only when it isn't one of them. */
	crumbIds: readonly string[]
	/** Used when there is no history yet (e.g. the sidebar opened on a thread): go up a level. */
	fallback?: { label: string; onSelect?: () => void }
}

/**
 * History Back: `‹` plus the destination's name when it's neither Home nor in
 * the breadcrumbs, then a thin bar before the crumbs. Long-press or right-click
 * lists the session history to jump to.
 */
export const BackButton = ({ crumbIds, fallback }: BackButtonProps) => {
	const nav = useNavigationHistory()
	const [menuOpen, setMenuOpen] = useState(false)
	const pressTimerRef = useRef<ReturnType<typeof setTimeout>>()
	const longPressedRef = useRef(false)

	useEffect(() => () => clearTimeout(pressTimerRef.current), [])

	const target = nav?.backTarget
	if (!nav || !target) {
		if (!fallback) return null
		return (
			<HeaderIconButton
				data-testid="crumb-back"
				disabled={!fallback.onSelect}
				icon="chevron-left"
				label="Back"
				onClick={fallback.onSelect}
				tooltip={`Back to ${fallback.label}`}
			/>
		)
	}

	const named = shouldNameBack(target, crumbIds)
	const targetLabel = nav.describe(target).label
	// Newest first, without the current place.
	const earlier = nav.entries
		.slice(0, -1)
		.map((location, index) => ({ location, index }))
		.reverse()

	const cancelPress = () => clearTimeout(pressTimerRef.current)

	return (
		<>
			<Popover onOpenChange={setMenuOpen} open={menuOpen}>
				<PopoverPrimitive.Anchor asChild>
					<button
						aria-haspopup="menu"
						aria-label={`Back to ${targetLabel}`}
						className={cn(
							// Named, it grows to fit the label (up to a share of the header).
							named
								? HEADER_ICON_BUTTON_CLASS.replace("size-5.5", "h-5.5 max-w-[45%] gap-0.5 pr-1.5")
								: HEADER_ICON_BUTTON_CLASS,
							menuOpen && "bg-toolbar-hover text-foreground",
						)}
						data-testid="crumb-back"
						onClick={() => {
							if (longPressedRef.current) {
								longPressedRef.current = false
								return
							}
							nav.back()
						}}
						onContextMenu={(event) => {
							event.preventDefault()
							cancelPress()
							setMenuOpen(true)
						}}
						onPointerCancel={cancelPress}
						onPointerDown={(event) => {
							if (event.button > 0) return
							longPressedRef.current = false
							cancelPress()
							pressTimerRef.current = setTimeout(() => {
								longPressedRef.current = true
								setMenuOpen(true)
							}, LONG_PRESS_MS)
						}}
						onPointerLeave={cancelPress}
						onPointerUp={cancelPress}
						title={`Back to ${targetLabel} (right-click or hold for history)`}
						type="button">
						<span aria-hidden className="codicon codicon-chevron-left shrink-0 text-[14px]" />
						{named && (
							<span className="ph-no-capture min-w-0 truncate text-[12px]" data-testid="crumb-back-label">
								{targetLabel}
							</span>
						)}
					</button>
				</PopoverPrimitive.Anchor>
				<PopoverContent align="start" className="w-64 p-1 motion-reduce:animate-none" side="bottom">
					<div className="flex flex-col" data-testid="back-history-menu" role="menu">
						{earlier.map(({ location, index }) => {
							const { label, icon, detail } = nav.describe(location)
							return (
								<button
									className={MENU_ITEM_CLASS}
									data-testid="back-history-item"
									key={`${index}`}
									onClick={() => {
										setMenuOpen(false)
										nav.jumpTo(index)
									}}
									role="menuitem"
									type="button">
									<span aria-hidden className={`codicon codicon-${icon} shrink-0 text-[12px]`} />
									<span className="ph-no-capture min-w-0 truncate">{label}</span>
									{detail && (
										<span className="ph-no-capture min-w-0 shrink truncate text-description">{detail}</span>
									)}
								</button>
							)
						})}
					</div>
				</PopoverContent>
			</Popover>
			{named && (
				<span aria-hidden className="h-3.5 w-px shrink-0 bg-(--vscode-panel-border)" data-testid="crumb-back-bar" />
			)}
		</>
	)
}
