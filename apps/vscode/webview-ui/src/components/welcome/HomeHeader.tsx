import { EmptyRequest } from "@shared/proto/cline/common"
import { useEffect, useRef } from "react"
import ClineLogoSanta from "@/assets/ClineLogoSanta"
import ClineLogoVariable from "@/assets/ClineLogoVariable"
import { registerLogoAnchor, useSkillsetState } from "@/components/skills/skillsetStore"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { UiServiceClient } from "@/services/grpc-client"

/**
 * The home header's Cline logo (the Santa one in December), at any size. It is
 * also where skillsets get eaten: while one is dropped, the drop layer draws
 * the animated (plain) logo exactly here and this one steps aside.
 */
export const HomeLogo = ({ className }: { className?: string }) => {
	const { environment } = useExtensionState()
	const ref = useRef<HTMLDivElement>(null)
	const eating = useSkillsetState((state) => state.phase !== "idle")
	useEffect(() => (ref.current ? registerLogoAnchor(ref.current) : undefined), [])
	const LogoComponent = new Date().getMonth() === 11 ? ClineLogoSanta : ClineLogoVariable
	return (
		<div
			className={cn("shrink-0", className, eating && "invisible")}
			data-testid="home-logo"
			ref={ref}
			title="Hold Shift and drop a .skillset.zip anywhere on Cline to add its skills">
			<LogoComponent className="size-full" environment={environment} />
		</div>
	)
}

interface HomeHeaderProps {
	shouldShowQuickWins?: boolean
}

const HomeHeader = ({ shouldShowQuickWins = false }: HomeHeaderProps) => {
	const handleTakeATour = async () => {
		try {
			await UiServiceClient.openWalkthrough(EmptyRequest.create())
		} catch (error) {
			console.error("Error opening walkthrough:", error)
		}
	}

	const headingText = "What can I do for you?"

	return (
		// The original layout (logo over the heading), just smaller: about 115px instead of 190.
		<div className="mb-3 flex flex-col items-center">
			<div className="mt-4 mb-2.5">
				<HomeLogo className="size-14" />
			</div>
			<div className="flex items-center justify-center px-4 text-center">
				<h1 className="m-0 text-[15px] font-bold">{headingText}</h1>
			</div>
			{shouldShowQuickWins && (
				<div className="mt-3">
					<button
						className="flex items-center gap-2 px-4 py-2 rounded-full border border-border-panel bg-white/2 hover:bg-list-background-hover transition-colors duration-150 ease-in-out text-code-foreground text-sm font-medium cursor-pointer"
						onClick={handleTakeATour}
						type="button">
						Take a Tour
						<span className="codicon codicon-play scale-90" />
					</button>
				</div>
			)}
		</div>
	)
}

export default HomeHeader
