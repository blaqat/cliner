/**
 * Some servers and gateways put a model's reasoning in its reply text as `<think>…</think>` (or only the
 * closing tag, when the chat template opened it). Display only: what goes back to the model is unchanged.
 */
export interface SplitThinking {
	/** The reasoning, when the text carries any. */
	thinking?: string
	/** The reasoning is still streaming: no closing tag yet. */
	thinkingOpen: boolean
	answer: string
}

const OPEN = "<think>"
const CLOSE = "</think>"

export function splitThinkTags(text: string, streaming: boolean): SplitThinking {
	const start = text.trimStart()
	if (start.startsWith(OPEN)) {
		const body = start.slice(OPEN.length)
		const close = body.indexOf(CLOSE)
		if (close < 0) return { thinking: body.trim(), thinkingOpen: streaming, answer: "" }
		return { thinking: body.slice(0, close).trim(), thinkingOpen: false, answer: body.slice(close + CLOSE.length).trim() }
	}
	// A lone closing tag counts only where a model writes it, ending its line; an answer can mention one mid-sentence.
	const lone = /<\/think>[ \t]*(?:\r?\n|$)/.exec(text)
	if (lone && lone.index > 0 && !text.slice(0, lone.index).includes(OPEN)) {
		return {
			thinking: text.slice(0, lone.index).trim(),
			thinkingOpen: false,
			answer: text.slice(lone.index + CLOSE.length).trim(),
		}
	}
	return { thinkingOpen: false, answer: text }
}
