import type { ApiConfiguration } from "@shared/api"
import type { TaskApiSelection } from "@shared/api-profiles"
import { Logger } from "@shared/services/Logger"
import type { Mode } from "@shared/storage/types"
import { type ApiProfileStore, resolveApiConfigurationForTaskSelection } from "@/core/controller/models/apiProfiles"
import { apiConfigurationForModelProfile, resolveModelProfile } from "@/core/controller/models/modelProfiles"
import { backgroundHandler, useModelSettings } from "./model-settings/background"
import { buildApiHandler } from "./sdk-api-handler"

/**
 * One-shot thread titles (Settings › Profiles › Text generation). Enabled
 * explicitly because it costs a model call per new thread. Runs once, after
 * the first message of a fresh thread; the stored flag plus the user-title
 * guard in applyGeneratedThreadTitle make regen impossible.
 */

export const THREAD_TITLE_MAX_WORDS = 8
const MAX_PROMPT_CHARS = 8000

// From T3 Code's thread-title prompt, less its rules for tools, git and images: this call has neither.
const SYSTEM_PROMPT = `Generate a title that will help the user recognize this Cline thread weeks later.
Return only JSON with the key title.

Before answering, silently reduce the request to:
- Subject: What system, feature, or problem is this really about?
- Outcome: What does the user ultimately want to understand or change?
- Incidental instructions: What only describes how the agent should do the work?

Title the subject and outcome. Discard incidental instructions.

Editorial rules:
- 3-${THREAD_TITLE_MAX_WORDS} words, fewer than 40 characters.
- Use a compact noun phrase or clear action phrase.
- Capture the umbrella goal when the request lists several symptoms or steps.
- Name the product change, not the mock, plan, report, branch, or PR used to produce it.
- Models, subagents, tools, output formats, and monitoring instructions do not belong in the title unless they are themselves the topic.
- For reviews, name what is being reviewed and the relevant concern.
- For research, name the question domain rather than the requested research process.
- Do not claim the work is complete.
- Do not copy and truncate the user's message.
- Avoid project names already visible in the UI, quotes, labels, filler, and trailing punctuation.
- If a linked PR or issue is the only source of the subject, use the user's stated action plus its number, such as "Take Over PR 8588". This is the one case where a PR or issue number belongs in the title.`

/** The title from the model's JSON reply; a model that ignores the format still gets its first line used. */
export function titleFromReply(reply: string): string {
	const json = reply.match(/\{[\s\S]*\}/)?.[0]
	if (json) {
		try {
			const title = (JSON.parse(json) as { title?: unknown }).title
			if (typeof title === "string") return sanitizeThreadTitle(title)
		} catch {
			// Not JSON after all: fall through to the plain-text reading.
		}
	}
	return sanitizeThreadTitle(reply)
}

export interface ThreadTitleDeps {
	store: ApiProfileStore
	/** Title ownership flags; an existing title or the one-shot flag skips the model call. */
	getTitleState: (taskId: string) => Promise<{ hasTitle: boolean; generated: boolean }>
	/** Atomic guarded write; resolves false when a title or the flag exists. */
	applyTitle: (taskId: string, title: string) => Promise<boolean>
}

export function sanitizeThreadTitle(raw: string): string {
	const firstLine = raw.split(/\r?\n/, 1)[0] ?? ""
	const cleaned = firstLine
		.replace(/["`]/g, "")
		.replace(/^[#>*_~'\-\s]+|[#>*_~'\-.,…\s]+$/g, "")
		.trim()
	return cleaned.split(/\s+/).filter(Boolean).slice(0, THREAD_TITLE_MAX_WORDS).join(" ")
}

/**
 * The configuration and mode the thread itself started with: the profile and
 * effort pinned to it (composer overrides included) in the mode it runs in.
 * Title generation for "Same as thread" must use this, never whatever the
 * global Act configuration happens to be.
 */
export interface ThreadTitleSource {
	mode: Mode
	selection?: TaskApiSelection
}

/** Chosen profile (its configuration at its effort), else the thread's own captured configuration and mode. */
function resolveTitleApiConfiguration(
	store: ApiProfileStore,
	thread: ThreadTitleSource | undefined,
): { configuration: ApiConfiguration; mode: Mode; reasoning: boolean } {
	const resolved = resolveModelProfile(store, store.getGlobalStateKey("threadTitlesModelProfileId"))
	if (resolved) {
		return {
			configuration: apiConfigurationForModelProfile(store, resolved.profile.id, "act"),
			mode: "act",
			// A title is tiny: only reason when the profile asks for it.
			reasoning: resolved.reasoningEffort !== "none",
		}
	}
	if (thread) {
		return {
			configuration: resolveApiConfigurationForTaskSelection(
				store,
				store.getApiConfiguration(),
				thread.mode,
				thread.selection,
			),
			mode: thread.mode,
			reasoning: false,
		}
	}
	return { configuration: store.getApiConfiguration(), mode: "act", reasoning: false }
}

export async function maybeGenerateThreadTitle(
	deps: ThreadTitleDeps,
	taskId: string,
	firstMessage: string,
	thread?: ThreadTitleSource,
): Promise<void> {
	const { store, applyTitle, getTitleState } = deps
	if (
		useModelSettings(store)
			? !store.getGlobalStateKey("modelSettings")?.roles.background.titlesEnabled
			: store.getGlobalStateKey("threadTitlesEnabled") !== true
	)
		return
	const message = firstMessage.trim()
	if (!message) return
	try {
		// Read before calling the model: a user title or an earlier generation
		// must not even spend the tokens.
		const titleState = await getTitleState(taskId)
		if (titleState.hasTitle || titleState.generated) return
		const { configuration, mode, reasoning } = resolveTitleApiConfiguration(store, thread)
		const handler = useModelSettings(store)
			? await backgroundHandler(store, "titles")
			: buildApiHandler(configuration, mode, { disableReasoning: !reasoning })
		if (!handler) return
		const stream = handler.createMessage(SYSTEM_PROMPT, [
			{ role: "user", content: `User message:\n${message.slice(0, MAX_PROMPT_CHARS)}` },
		])
		let response = ""
		let streamError: string | undefined
		for await (const chunk of stream) {
			if (chunk.type === "text") response += chunk.text
			else if (chunk.type === "done" && chunk.success === false) streamError = chunk.error
		}
		if (streamError) {
			Logger.warn(`[ThreadTitle] Generation failed for ${taskId}: ${streamError}`)
			return
		}
		const title = titleFromReply(response)
		if (title) await applyTitle(taskId, title)
	} catch (error) {
		Logger.warn(`[ThreadTitle] Failed to generate a title for ${taskId}:`, error)
	}
}
