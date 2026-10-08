import { PlanActMode, TogglePlanActModeRequest } from "@shared/proto/cline/state"
import { MouseEvent, memo, RefObject, useState } from "react"
import { CopyButton } from "@/components/common/CopyButton"
import MarkdownBlock from "@/components/common/MarkdownBlock"
import { Button } from "@/components/ui/button"
import { StateServiceClient } from "@/services/grpc-client"
import AsideButton from "./AsideButton"
import { QuoteButtonState } from "./ChatRow"
import QuoteButton from "./QuoteButton"

interface PlanCompletionOutputProps {
	text: string
	/** Shows "Continue in Act", which switches the mode to Act. */
	showContinueInAct?: boolean
	/** Shows the Aside action, branching the conversation at this message. */
	asideFromTs?: number
	/** Highlight-to-quote wiring; scoped to the content area, not the header/actions. */
	quoteButtonState?: QuoteButtonState
	handleQuoteClick?: () => void
	onMouseUp?: (event: MouseEvent<HTMLDivElement>) => void
	contentRef?: RefObject<HTMLDivElement>
}

/**
 * Answer card for the turn-final response in Ask mode (internal mode "plan"):
 * rendered for `plan_mode_respond` and `plan_completion_result`. Tinted with
 * the Ask accent (matching the mode toggle), with a small "Answer" label, a
 * copy button and, on the latest answer while still in Ask, "Continue in Act".
 */
const PlanCompletionOutputRow = memo(
	({
		text,
		showContinueInAct = false,
		asideFromTs,
		quoteButtonState,
		handleQuoteClick,
		onMouseUp,
		contentRef,
	}: PlanCompletionOutputProps) => {
		const [switching, setSwitching] = useState(false)

		const continueInAct = () => {
			setSwitching(true)
			StateServiceClient.togglePlanActModeProto(TogglePlanActModeRequest.create({ mode: PlanActMode.ACT }))
				.catch((error) => console.error("Failed to switch to Act mode:", error))
				.finally(() => setSwitching(false))
		}

		return (
			<div className="rounded-sm border border-warning/20 overflow-visible bg-warning/10">
				<div className="flex items-center justify-between gap-2 pl-2 pr-1 pt-1 -mb-1.5">
					<span className="text-xs font-medium uppercase tracking-wider text-warning/70">Answer</span>
					<div className="flex items-center">
						{asideFromTs !== undefined && <AsideButton className="text-warning/70" messageTs={asideFromTs} />}
						<CopyButton ariaLabel="Copy answer" className="text-warning/70" textToCopy={text} />
					</div>
				</div>
				<div
					className="plan-completion-content relative p-2 w-full [&_hr]:opacity-20 [&_p:last-child]:mb-0"
					onMouseUp={onMouseUp}
					ref={contentRef}>
					<div className="wrap-anywhere [&_hr]:opacity-20">
						<MarkdownBlock markdown={text} />
					</div>
					{quoteButtonState?.visible && handleQuoteClick && (
						<QuoteButton left={quoteButtonState.left} onClick={handleQuoteClick} top={quoteButtonState.top} />
					)}
				</div>
				{showContinueInAct && (
					<div className="flex justify-end px-2 pb-2">
						<Button disabled={switching} onClick={continueInAct} size="xs" variant="secondary">
							Continue in Act
						</Button>
					</div>
				)}
			</div>
		)
	},
)

PlanCompletionOutputRow.displayName = "PlanCompletionOutputRow"

export default PlanCompletionOutputRow
