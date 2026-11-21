import { useState } from "react"
import { InlineNotice } from "@/components/common/InlineNotice"
import { Button } from "@/components/ui/button"
import { useReducedMotionPreference } from "@/hooks/useReducedMotionPreference"
import { pickSkillset } from "./skillsetImport"

/**
 * Add skillset… and Share… at the top of the Skills and Workflows tabs, with
 * the one line that teaches the drop (VS Code needs Shift held to drop files
 * into a panel, and the panel can't hint during the drag).
 */
export function SkillsetToolbar({ onShare, onAdded }: { onShare: () => void; onAdded: (setId: string) => void }) {
	const still = useReducedMotionPreference()
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string>()
	const add = async () => {
		setBusy(true)
		setError(undefined)
		try {
			const result = await pickSkillset(still)
			if (result.set) onAdded(result.set.id)
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error))
		} finally {
			setBusy(false)
		}
	}
	return (
		<div className="mb-3" data-testid="skillset-toolbar">
			<div className="flex flex-wrap items-center gap-1.5">
				<Button disabled={busy} onClick={() => void add()} size="xs" variant="secondary">
					<span aria-hidden className="codicon codicon-add text-[12px]!" />
					Add skillset…
				</Button>
				<Button onClick={onShare} size="xs" variant="secondary">
					<span aria-hidden className="codicon codicon-export text-[12px]!" />
					Share…
				</Button>
			</div>
			<p className="m-0 mt-1 text-[11px] text-description">
				Got a <span className="font-mono">.skillset.zip</span>? Hold <kbd className="font-sans">Shift</kbd> and drop it
				anywhere on Cline.
			</p>
			{error && (
				<InlineNotice className="mt-1.5" tone="error">
					{error}
				</InlineNotice>
			)}
		</div>
	)
}
