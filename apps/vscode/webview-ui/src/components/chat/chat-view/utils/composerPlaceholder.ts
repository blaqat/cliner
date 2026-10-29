/**
 * The composer's one hint: where you are, then what @ and / do. It never starts with "@", which
 * read as a label for the 📎 button right under it.
 */
export function composerPlaceholder({ inThread, onTaskPage }: { inThread: boolean; onTaskPage: boolean }): string {
	if (onTaskPage && !inThread) return "New thread in this task · @ for context, / for commands"
	if (inThread) return "Message Cline · @ for context, / for commands"
	return "Ask Cline anything · @ for context, / for commands"
}
