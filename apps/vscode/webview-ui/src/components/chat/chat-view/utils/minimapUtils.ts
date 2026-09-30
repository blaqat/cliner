import type { ClineMessage, ClinePlanModeResponse } from "@shared/ExtensionMessage"

export interface MinimapItem {
	/** Index into the rendered (grouped) list, for scrollToIndex. */
	index: number
	ts: number
	role: "user" | "agent"
	snippet: string
	/** The reply is still streaming. */
	streaming: boolean
}

const SNIPPET_LENGTH = 140

function toSnippet(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim()
	return flat.length > SNIPPET_LENGTH ? `${flat.slice(0, SNIPPET_LENGTH - 1)}…` : flat
}

function agentText(message: ClineMessage): string | undefined {
	if (message.type === "say" && (message.say === "text" || message.say === "completion_result")) {
		return message.text
	}
	if (message.type === "say" && message.say === "plan_completion_result") {
		return message.text
	}
	if (message.type === "ask" && (message.ask === "plan_mode_respond" || message.ask === "followup")) {
		try {
			const parsed = JSON.parse(message.text || "{}") as ClinePlanModeResponse & { question?: string }
			return parsed.response ?? parsed.question ?? message.text
		} catch {
			return message.text
		}
	}
	return undefined
}

/**
 * One minimap square per user message and per assistant text/answer row.
 * Tool groups, browser sessions, reasoning and other noise rows are skipped.
 */
export function getMinimapItems(rows: readonly (ClineMessage | ClineMessage[])[]): MinimapItem[] {
	const items: MinimapItem[] = []
	rows.forEach((row, index) => {
		if (Array.isArray(row)) {
			return
		}
		if (row.type === "say" && row.say === "user_feedback") {
			const text = row.text?.trim() || (row.images?.length || row.files?.length ? "(attachments)" : "")
			if (text) {
				items.push({ index, ts: row.ts, role: "user", snippet: toSnippet(text), streaming: false })
			}
			return
		}
		const text = agentText(row)?.trim()
		if (text) {
			items.push({ index, ts: row.ts, role: "agent", snippet: toSnippet(text), streaming: row.partial === true })
		}
	})
	return items
}

/** The item for the row at the top of the viewport: the last item at or before `topIndex`. */
export function getCurrentMinimapItem(items: readonly MinimapItem[], topIndex: number): MinimapItem | undefined {
	let current: MinimapItem | undefined
	for (const item of items) {
		if (item.index > topIndex) {
			break
		}
		current = item
	}
	return current ?? items[0]
}
