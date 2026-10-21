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
		<div className="rounded-sm border border-solid border-link/30 bg-link/10" data-testid="walkthrough-ready">
			<div className="flex min-w-0 items-center gap-2 pl-2 pr-1.5 pt-1.5">
				<span className="shrink-0 text-xs font-medium uppercase tracking-wider text-link/80">Walkthrough</span>
				<span className="flex-1" />
				{origin && <OriginLink origin={origin} />}
			</div>
			<div className="px-2 pt-1 pb-2">
				<div className="text-[13px] leading-snug font-semibold break-words text-foreground">{title}</div>
				<div className="mt-0.5 text-[11px] text-description tabular-nums">
					{plural(stopCount, "stop")} · {plural(fileCount, "file")}
				</div>
				<Button
					className="mt-2 h-auto min-h-6.5 w-full gap-1.5 px-2 text-(length:--vscode-font-size)"
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

/** Where the change lives (e.g. the merge request); opens it when there's a URL. */
function OriginLink({ origin }: { origin: WalkthroughOrigin }) {
	const content = (
		<>
			<span className="min-w-0 truncate">{origin.label}</span>
			{origin.url && <span aria-hidden className="codicon codicon-link-external shrink-0 text-[11px]!" />}
		</>
	)
	const className = "inline-flex min-w-0 max-w-[60%] items-center gap-1 text-[11px]"
	return origin.url ? (
		<LinkButton
			className={className}
			data-testid="walkthrough-ready-origin"
			onClick={() => openExternal(origin.url as string)}
			title={origin.url}>
			{content}
		</LinkButton>
	) : (
		<span className={`${className} text-description`} data-testid="walkthrough-ready-origin">
			{content}
		</span>
	)
}
