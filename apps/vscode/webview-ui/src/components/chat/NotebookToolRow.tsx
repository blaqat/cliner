/**
 * Compact row for the `notebook` tool. The tool message carries the tool input
 * (`{ action, name, description?, content? }`); `names` lets a merged read list
 * several notes, and `path` is the generic translator's fallback for the name.
 */
export interface NotebookToolInfo {
	action: "read" | "write" | "delete"
	names: string[]
}

export function parseNotebookTool(tool: unknown): NotebookToolInfo | null {
	if (!tool || typeof tool !== "object") return null
	const record = tool as Record<string, unknown>
	if (record.tool !== "notebook") return null
	const action = record.action === "write" || record.action === "delete" ? record.action : "read"
	const names = Array.isArray(record.names)
		? record.names.filter((name): name is string => typeof name === "string" && name.length > 0)
		: [record.name, record.path].filter((name): name is string => typeof name === "string" && name.length > 0).slice(0, 1)
	return { action, names }
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

export function NotebookToolRow({ info }: { info: NotebookToolInfo }) {
	const staged = info.action !== "read"
	const count = Math.max(info.names.length, 1)
	return (
		<div
			className="flex flex-wrap items-center gap-1.5 rounded-xs border border-editor-group-border bg-code px-2.5 py-1.5 text-xs"
			data-testid="notebook-tool-row">
			<i aria-hidden className="codicon codicon-book text-[var(--vscode-charts-purple)]" />
			{staged ? (
				<>
					<span>{`Staged ${count} notebook change${count === 1 ? "" : "s"}`}</span>
					<span className="flex-1" />
					<span className="text-[11px] text-description">reviewed at the end</span>
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
