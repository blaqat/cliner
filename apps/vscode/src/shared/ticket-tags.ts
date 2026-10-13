// Ticket references in user messages, found by regex only (no model calls).
// Jira/Linear keys (`PROJ-123`) and Jira, Linear and GitHub issue URLs.

import type { TaskTag } from "./task-groups"

const TICKET_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/g
const LINEAR_URL = /\blinear\.app\/[\w-]+\/issue\/([a-z][a-z0-9]+-\d+)/gi
const GITHUB_ISSUE_URL = /\bgithub\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)\b/gi

// Common uppercase-dash-number strings that aren't tickets (UTF-8, SHA-256, ISO-8601…).
const NON_TICKET_PREFIXES = new Set(["UTF", "SHA", "ISO", "AES", "RSA", "GPT", "HTTP", "TLS", "SSL", "IPV", "CVE", "RFC", "ES"])

/** Ticket keys and `owner/repo#N` references in `text`, deduped, in order of appearance. */
export function extractTicketTags(text: string | undefined): string[] {
	if (!text) return []
	const found: { index: number; value: string }[] = []
	for (const match of text.matchAll(GITHUB_ISSUE_URL)) {
		found.push({ index: match.index ?? 0, value: `${match[1]}/${match[2]}#${match[3]}` })
	}
	// Linear URLs are sometimes lowercased; the key regex below only sees uppercase.
	for (const match of text.matchAll(LINEAR_URL)) {
		found.push({ index: match.index ?? 0, value: match[1].toUpperCase() })
	}
	// Jira URLs (`…/browse/PROJ-1`, `?selectedIssue=PROJ-1`) carry the key itself.
	for (const match of text.matchAll(TICKET_KEY)) {
		if (!NON_TICKET_PREFIXES.has(match[0].slice(0, match[0].indexOf("-")))) {
			found.push({ index: match.index ?? 0, value: match[0] })
		}
	}
	const seen = new Set<string>()
	return found
		.sort((a, b) => a.index - b.index)
		.map((entry) => entry.value)
		.filter((value) => {
			const key = value.toLowerCase()
			if (seen.has(key)) return false
			seen.add(key)
			return true
		})
}

/**
 * `tags` plus auto ticket tags for `detected` values that aren't already tagged
 * (any kind) or dismissed by the user. Returns undefined when nothing changes.
 */
export function mergeAutoTicketTags(
	tags: readonly TaskTag[] | undefined,
	detected: readonly string[],
	dismissed: readonly string[] | undefined,
): TaskTag[] | undefined {
	const taken = new Set([...(tags ?? []).map((tag) => tag.value), ...(dismissed ?? [])].map((value) => value.toLowerCase()))
	const added: TaskTag[] = []
	for (const value of detected) {
		if (taken.has(value.toLowerCase())) continue
		taken.add(value.toLowerCase())
		added.push({ kind: "ticket", value, source: "auto" })
	}
	return added.length ? [...(tags ?? []), ...added] : undefined
}
