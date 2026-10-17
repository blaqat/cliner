export interface ChatContent {
	message?: string
	images?: string[]
	files?: string[]
	/** The part of `message` the user typed (no quote chips or generated context). */
	typedMessage?: string
}
