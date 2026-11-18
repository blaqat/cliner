import { WroteNoteChip } from "./NotebookChangesRow"

/**
 * Compact row for the `notebook` tool. The tool message carries the tool input
 * (`{ action, name, description?, content? }`); `names` lets a merged read list
 * several notes, and `path` is the generic translator's fallback for the name.
 */
export interface NotebookToolInfo {
	action: "read" | "write" | "delete"
	names: string[]
	/** The `about_you` tool: a proposed change to About you. */
	aboutYou?: boolean
}

export function parseNotebookTool(tool: unknown): NotebookToolInfo | null {
	if (!tool || typeof tool !== "object") return null
	const record = tool as Record<string, unknown>
	if (record.tool !== "notebook") return null
	const action = record.action === "write" || record.action === "delete" ? record.action : "read"
	const names = Array.isArray(record.names)
		? record.names.filter((name): name is string => typeof name === "string" && name.length > 0)
		: [record.name, record.path].filter((name): name is string => typeof name === "string" && name.length > 0).slice(0, 1)
	return record.aboutYou === true ? { action, names, aboutYou: true } : { action, names }
}

/** A note this thread read: neutral dashed chip with an eye, matching the task page timeline. */
export function ReadNoteChip({ name }: { name: string }) {
	return (
		<span className="inline-flex max-w-40 min-w-0 items-center gap-1 rounded-xs border border-dashed border-description/60 px-1.5 text-[11px] leading-4 text-description">
			<i aria-hidden className="codicon codicon-eye text-[10px]!" />
			<span className="truncate">{name}</span>
		</span>
	)
}

/**
 * Reads show the notes read; writes and deletes show what was written, as the
 * same chips the review row uses. Nothing applies until the user keeps it in
 * the review row at the end of the turn.
 */
export function NotebookToolRow({ info }: { info: NotebookToolInfo }) {
	const staged = info.action !== "read"
	return (
		<div
			className="flex flex-wrap items-center gap-1.5 rounded-xs border border-editor-group-border bg-code px-2.5 py-1.5 text-xs"
			data-testid="notebook-tool-row">
			<i
				aria-hidden
				className={`codicon ${info.aboutYou ? "codicon-account" : "codicon-book"} text-[var(--vscode-charts-purple)]`}
			/>
			{staged ? (
				<>
					<span>{info.action === "delete" ? "Wants to delete" : "Wrote"}</span>
					{info.names.map((name) => (
						<WroteNoteChip key={name} name={info.aboutYou ? `About you › ${name}` : name} />
					))}
					<span className="flex-1" />
					<span className="text-[11px] text-description">you keep it at the end</span>
				</>
			) : (
				<>
					<span>Read notebook</span>
					{info.names.map((name) => (
						<ReadNoteChip key={name} name={name} />
					))}
				</>
			)}
		</div>
	)
}
