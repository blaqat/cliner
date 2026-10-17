import { StringRequest } from "@shared/proto/cline/common"
import { SetScriptApprovalRequest, ToggleScriptRequest } from "@shared/proto/cline/file"
import { SCRIPT_APPROVAL_LABELS, SCRIPT_APPROVALS, type ScriptApproval } from "@shared/scripts"
import React, { useState } from "react"
import NewRuleRow from "@/components/cline-rules/NewRuleRow"
import { Switch } from "@/components/ui/switch"
import { applyScriptsResponse, type ScriptEntry, useScripts } from "@/hooks/useScripts"
import { cn } from "@/lib/utils"
import { FileServiceClient } from "@/services/grpc-client"

const APPROVAL_HINTS: Record<ScriptApproval, string> = {
	always_ask: "Always asks before running. Click to change.",
	ask_in_ask_mode: "Asks in Ask mode, runs in Act mode. Click to change.",
	always_allow: "Runs without asking, even in Ask mode. Click to change.",
}

const APPROVAL_STYLES: Record<ScriptApproval, string> = {
	always_ask: "border-(--vscode-editorWarning-foreground)/50 text-(--vscode-editorWarning-foreground)",
	ask_in_ask_mode: "border-(--vscode-focusBorder)/50 text-(--vscode-textLink-foreground)",
	always_allow: "border-(--vscode-charts-green)/50 text-(--vscode-charts-green)",
}

function openScript(path: string) {
	FileServiceClient.openFile(StringRequest.create({ value: path })).catch((err) => console.error("Failed to open script:", err))
}

function nextApproval(approval: ScriptApproval): ScriptApproval {
	return SCRIPT_APPROVALS[(SCRIPT_APPROVALS.indexOf(approval) + 1) % SCRIPT_APPROVALS.length]
}

const ScriptRow: React.FC<{ script: ScriptEntry; onUse?: (name: string) => void }> = ({ script, onUse }) => {
	const [error, setError] = useState("")
	const invalid = script.errors.length > 0
	const toggle = () =>
		FileServiceClient.toggleScript(
			ToggleScriptRequest.create({
				scriptPath: script.path,
				isGlobal: script.scope === "global",
				enabled: !script.enabled,
			}),
		)
			.then(applyScriptsResponse)
			.catch((err) => console.error("Failed to toggle script:", err))
	const cycleApproval = () => {
		if (script.approval === "") return
		FileServiceClient.setScriptApproval(
			SetScriptApprovalRequest.create({
				scriptPath: script.path,
				approval: nextApproval(script.approval),
				fingerprint: script.fingerprint,
			}),
		)
			.then(applyScriptsResponse)
			.catch((err) => setError(err.message ?? String(err)))
	}
	return (
		<div
			className={cn("mb-2.5 rounded bg-text-block-background px-2 py-1.5", !script.enabled && "opacity-60")}
			data-testid={`script-row-${script.name}`}>
			<div className="flex items-center gap-2">
				<span aria-hidden className="codicon codicon-play shrink-0 text-[11px]! text-description" />
				<button
					className="min-w-0 flex-1 cursor-pointer truncate border-0 bg-transparent p-0 text-left font-mono text-sm text-foreground hover:underline"
					onClick={() => openScript(script.path)}
					title={`Open ${script.path}`}
					type="button">
					{script.name}
				</button>
				{script.approval !== "" && (
					<button
						className={cn(
							"shrink-0 cursor-pointer rounded-full border bg-transparent px-2 py-0 text-[10.5px] leading-4",
							APPROVAL_STYLES[script.approval],
						)}
						data-testid={`script-approval-${script.name}`}
						onClick={cycleApproval}
						title={APPROVAL_HINTS[script.approval]}
						type="button">
						{SCRIPT_APPROVAL_LABELS[script.approval]}
					</button>
				)}
				{onUse && !invalid && script.enabled && (
					<button
						className="shrink-0 cursor-pointer rounded-xs border border-(--vscode-button-border,transparent) bg-button-secondary-background px-1.5 text-[11px] text-button-secondary-foreground hover:bg-button-secondary-hover"
						data-testid={`script-use-${script.name}`}
						onClick={() => onUse(script.name)}
						type="button">
						Use
					</button>
				)}
				<Switch
					aria-label={`${script.enabled ? "Disable" : "Enable"} ${script.name}`}
					checked={script.enabled}
					onClick={toggle}
				/>
			</div>
			{!invalid && !script.trusted && (
				<div className="mt-1 pl-5 text-xs text-description">
					<span>Unreviewed</span>
					<pre className="whitespace-pre-wrap">{script.command}</pre>
					<div>Runs in: {script.cwd}</div>
					<button
						onClick={() =>
							FileServiceClient.setScriptApproval(
								SetScriptApprovalRequest.create({
									scriptPath: script.path,
									fingerprint: script.fingerprint,
									trustOnly: true,
								}),
							)
								.then(applyScriptsResponse)
								.catch((err) => setError(err.message ?? String(err)))
						}
						type="button">
						Trust this version
					</button>
				</div>
			)}
			{error && (
				<div className="mt-1 pl-5 text-xs text-error" role="alert">
					{error}
				</div>
			)}
			{script.description && <div className="mt-0.5 pl-5 text-xs text-description">{script.description}</div>}
			{invalid && (
				<ul className="m-0 mt-1 list-none pl-5 text-xs text-error" data-testid={`script-errors-${script.name}`}>
					{script.errors.map((error) => (
						<li key={error}>{error}</li>
					))}
				</ul>
			)}
		</div>
	)
}

/**
 * Saved scripts: the Scripts tab of the rules panel and the ＋ menu's Scripts view. Rows open the
 * Markdown file in the editor; the approval badge cycles the level in the file's frontmatter.
 */
const ScriptsPanel: React.FC<{ onUse?: (name: string) => void }> = ({ onUse }) => {
	const scripts = useScripts({ pollMs: 1000 })
	return (
		<div data-testid="scripts-panel">
			<div className="mb-4 text-xs text-description">
				<p>
					Scripts are fixed commands with options, saved as Markdown files. Cline sees each script's name and when to
					use it, and runs them with the <span className="font-bold text-foreground">script</span> tool. Type{" "}
					<span className="font-bold text-foreground">/script-name</span> in the chat to run one yourself.
				</p>
			</div>
			<div className="mb-3">
				<div className="mb-2 text-sm font-normal">Workspace Scripts</div>
				<div className="mb-1 text-[11px] text-description">.clinerules/scripts/</div>
				{scripts.workspace.map((script) => (
					<ScriptRow key={script.path} onUse={onUse} script={script} />
				))}
				<NewRuleRow isGlobal={false} ruleType="script" />
			</div>
			<div className="-mb-2.5">
				<div className="mb-2 text-sm font-normal">Global Scripts</div>
				<div className="mb-1 text-[11px] text-description">~/.cline/scripts/</div>
				{scripts.global.map((script) => (
					<ScriptRow key={script.path} onUse={onUse} script={script} />
				))}
				<NewRuleRow isGlobal={true} ruleType="script" />
			</div>
		</div>
	)
}

export default ScriptsPanel
