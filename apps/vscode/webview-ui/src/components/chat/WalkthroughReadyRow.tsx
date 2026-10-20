import type { ClineMessage } from "@shared/ExtensionMessage"
import { StringRequest } from "@shared/proto/cline/common"
import type { WalkthroughOrigin, WalkthroughReadyMessage } from "@shared/Walkthrough"
import { useMemo } from "react"
import { LinkButton } from "@/components/common/LinkButton"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { UiServiceClient } from "@/services/grpc-client"

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

const openExternal = (url: string) =>
	UiServiceClient.openUrl(StringRequest.create({ value: url })).catch((err) =>
		console.error("Failed to open walkthrough origin:", err),
	)

const originOf = (origin: WalkthroughOrigin | undefined): WalkthroughOrigin | undefined => {
	if (!origin || typeof origin.label !== "string" || !origin.label) return undefined
	return { label: origin.label, url: typeof origin.url === "string" ? origin.url : undefined }
}

/** Parses a `walkthrough_ready` message text. Anything malformed returns null so the row renders nothing. */
export function parseWalkthroughReady(text: string | undefined): WalkthroughReadyMessage | null {
	if (!text) return null
	try {
		const parsed = JSON.parse(text) as Partial<WalkthroughReadyMessage> | null
		if (!parsed || typeof parsed !== "object" || typeof parsed.authoredId !== "string" || !parsed.authoredId) {
			return null
		}
		return {
			authoredId: parsed.authoredId,
			title: typeof parsed.title === "string" && parsed.title ? parsed.title : "Walkthrough",
			origin: originOf(parsed.origin),
			stopCount: typeof parsed.stopCount === "number" ? parsed.stopCount : 0,
			fileCount: typeof parsed.fileCount === "number" ? parsed.fileCount : 0,
		}
	} catch {
		return null
	}
}

/**
 * The card a `present_walkthrough` call leaves in the thread: what the agent
 * authored, where the change lives, and a button that opens the walkthrough
 * page for that document — the same suggestion as "Open walkthrough" on the
 * completion block.
 */
export function WalkthroughReadyRow({ message }: { message: ClineMessage }) {
	const { navigateToWalkthrough } = useExtensionState()
	const payload = useMemo(() => parseWalkthroughReady(message.text), [message.text])
	if (!payload) return null
	const { authoredId, title, origin, stopCount, fileCount } = payload
	return (
		<div
			className="rounded-xs border border-solid border-editor-group-border bg-code px-2.5 py-2 text-xs"
			data-testid="walkthrough-ready">
			<div className="flex items-center gap-1.5">
				<span aria-hidden className="codicon codicon-diff shrink-0 text-[13px]! text-description" />
				<span className="min-w-0 flex-1 font-semibold break-words text-foreground">{title}</span>
				<span className="shrink-0 text-[11px] text-description">
					{plural(stopCount, "stop")} · {plural(fileCount, "file")}
				</span>
			</div>
			{origin && (
				<div className="mt-1 flex items-center gap-1 text-[11px] text-description">
					<span aria-hidden className="codicon codicon-link-external text-[11px]!" />
					{origin.url ? (
						<LinkButton onClick={() => openExternal(origin.url as string)} title={origin.url}>
							{origin.label}
						</LinkButton>
					) : (
						<span>{origin.label}</span>
					)}
				</div>
			)}
			<div className="mt-2">
				<Button
					className="h-6 gap-1.5 px-2"
					onClick={() => navigateToWalkthrough(authoredId)}
					size="xs"
					title="Review this walkthrough stop by stop"
					variant="secondary">
					<span aria-hidden className="codicon codicon-diff text-[14px]!" />
					Open walkthrough
				</Button>
			</div>
		</div>
	)
}
