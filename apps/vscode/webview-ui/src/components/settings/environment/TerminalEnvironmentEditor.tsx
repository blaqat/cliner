import { EmptyRequest } from "@shared/proto/cline/common"
import type { TerminalEnvironmentResolution, TerminalEnvironmentVariable } from "@shared/proto/cline/state"
import type { TerminalEnvironmentSettings } from "@shared/terminal-environment"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { Eye, EyeOff, Plus, X } from "lucide-react"
import { useMemo, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { StateServiceClient } from "@/services/grpc-client"
import { updateSetting } from "../utils/settingsHandlers"

/**
 * Terminal environment editor (Profiles → Used by is profiles; this lives in
 * Terminal settings). Two scopes: global applies everywhere, workspace
 * overrides per project and is stored in workspace state — never in the repo.
 * Values are masked behind one eye toggle and .env files are read at command
 * time only: their contents are never shown or stored here.
 */

type EnvScope = "global" | "workspace"

const SOURCE_LABELS: Record<string, string> = {
	process: "process",
	env_file: ".env",
	global: "global",
	workspace: "workspace",
}

function scopeVariables(scope: TerminalEnvironmentSettings | undefined): Record<string, string> {
	return scope?.variables ?? {}
}

function scopePathEntries(scope: TerminalEnvironmentSettings | undefined): string[] {
	return scope?.pathEntries ?? []
}

interface RowDraft {
	name: string
	value: string
}

function TerminalEnvironmentEditor() {
	const { terminalEnvironment } = useExtensionState()
	const [scope, setScope] = useState<EnvScope>("global")
	const [revealed, setRevealed] = useState(false)
	// value edits pending blur, keyed "scope:name"
	const [valueEdits, setValueEdits] = useState<Record<string, string>>({})
	const [newRows, setNewRows] = useState<Record<EnvScope, RowDraft>>({
		global: { name: "", value: "" },
		workspace: { name: "", value: "" },
	})
	const [newPath, setNewPath] = useState("")
	const [envPathEdit, setEnvPathEdit] = useState<string | undefined>(undefined)
	const [resolved, setResolved] = useState<TerminalEnvironmentVariable[] | undefined>(undefined)

	const stored = scope === "global" ? terminalEnvironment?.global : terminalEnvironment?.workspace
	const variables = scopeVariables(stored)
	const pathEntries = scopePathEntries(stored)
	const storedEnvFilePath = stored?.envFilePath ?? ""

	const commit = (patch: Partial<TerminalEnvironmentSettings>) => {
		updateSetting("terminalEnvironment", {
			workspace: scope === "workspace",
			variables: patch.variables ?? variables,
			envFilePath: patch.envFilePath !== undefined ? patch.envFilePath : storedEnvFilePath,
			pathEntries: patch.pathEntries ?? pathEntries,
		})
		// Stored values changed; the resolved preview may be stale.
		setResolved(undefined)
	}

	const commitVariables = (next: Record<string, string>) => commit({ variables: next })

	const editKey = `${scope}:`
	const draftValue = (name: string) => valueEdits[editKey + name] ?? variables[name] ?? ""

	const commitValueEdit = (name: string) => {
		const draft = valueEdits[editKey + name]
		if (draft === undefined) return
		setValueEdits((prev) => {
			const next = { ...prev }
			delete next[editKey + name]
			return next
		})
		if (draft !== variables[name]) commitVariables({ ...variables, [name]: draft })
	}

	const removeVariable = (name: string) => {
		const next = { ...variables }
		delete next[name]
		commitVariables(next)
	}

	const addVariable = () => {
		const draft = newRows[scope]
		const name = draft.name.trim()
		if (!name) return
		commitVariables({ ...variables, [name]: draft.value })
		setNewRows((prev) => ({ ...prev, [scope]: { name: "", value: "" } }))
	}

	const addPathEntry = () => {
		const entry = newPath.trim()
		if (!entry) return
		commit({ pathEntries: [...pathEntries, entry] })
		setNewPath("")
	}

	const removePathEntry = (index: number) => {
		commit({ pathEntries: pathEntries.filter((_, i) => i !== index) })
	}

	const commitEnvFilePath = () => {
		if (envPathEdit === undefined) return
		const value = envPathEdit.trim()
		setEnvPathEdit(undefined)
		if (value !== storedEnvFilePath) commit({ envFilePath: value })
	}

	const names = useMemo(() => Object.keys(variables).sort(), [variables])

	return (
		<div className="mb-4">
			<div className="font-medium mb-1">Environment</div>
			<p className="text-xs text-(--vscode-descriptionForeground) mb-2">
				Applied to every command Cline runs. Global is the default; workspace values override it and are stored outside
				the repo.
			</p>

			<div className="flex items-center gap-1 mb-2">
				{(["global", "workspace"] as const).map((option) => (
					<button
						aria-pressed={scope === option}
						className={`text-xs px-2 py-0.5 rounded-sm border border-solid cursor-pointer ${
							scope === option
								? "border-(--vscode-focusBorder) bg-(--vscode-list-activeSelectionBackground) text-(--vscode-list-activeSelectionForeground)"
								: "border-(--vscode-panel-border) bg-transparent text-(--vscode-foreground)"
						}`}
						key={option}
						onClick={() => setScope(option)}
						type="button">
						{option === "global" ? "Global" : "Workspace"}
					</button>
				))}
				<span className="flex-1" />
				<button
					aria-label={revealed ? "Hide environment values" : "Show environment values"}
					className="bg-transparent border-0 p-1 cursor-pointer text-(--vscode-foreground) opacity-80 hover:opacity-100"
					onClick={() => setRevealed((value) => !value)}
					title={revealed ? "Hide all values" : "Show all values"}
					type="button">
					{revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
				</button>
			</div>

			<div className="flex flex-col gap-1 mb-2">
				{names.length === 0 && (
					<p className="text-xs text-(--vscode-descriptionForeground)">No variables in this scope.</p>
				)}
				{names.map((name) => (
					<div className="flex items-center gap-1" key={name}>
						<span className="w-40 shrink-0 truncate text-xs font-mono text-(--vscode-foreground)" title={name}>
							{name}
						</span>
						<VSCodeTextField
							aria-label={`Value for ${name}`}
							className="flex-1"
							onBlur={() => commitValueEdit(name)}
							onInput={(e) =>
								setValueEdits((prev) => ({
									...prev,
									[editKey + name]: (e.target as HTMLInputElement).value,
								}))
							}
							type={revealed ? "text" : "password"}
							value={draftValue(name)}
						/>
						<button
							aria-label={`Remove ${name}`}
							className="bg-transparent border-0 p-1 cursor-pointer text-(--vscode-foreground) opacity-60 hover:opacity-100"
							onClick={() => removeVariable(name)}
							type="button">
							<X className="size-3" />
						</button>
					</div>
				))}
				<div className="flex items-center gap-1">
					<VSCodeTextField
						aria-label={`New ${scope} variable name`}
						className="w-40 shrink-0"
						onInput={(e) =>
							setNewRows((prev) => ({
								...prev,
								[scope]: { ...prev[scope], name: (e.target as HTMLInputElement).value },
							}))
						}
						placeholder="NAME"
						value={newRows[scope].name}
					/>
					<VSCodeTextField
						aria-label={`New ${scope} variable value`}
						className="flex-1"
						onInput={(e) =>
							setNewRows((prev) => ({
								...prev,
								[scope]: { ...prev[scope], value: (e.target as HTMLInputElement).value },
							}))
						}
						placeholder="value"
						type={revealed ? "text" : "password"}
						value={newRows[scope].value}
					/>
					<button
						aria-label={`Add ${scope} variable`}
						className="bg-transparent border-0 p-1 cursor-pointer text-(--vscode-foreground) opacity-80 hover:opacity-100"
						disabled={!newRows[scope].name.trim()}
						onClick={addVariable}
						type="button">
						<Plus className="size-3.5" />
					</button>
				</div>
			</div>

			<div className="mb-2">
				<label className="text-xs block mb-1" htmlFor={`env-file-${scope}`}>
					.env file path (optional)
				</label>
				<VSCodeTextField
					className="w-full"
					id={`env-file-${scope}`}
					onBlur={commitEnvFilePath}
					onInput={(e) => setEnvPathEdit((e.target as HTMLInputElement).value)}
					placeholder=".env"
					value={envPathEdit ?? storedEnvFilePath}
				/>
				<p className="text-xs text-(--vscode-descriptionForeground) mt-1">
					Read when a command runs; its values are never stored or shown here.
				</p>
			</div>

			<div className="mb-2">
				<label className="text-xs block mb-1">Extra PATH entries</label>
				<div className="flex flex-col gap-1">
					{pathEntries.map((entry, index) => (
						<div className="flex items-center gap-1" key={`${entry}:${index}`}>
							<span className="flex-1 truncate text-xs font-mono text-(--vscode-foreground)" title={entry}>
								{entry}
							</span>
							<button
								aria-label={`Remove PATH entry ${entry}`}
								className="bg-transparent border-0 p-1 cursor-pointer text-(--vscode-foreground) opacity-60 hover:opacity-100"
								onClick={() => removePathEntry(index)}
								type="button">
								<X className="size-3" />
							</button>
						</div>
					))}
					<div className="flex items-center gap-1">
						<VSCodeTextField
							aria-label={`New ${scope} PATH entry`}
							className="flex-1"
							onInput={(e) => setNewPath((e.target as HTMLInputElement).value)}
							placeholder="/path/to/bin"
							value={newPath}
						/>
						<button
							aria-label={`Add ${scope} PATH entry`}
							className="bg-transparent border-0 p-1 cursor-pointer text-(--vscode-foreground) opacity-80 hover:opacity-100"
							disabled={!newPath.trim()}
							onClick={addPathEntry}
							type="button">
							<Plus className="size-3.5" />
						</button>
					</div>
				</div>
			</div>

			<ResolvedEnvironmentPreview resolved={resolved} setResolved={setResolved} />
		</div>
	)
}

interface ResolvedPreviewProps {
	resolved: TerminalEnvironmentVariable[] | undefined
	setResolved: (variables: TerminalEnvironmentVariable[] | undefined) => void
}

/** Collapsed preview of the merged env: names + sources only, never values. */
function ResolvedEnvironmentPreview({ resolved, setResolved }: ResolvedPreviewProps) {
	const [loading, setLoading] = useState(false)

	const load = async () => {
		setLoading(true)
		try {
			const response: TerminalEnvironmentResolution = await StateServiceClient.resolveTerminalEnvironment(
				EmptyRequest.create({}),
			)
			setResolved(response.variables ?? [])
		} catch (error) {
			console.error("Failed to resolve terminal environment:", error)
			setResolved([])
		} finally {
			setLoading(false)
		}
	}

	return (
		<details
			className="text-xs"
			onToggle={(e) => {
				if ((e.target as HTMLDetailsElement).open && resolved === undefined) void load()
			}}>
			<summary className="cursor-pointer text-(--vscode-foreground) select-none">Resolved environment</summary>
			<div className="mt-1 rounded-sm border border-solid border-(--vscode-panel-border) p-2 bg-(--vscode-editor-background)">
				{loading && <p className="text-(--vscode-descriptionForeground)">Resolving…</p>}
				{!loading && resolved !== undefined && (
					<>
						{resolved.length === 0 && (
							<p className="text-(--vscode-descriptionForeground)">
								No configured variables — commands use the process environment.
							</p>
						)}
						{resolved.map((variable) => (
							<div className="flex items-center gap-2 font-mono text-[11px]" key={variable.name}>
								<span className="flex-1 truncate text-(--vscode-foreground)">{variable.name}</span>
								<span className="text-(--vscode-descriptionForeground)">
									{SOURCE_LABELS[variable.source] ?? variable.source}
									{variable.overriddenSource
										? ` overrides ${SOURCE_LABELS[variable.overriddenSource] ?? variable.overriddenSource}`
										: ""}
								</span>
							</div>
						))}
						<p className="text-(--vscode-descriptionForeground) mt-1">
							Values are never shown here; check your shell for the final environment.
						</p>
					</>
				)}
			</div>
		</details>
	)
}

export default TerminalEnvironmentEditor
