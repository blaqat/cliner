import { extractTicketTags } from "@shared/ticket-tags"
import { memo, useMemo } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { TaskTagChip } from "./TaskTagChip"

/**
 * Dashed chips under the composer for ticket keys in the draft that the thread
 * isn't tagged with yet. They're added as auto tags when the message is sent.
 */
const DetectedTicketChips = ({ text }: { text: string }) => {
	const { currentTaskItem } = useExtensionState()
	const detected = useMemo(() => {
		const known = new Set(
			[...(currentTaskItem?.tags ?? []).map((tag) => tag.value), ...(currentTaskItem?.dismissedAutoTags ?? [])].map(
				(value) => value.toLowerCase(),
			),
		)
		return extractTicketTags(text).filter((value) => !known.has(value.toLowerCase()))
	}, [text, currentTaskItem?.tags, currentTaskItem?.dismissedAutoTags])

	if (!detected.length) return null
	return (
		<div className="flex min-w-0 items-center gap-1 overflow-hidden px-3.5 pb-1.5" data-testid="detected-ticket-chips">
			{detected.map((value) => (
				<TaskTagChip detected key={value} kind="ticket" value={value} />
			))}
			<span className="shrink-0 text-[10.5px] text-description">
				{detected.length === 1 ? "tag found in message" : "tags found in message"}
			</span>
		</div>
	)
}

export default memo(DetectedTicketChips)
