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

export function buildMessageLink(extensionId: string, threadId: string, messageIndex: number): string {
	return `vscode://${extensionId}${MESSAGE_LINK_PATH_PREFIX}${encodeURIComponent(threadId)}?m=${messageIndex}`
}

export interface ParsedMessageLink {
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
	return { threadId, messageIndex }
}
