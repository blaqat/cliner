import { agentLaterAge, formatAge, type InboxRow } from "@/components/inbox/inboxUtils"

/** From this many days on, a list row's time is a date: "12d" makes you do the math. */
export const DATE_AFTER_DAYS = 5

const DAY_MS = 86_400_000

/** "Oct 29", or "Oct 29, 2025" when it isn't this year. */
export function formatShortDate(ts: number, now: number): string {
	const date = new Date(ts)
	const sameYear = date.getFullYear() === new Date(now).getFullYear()
	return date.toLocaleDateString(
		"en-US",
		sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" },
	)
}

/** "Oct 29, 2026, 3:04 PM": the tooltip's exact moment. */
export function formatFullDate(ts: number): string {
	return new Date(ts).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
}

/**
 * A one-view row's time: "now", "5m", "3h", "2d" for the first days, then the date ("Oct 29").
 */
export function formatListTime(ts: number, now: number): string {
	if (now - ts >= DATE_AFTER_DAYS * DAY_MS) return formatShortDate(ts, now)
	return formatAge(ts, now)
}

const ago = (age: string) => (age === "now" ? "just now" : `${age} ago`)

/** The time slot's tooltip: "Your last message 12d ago (Oct 17, 2026, 3:04 PM) · agent 3d ago (…)". */
export function listTimeTitle(row: Pick<InboxRow, "activityTs" | "agentActivityTs">, now: number): string {
	const later = agentLaterAge(row, now)
	return [
		`Your last message ${ago(formatAge(row.activityTs, now))} (${formatFullDate(row.activityTs)})`,
		later && `agent ${ago(later)} (${formatFullDate(row.agentActivityTs)})`,
	]
		.filter(Boolean)
		.join(" · ")
}
