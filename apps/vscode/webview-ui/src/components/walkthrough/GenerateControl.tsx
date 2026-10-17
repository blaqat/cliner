import { useState } from "react"
import { handleMenuKeyDown } from "@/components/chat/composer/menuKeyboard"
import { LinkButton } from "@/components/common/LinkButton"
import { MENU_HEADING_CLASS, MENU_ICON_CLASS, MENU_ITEM_CLASS, MENU_SEPARATOR_CLASS } from "@/components/common/menuStyles"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

/** A profile as the ▾ menu shows it: name over its model and effort. */
export interface GenerateProfileOption {
	id: string
	name: string
	description: string
}

interface GenerateControlProps {
	profiles: GenerateProfileOption[]
	profileId: string | undefined
	onPickProfile: (profileId: string) => void
	/** The document shown is already generated, so the button regenerates. */
	regenerate: boolean
	disabled: boolean
	generating: boolean
	onGenerate: () => void
	onOpenProfiles: () => void
}

/**
 * `✦ Generate ▾`: the walkthrough's one AI-cost action. One call to the chosen
 * profile, only on click; ▾ picks the profile and starts on the remembered one.
 */
export function GenerateControl({
	profiles,
	profileId,
	onPickProfile,
	regenerate,
	disabled,
	generating,
	onGenerate,
	onOpenProfiles,
}: GenerateControlProps) {
	const [menuOpen, setMenuOpen] = useState(false)
	const profile = profiles.find((p) => p.id === profileId)
	if (!profiles.length)
		return (
			<LinkButton className="text-[11px]" onClick={onOpenProfiles}>
				Add a profile to Generate
			</LinkButton>
		)
	return (
		<div className="flex flex-col items-end gap-0.5">
			<div className="flex items-center">
				<Button
					className="rounded-r-none"
					disabled={disabled || generating}
					onClick={() => (profile ? onGenerate() : setMenuOpen(true))}
					size="xs"
					title={profile ? `One call to ${profile.name}` : "Choose a profile first"}>
					{generating ? (
						<span aria-hidden className="codicon codicon-loading codicon-modifier-spin text-[11px]!" />
					) : (
						<span aria-hidden className="codicon codicon-sparkle text-[11px]!" />
					)}
					{regenerate ? "Regenerate" : "Generate"}
				</Button>
				<Popover onOpenChange={setMenuOpen} open={menuOpen}>
					<PopoverTrigger asChild>
						<Button
							aria-label="Choose Generate profile"
							className="rounded-l-none border-0 border-l border-solid border-button-separator px-1"
							disabled={generating}
							size="xs">
							<span aria-hidden className="codicon codicon-chevron-down text-[11px]!" />
						</Button>
					</PopoverTrigger>
					<PopoverContent align="end" className="menu-rise w-64 p-1" onKeyDown={handleMenuKeyDown} side="bottom">
						<div className={MENU_HEADING_CLASS}>Generate with</div>
						<div className="flex flex-col" role="menu">
							{profiles.map((p) => (
								<button
									aria-checked={p.id === profileId}
									className={cn(MENU_ITEM_CLASS, "h-auto items-start py-1")}
									key={p.id}
									onClick={() => {
										onPickProfile(p.id)
										setMenuOpen(false)
									}}
									role="menuitemradio"
									type="button">
									<span
										aria-hidden
										className={cn(MENU_ICON_CLASS, "codicon-check mt-0.5", p.id !== profileId && "invisible")}
									/>
									<span className="min-w-0 flex-1">
										<span className="block truncate">{p.name}</span>
										<span className="block truncate text-[11px] text-description">{p.description}</span>
									</span>
								</button>
							))}
							<div className={MENU_SEPARATOR_CLASS} role="separator" />
							<button
								className={cn(MENU_ITEM_CLASS, "text-description")}
								onClick={() => {
									setMenuOpen(false)
									onOpenProfiles()
								}}
								role="menuitem"
								type="button">
								<span aria-hidden className={cn(MENU_ICON_CLASS, "codicon-settings-gear")} />
								Manage profiles…
							</button>
						</div>
					</PopoverContent>
				</Popover>
			</div>
			<span className="text-[10px] text-description" data-testid="walkthrough-generate-cost">
				{profile ? `One call to ${profile.name} · only when you click` : "Pick a profile · one call, only when you click"}
			</span>
		</div>
	)
}
