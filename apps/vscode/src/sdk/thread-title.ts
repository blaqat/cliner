import type { ApiConfiguration } from "@shared/api"
import type { TaskApiSelection } from "@shared/api-profiles"
import { Logger } from "@shared/services/Logger"
import type { Mode } from "@shared/storage/types"
import { type ApiProfileStore, resolveApiConfigurationForTaskSelection } from "@/core/controller/models/apiProfiles"
import { apiConfigurationForModelProfile, resolveModelProfile } from "@/core/controller/models/modelProfiles"
import { buildApiHandler } from "./sdk-api-handler"

/**
 * One-shot thread titles (Settings › Profiles › Text generation). Enabled
 * explicitly because it costs a model call per new thread. Runs once, after
 * the first message of a fresh thread; the stored flag plus the user-title
 * guard in applyGeneratedThreadTitle make regen impossible.
 */

export const THREAD_TITLE_MAX_WORDS = 8
const MAX_PROMPT_CHARS = 2000

const SYSTEM_PROMPT = `You name conversations. Reply with a short title for the user's first message: plain text, no quotes, no emoji, no trailing punctuation, at most ${THREAD_TITLE_MAX_WORDS} words.`

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
		.replace(/["'`]/g, "")
		.replace(/^[#>*_~\-\s]+|[#>*_~\-.,…\s]+$/g, "")
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
	if (store.getGlobalStateKey("threadTitlesEnabled") !== true) return
	const message = firstMessage.trim()
	if (!message) return
	try {
		// Read before calling the model: a user title or an earlier generation
		// must not even spend the tokens.
		const titleState = await getTitleState(taskId)
		if (titleState.hasTitle || titleState.generated) return
		const { configuration, mode, reasoning } = resolveTitleApiConfiguration(store, thread)
		const handler = buildApiHandler(configuration, mode, { disableReasoning: !reasoning })
		const stream = handler.createMessage(SYSTEM_PROMPT, [
			{ role: "user", content: `Name this conversation:\n\n${message.slice(0, MAX_PROMPT_CHARS)}` },
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
		const title = sanitizeThreadTitle(response)
		if (title) await applyTitle(taskId, title)
	} catch (error) {
		Logger.warn(`[ThreadTitle] Failed to generate a title for ${taskId}:`, error)
	}
}
