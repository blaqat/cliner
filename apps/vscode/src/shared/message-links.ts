/**
 * Deep links to a single chat message: `vscode://<extension-id>/thread/<threadId>?m=<index>`.
 *
 * `<index>` is the message's index into the SDK transcript
 * (`ClineMessage.sdkMessageIndex`), which is stable across reloads — unlike the
 * minted `ClineMessage.ts`, which is regenerated per render. The authority is
 * the *installed* extension id (`saoudrizwan.cliner` in the fork build,
 * `saoudrizwan.claude-dev` in dev), so the same handler path works in both.
 */
export const MESSAGE_LINK_PATH_PREFIX = "/thread/"

/**
 * Optional row anchor inside the transcript message. One SDK message can render
 * as several rows, and completion-tool rows (`attempt_completion` /
 * `submit_and_exit`) come from tool input, not text blocks:
 * - `toolCallId` (`t`): the tool call the row was rendered from.
 * - `block` (`b`): the ordinal of the row among the message's rendered text rows.
 * Links without either (the original format) still parse and resolve to the
 * whole message.
 */
export interface MessageLinkAnchor {
	toolCallId?: string
	block?: number
}

export function buildMessageLink(
	extensionId: string,
	threadId: string,
	messageIndex: number,
	anchor: MessageLinkAnchor = {},
): string {
	return `vscode://${extensionId}${buildMessageLinkPath(threadId, messageIndex, anchor)}`
}

/** The path + query part of a message link (what the host's callback-URL builder wants). */
export function buildMessageLinkPath(threadId: string, messageIndex: number, anchor: MessageLinkAnchor = {}): string {
	let path = `${MESSAGE_LINK_PATH_PREFIX}${encodeURIComponent(threadId)}?m=${messageIndex}`
	if (anchor.toolCallId) path += `&t=${encodeURIComponent(anchor.toolCallId)}`
	else if (anchor.block !== undefined) path += `&b=${anchor.block}`
	return path
}

export interface ParsedMessageLink extends MessageLinkAnchor {
	threadId: string
	messageIndex: number
}

/**
 * Parses a message link back into its target. Accepts any `vscode://`
 * authority: links copied while the extension was installed under a different
 * id (e.g. after a rename) should still resolve.
 */
export function parseMessageLink(url: string): ParsedMessageLink | undefined {
	let parsed: URL
	try {
		parsed = new URL(url.trim())
	} catch {
		return undefined
	}
	if (parsed.protocol !== "vscode:") {
		return undefined
	}
	const match = new RegExp(`^${MESSAGE_LINK_PATH_PREFIX.replace(/\//g, "\\/")}([^/?#]+)\\/?$`).exec(parsed.pathname)
	if (!match) {
		return undefined
	}
	const threadId = decodeURIComponent(match[1])
	// Number(null) and Number("") are 0, so require explicit digits.
	const rawIndex = parsed.searchParams.get("m") ?? ""
	const messageIndex = Number(rawIndex)
	if (!threadId || !/^\d+$/.test(rawIndex) || !Number.isSafeInteger(messageIndex)) {
		return undefined
	}
	const toolCallId = parsed.searchParams.get("t") || undefined
	const rawBlock = parsed.searchParams.get("b") ?? ""
	const block = /^\d+$/.test(rawBlock) && Number.isSafeInteger(Number(rawBlock)) ? Number(rawBlock) : undefined
	return { threadId, messageIndex, ...(toolCallId ? { toolCallId } : {}), ...(block !== undefined ? { block } : {}) }
}
