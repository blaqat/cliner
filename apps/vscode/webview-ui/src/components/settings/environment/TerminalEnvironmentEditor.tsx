import { BooleanRequest, EmptyRequest } from "@shared/proto/cline/common"
import type { TerminalEnvironmentResolution, TerminalEnvironmentVariable } from "@shared/proto/cline/state"
import { globalEnvFilePathProblem, type TerminalEnvironmentWebviewScope } from "@shared/terminal-environment"
import { VSCodeRadio, VSCodeRadioGroup, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { StateServiceClient } from "@/services/grpc-client"
import { updateSetting } from "../utils/settingsHandlers"

/**
 * Terminal environment editor (Profiles → Used by is profiles; this lives in
 * Terminal settings). Two scopes: global applies everywhere, workspace
 * overrides per project and is stored in workspace state — never in the repo.
 *
 * Webview state carries only variable names (values are masked placeholders).
 * The eye toggle fetches the real values of the visible scope through an
 * explicit reveal RPC; they live only in this component's state and are
 * dropped when hidden or when the scope changes. Every edit is a granular
 * patch (set/remove one variable, set the .env path, add/remove one PATH
 * entry), so quick consecutive edits compose on the server instead of racing
 * whole-scope snapshots. .env files are read at command time only: their
 * contents are never shown or stored here.
 */

type EnvScope = "global" | "workspace"

const SOURCE_LABELS: Record<string, string> = {
	process: "process",
	env_file: ".env",
	global: "global",
	workspace: "workspace",
}

const MASK_PLACEHOLDER = "••••••••"

/** A codicon-only row action (show/hide, add, remove), like the rule rows' edit and delete. */
function IconAction({
	icon,
	label,
	title,
	disabled,
	onClick,
}: {
	icon: string
	label: string
	title?: string
	disabled?: boolean
	onClick: () => void
}) {
	return (
		<Button
			aria-label={label}
			className="size-6 shrink-0 text-description hover:text-foreground"
			disabled={disabled}
			onClick={onClick}
			size="icon"
			title={title ?? label}
			variant="icon">
			<span aria-hidden className={`codicon codicon-${icon} text-[14px]!`} />
		</Button>
	)
}

function scopeVariableNames(scope: TerminalEnvironmentWebviewScope | undefined): string[] {
	return Object.keys(scope?.variables ?? {})
}

function scopePathEntries(scope: TerminalEnvironmentWebviewScope | undefined): string[] {
	return scope?.pathEntries ?? []
}

interface RowDraft {
	name: string
	value: string
}

/** Send a granular patch for one scope; omitted fields stay as stored. */
function patchEnvironment(
	scope: EnvScope,
	patch: {
		setVariables?: Record<string, string>
		removeVariables?: string[]
		envFilePath?: string
		addPathEntries?: string[]
		removePathEntries?: string[]
	},
) {
	updateSetting("terminalEnvironment", {
		workspace: scope === "workspace",
		setVariables: patch.setVariables ?? {},
		removeVariables: patch.removeVariables ?? [],
		envFilePath: patch.envFilePath,
		addPathEntries: patch.addPathEntries ?? [],
		removePathEntries: patch.removePathEntries ?? [],
	})
}

function TerminalEnvironmentEditor() {
	const { terminalEnvironment } = useExtensionState()
	const [scope, setScope] = useState<EnvScope>("global")
	// Real values of the visible scope, present only while revealed.
	const [revealedValues, setRevealedValues] = useState<Record<string, string> | undefined>(undefined)
	const [revealing, setRevealing] = useState(false)
	// value edits pending blur, keyed "scope:name"
	const [valueEdits, setValueEdits] = useState<Record<string, string>>({})
	const [newRows, setNewRows] = useState<Record<EnvScope, RowDraft>>({
		global: { name: "", value: "" },
		workspace: { name: "", value: "" },
	})
	const [newPath, setNewPath] = useState("")
	const [envPathEdit, setEnvPathEdit] = useState<string | undefined>(undefined)
	const [resolved, setResolved] = useState<TerminalEnvironmentVariable[] | undefined>(undefined)

	const revealed = revealedValues !== undefined
	const stored = scope === "global" ? terminalEnvironment?.global : terminalEnvironment?.workspace
	const variableNames = scopeVariableNames(stored)
	const pathEntries = scopePathEntries(stored)
	const storedEnvFilePath = stored?.envFilePath ?? ""
	const envPathValue = envPathEdit ?? storedEnvFilePath
	const envPathProblem = scope === "global" ? globalEnvFilePathProblem(envPathValue) : undefined

	const patch = (next: Parameters<typeof patchEnvironment>[1]) => {
		patchEnvironment(scope, next)
		// Stored values changed; the resolved preview may be stale.
		setResolved(undefined)
	}

	const hideValues = () => setRevealedValues(undefined)

	const toggleReveal = async () => {
		if (revealed) {
			hideValues()
			return
		}
		setRevealing(true)
		try {
			const response = await StateServiceClient.revealTerminalEnvironment(
				BooleanRequest.create({ value: scope === "workspace" }),
			)
			setRevealedValues({ ...(response.variables ?? {}) })
		} catch (error) {
			console.error("Failed to reveal terminal environment values:", error)
		} finally {
			setRevealing(false)
		}
	}

	const switchScope = (next: EnvScope) => {
		if (next === scope) return
		// Revealed values belong to one scope; never carry them across.
		hideValues()
		setEnvPathEdit(undefined)
		setScope(next)
	}

	const editKey = `${scope}:`
	const draftValue = (name: string) => valueEdits[editKey + name] ?? (revealed ? (revealedValues?.[name] ?? "") : "")

	const commitValueEdit = (name: string) => {
		const draft = valueEdits[editKey + name]
		if (draft === undefined) return
		setValueEdits((prev) => {
			const next = { ...prev }
			delete next[editKey + name]
			return next
		})
		// An untouched revealed value needs no write; masked edits always do.
		if (revealed && draft === revealedValues?.[name]) return
		patch({ setVariables: { [name]: draft } })
		if (revealed) setRevealedValues((prev) => (prev ? { ...prev, [name]: draft } : prev))
	}

	const removeVariable = (name: string) => {
		setValueEdits((prev) => {
			const next = { ...prev }
			delete next[editKey + name]
			return next
		})
		setRevealedValues((prev) => {
			if (!prev) return prev
			const next = { ...prev }
			delete next[name]
			return next
		})
		patch({ removeVariables: [name] })
	}

	const addVariable = () => {
		const draft = newRows[scope]
		const name = draft.name.trim()
		if (!name) return
		patch({ setVariables: { [name]: draft.value } })
		if (revealed) setRevealedValues((prev) => (prev ? { ...prev, [name]: draft.value } : prev))
		setNewRows((prev) => ({ ...prev, [scope]: { name: "", value: "" } }))
	}

	const addPathEntry = () => {
		const entry = newPath.trim()
		if (!entry) return
		patch({ addPathEntries: [entry] })
		setNewPath("")
	}

	const removePathEntry = (entry: string) => {
		patch({ removePathEntries: [entry] })
	}

	const commitEnvFilePath = () => {
		if (envPathEdit === undefined) return
		const value = envPathEdit.trim()
		// An invalid global path is explained inline and not saved.
		if (scope === "global" && globalEnvFilePathProblem(value)) return
		setEnvPathEdit(undefined)
		if (value !== storedEnvFilePath) patch({ envFilePath: value })
	}

	const names = [...variableNames].sort()

	return (
		<div className="mb-4">
			<label className="font-medium block mb-1" htmlFor="terminal-environment-scope">
				Environment
			</label>
			<p className="text-xs text-description mt-0 mb-2">
				Applied to every command Cline runs. Global is the default; workspace values override it and are stored outside
				the repo.
			</p>

			<div className="flex items-center gap-1 mb-2">
				<VSCodeRadioGroup
					id="terminal-environment-scope"
					onChange={(event: any) => {
						const value = event.target?.value
						if (value === "global" || value === "workspace") switchScope(value)
					}}
					orientation="horizontal"
					value={scope}>
					<VSCodeRadio checked={scope === "global"} value="global">
						Global
					</VSCodeRadio>
					<VSCodeRadio checked={scope === "workspace"} value="workspace">
						Workspace
					</VSCodeRadio>
				</VSCodeRadioGroup>
				<span className="flex-1" />
				<IconAction
					disabled={revealing}
					icon={revealed ? "eye-closed" : "eye"}
					label={revealed ? "Hide environment values" : "Show environment values"}
					onClick={() => void toggleReveal()}
					title={revealed ? "Hide all values" : "Show all values"}
				/>
			</div>

			<div className="flex flex-col gap-1 mb-2">
				{names.length === 0 && <p className="text-xs text-description m-0">No variables in this scope.</p>}
				{names.map((name) => (
					<div className="flex items-center gap-1" key={name}>
						<span className="ph-no-capture w-40 shrink-0 truncate text-xs font-mono text-foreground" title={name}>
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
							placeholder={valueEdits[editKey + name] === undefined && !revealed ? MASK_PLACEHOLDER : undefined}
							type={revealed ? "text" : "password"}
							value={draftValue(name)}
						/>
						<IconAction icon="close" label={`Remove ${name}`} onClick={() => removeVariable(name)} />
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
					<IconAction
						disabled={!newRows[scope].name.trim()}
						icon="add"
						label={`Add ${scope} variable`}
						onClick={addVariable}
					/>
				</div>
			</div>

			<div className="mb-2">
				<label className="text-xs font-medium block mb-1" htmlFor={`env-file-${scope}`}>
					.env file path (optional)
				</label>
				<VSCodeTextField
					className="w-full"
					id={`env-file-${scope}`}
					onBlur={commitEnvFilePath}
					onInput={(e) => setEnvPathEdit((e.target as HTMLInputElement).value)}
					placeholder={scope === "global" ? "~/secrets/dev.env" : ".env"}
					value={envPathValue}
				/>
				{envPathProblem ? (
					<p className="text-xs text-error mt-1 mb-0" role="alert">
						{envPathProblem}
					</p>
				) : (
					<p className="text-xs text-description mt-1 mb-0">
						{scope === "global"
							? "Absolute or ~-relative path."
							: "Relative paths resolve against the workspace root."}{" "}
						Read when a command runs; its values are never stored or shown here.
					</p>
				)}
			</div>

			<div className="mb-2">
				<div className="text-xs font-medium mb-1">Extra PATH entries</div>
				<div className="flex flex-col gap-1">
					{pathEntries.map((entry) => (
						<div className="flex items-center gap-1" key={entry}>
							<span className="ph-no-capture flex-1 truncate text-xs font-mono text-foreground" title={entry}>
								{entry}
							</span>
							<IconAction
								icon="close"
								label={`Remove PATH entry ${entry}`}
								onClick={() => removePathEntry(entry)}
							/>
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
						<IconAction
							disabled={!newPath.trim()}
							icon="add"
							label={`Add ${scope} PATH entry`}
							onClick={addPathEntry}
						/>
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
			<summary className="cursor-pointer text-xs font-medium text-foreground select-none">Resolved environment</summary>
			<div className="mt-1 rounded-xs border border-editor-group-border bg-code p-2">
				{loading && <p className="m-0 text-description">Resolving…</p>}
				{!loading && resolved !== undefined && (
					<>
						{resolved.length === 0 && (
							<p className="m-0 text-description">
								No configured variables — commands use the process environment.
							</p>
						)}
						{resolved.map((variable) => (
							<div className="flex items-center gap-2 font-mono text-[11px]" key={variable.name}>
								<span className="ph-no-capture flex-1 truncate text-foreground">{variable.name}</span>
								<span className="text-description">
									{SOURCE_LABELS[variable.source] ?? variable.source}
									{variable.overriddenSource
										? ` overrides ${SOURCE_LABELS[variable.overriddenSource] ?? variable.overriddenSource}`
										: ""}
								</span>
							</div>
						))}
						<p className="m-0 mt-1 text-description">
							Values are never shown here; check your shell for the final environment.
						</p>
					</>
				)}
			</div>
		</details>
	)
}

export default TerminalEnvironmentEditor
