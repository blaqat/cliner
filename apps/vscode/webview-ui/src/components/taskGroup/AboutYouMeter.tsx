import { ABOUT_YOU_ID, ABOUT_YOU_TOKEN_CAP, ABOUT_YOU_WARN_TOKENS } from "@shared/task-groups"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { useTaskGroup } from "./useTaskGroup"

export type AboutYouLevel = "ok" | "warn" | "full"

export function aboutYouLevel(tokens: number): AboutYouLevel {
	return tokens > ABOUT_YOU_TOKEN_CAP ? "full" : tokens >= ABOUT_YOU_WARN_TOKENS ? "warn" : "ok"
}

/** Why adding is blocked or nearly so, in one line; undefined while there's room. */
export function aboutYouLimitReason(tokens: number): string | undefined {
	if (tokens > ABOUT_YOU_TOKEN_CAP) return "Over the cap. Shorten or delete a line to save."
	if (tokens >= ABOUT_YOU_TOKEN_CAP) return "About you is full. Shorten or delete a note to add more."
	if (tokens >= ABOUT_YOU_WARN_TOKENS) return "Nearly full. Cline can now only shorten or replace notes."
	return undefined
}

/**
 * About you's size: it is sent with every request, so the page always shows
 * what it costs. Warns from 750 tokens and blocks adds past 1,000.
 */
export function AboutYouMeter({ tokens, className }: { tokens: number; className?: string }) {
	const level = aboutYouLevel(tokens)
	const percent = Math.min(100, (tokens / ABOUT_YOU_TOKEN_CAP) * 100)
	return (
		<span
			aria-label={`About you size: about ${tokens} of ${ABOUT_YOU_TOKEN_CAP} tokens`}
			aria-valuemax={ABOUT_YOU_TOKEN_CAP}
			aria-valuemin={0}
			aria-valuenow={tokens}
			className={cn("inline-flex items-center gap-1.5 text-[11px]", className)}
			data-level={level}
			data-testid="about-you-meter"
			role="meter">
			<span className="relative h-1 w-16 shrink-0 overflow-hidden rounded-full bg-(--vscode-editorWidget-border)">
				<span
					className={cn(
						"absolute inset-y-0 left-0 rounded-full",
						level === "ok"
							? "bg-(--vscode-charts-purple)"
							: level === "warn"
								? "bg-(--vscode-editorWarning-foreground)"
								: "bg-(--vscode-errorForeground)",
					)}
					style={{ width: `${percent}%` }}
				/>
			</span>
			<span
				className={cn(
					level === "ok"
						? "text-description"
						: level === "warn"
							? "text-(--vscode-editorWarning-foreground)"
							: "text-(--vscode-errorForeground)",
				)}>
				≈ {tokens.toLocaleString("en-US")} / {ABOUT_YOU_TOKEN_CAP.toLocaleString("en-US")} tokens
			</span>
		</span>
	)
}

/**
 * In the composer's context details: what About you adds to every request, and a way to it.
 * Mounted only while the details are open, so it costs nothing otherwise.
 */
export function AboutYouContextLine({ onOpen }: { onOpen?: () => void }) {
	const { navigateToTaskGroup } = useExtensionState()
	const { details, missing } = useTaskGroup(ABOUT_YOU_ID)
	if (missing) return null
	const notes = details?.notes ?? []
	const tokens = notes.reduce((sum, note) => sum + (note.tokens ?? 0), 0)
	return (
		<button
			className="mt-2 flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-xs border-0 bg-transparent p-0 text-left text-[11px] text-description hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
			data-testid="about-you-context-line"
			onClick={() => {
				onOpen?.()
				navigateToTaskGroup(ABOUT_YOU_ID, "notebook")
			}}
			title="Open About you: notes sent with every request"
			type="button">
			<span aria-hidden className="codicon codicon-account text-[12px] text-(--vscode-charts-purple)" />
			<span className="min-w-0 flex-1 truncate">
				About you{" "}
				{details
					? notes.length
						? `· ${notes.length} ${notes.length === 1 ? "note" : "notes"}, sent with every request`
						: "· empty"
					: "…"}
			</span>
			{details && notes.length > 0 && (
				<span
					className={cn(
						"shrink-0 tabular-nums",
						aboutYouLevel(tokens) === "warn" && "text-(--vscode-editorWarning-foreground)",
						aboutYouLevel(tokens) === "full" && "text-(--vscode-errorForeground)",
					)}>
					≈ {tokens.toLocaleString("en-US")} tokens
				</span>
			)}
		</button>
	)
}
