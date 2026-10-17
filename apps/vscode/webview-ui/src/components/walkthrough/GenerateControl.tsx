import type { ApiConfigProfile } from "@shared/api-profiles"
import { useState } from "react"
import { describeProfile } from "@/components/settings/apiProfiles/profileDraft"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

const MENU_ITEM_CLASS =
	"flex w-full cursor-pointer items-start gap-1.5 rounded-xs border-0 bg-transparent px-2 py-1 text-left text-[12px] text-menu-foreground hover:bg-list-hover"

interface GenerateControlProps {
	profiles: ApiConfigProfile[]
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
			<button
				className="cursor-pointer border-0 bg-transparent p-0 text-[11px] text-link hover:underline"
				onClick={onOpenProfiles}
				type="button">
				Add an API profile to Generate
			</button>
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
						"✦"
					)}{" "}
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
					<PopoverContent align="end" className="w-64 p-1 motion-reduce:animate-none" side="bottom">
						<div className="px-2 pt-1 pb-1.5 text-[11px] text-description">Generate with</div>
						<div className="flex flex-col" role="menu">
							{profiles.map((p) => (
								<button
									aria-checked={p.id === profileId}
									className={MENU_ITEM_CLASS}
									key={p.id}
									onClick={() => {
										onPickProfile(p.id)
										setMenuOpen(false)
									}}
									role="menuitemradio"
									type="button">
									<span
										aria-hidden
										className={cn(
											"codicon codicon-check mt-0.5 text-[12px]!",
											p.id !== profileId && "invisible",
										)}
									/>
									<span className="min-w-0 flex-1">
										<span className="block truncate">{p.name}</span>
										<span className="block truncate text-[11px] text-description">{describeProfile(p)}</span>
									</span>
								</button>
							))}
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
