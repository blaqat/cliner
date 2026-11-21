import type { SkillItemFile } from "@shared/skillsets"
import { cn } from "@/lib/utils"

/** "New": a set's item nobody has turned on yet. */
export function NewBadge() {
	return (
		<span className="shrink-0 rounded-full bg-(--vscode-badge-background) px-1.5 text-[10px] leading-4 font-medium text-(--vscode-badge-foreground)">
			New
		</span>
	)
}

/** Marks a skill (or one file) that has scripts Cline can run. */
export function RunsCodeChip({ label = "Runs code", className }: { label?: string; className?: string }) {
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center gap-1 rounded-xs border border-solid border-(--vscode-inputValidation-warningBorder) px-1 text-[10px] leading-4 text-warning",
				className,
			)}
			title="Has scripts Cline can run. Your command approvals still apply.">
			<span aria-hidden className="codicon codicon-terminal text-[10px]!" />
			{label}
		</span>
	)
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`
}

/** What a file is for, in a word: the skill's instructions, a reference, a script. */
function fileRole(file: SkillItemFile): string {
	if (file.path === "SKILL.md") return "instructions"
	if (file.runsCode) return "script"
	if (/\.md$/i.test(file.path)) return "reference"
	return formatSize(file.size)
}

/** A skill's files, one per line, scripts flagged. Clicking a file opens it. */
export function SkillFileList({ files, onOpen }: { files: SkillItemFile[]; onOpen?: (file: SkillItemFile) => void }) {
	return (
		<ul className="m-0 flex list-none flex-col gap-0.5 p-0" data-testid="skill-file-list">
			{files.map((file) => (
				<li className="flex min-w-0 items-center gap-1.5 text-[11px]" key={file.path}>
					<span
						aria-hidden
						className={cn(
							"codicon shrink-0 text-[11px]!",
							file.runsCode ? "codicon-terminal text-warning" : "codicon-file text-description",
						)}
					/>
					{onOpen ? (
						<button
							className="min-w-0 cursor-pointer truncate border-0 bg-transparent p-0 text-left font-mono text-[11px] text-foreground hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
							onClick={() => onOpen(file)}
							title={`Open ${file.path}`}
							type="button">
							{file.path}
						</button>
					) : (
						<span className="min-w-0 truncate font-mono">{file.path}</span>
					)}
					{file.runsCode ? <RunsCodeChip /> : <span className="shrink-0 text-description">{fileRole(file)}</span>}
				</li>
			))}
		</ul>
	)
}
