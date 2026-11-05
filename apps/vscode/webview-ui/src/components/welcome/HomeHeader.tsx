import { EmptyRequest } from "@shared/proto/cline/common"
import ClineLogoSanta from "@/assets/ClineLogoSanta"
import ClineLogoVariable from "@/assets/ClineLogoVariable"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { UiServiceClient } from "@/services/grpc-client"

/** The home header's Cline logo (the Santa one in December), at any size. */
export const HomeLogo = ({ className }: { className?: string }) => {
	const { environment } = useExtensionState()
	const LogoComponent = new Date().getMonth() === 11 ? ClineLogoSanta : ClineLogoVariable
	return <LogoComponent className={className} environment={environment} />
}

interface HomeHeaderProps {
	shouldShowQuickWins?: boolean
}

const HomeHeader = ({ shouldShowQuickWins = false }: HomeHeaderProps) => {
	const { environment } = useExtensionState()

	const handleTakeATour = async () => {
		try {
			await UiServiceClient.openWalkthrough(EmptyRequest.create())
		} catch (error) {
			console.error("Error opening walkthrough:", error)
		}
	}

	const isDecember = new Date().getMonth() === 11 // 11 = December (0-indexed)
	const LogoComponent = isDecember ? ClineLogoSanta : ClineLogoVariable
	const headingText = "What can I do for you?"

	return (
		// The original layout (logo over the heading), just smaller: about 115px instead of 190.
		<div className="mb-3 flex flex-col items-center">
			<div className="mt-4 mb-2.5">
				<LogoComponent className="size-14" environment={environment} />
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
