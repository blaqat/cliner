import { automationDisplayName } from "@shared/automations"
import { TrustAutomationRequest } from "@shared/proto/cline/automation"
import { StringRequest } from "@shared/proto/cline/common"
import React, { useState } from "react"
import { InlineNotice } from "@/components/common/InlineNotice"
import { Button } from "@/components/ui/button"
import { type AutomationEntry, applyAutomationList, useAutomations } from "@/hooks/useAutomations"
import { cn } from "@/lib/utils"
import { AutomationServiceClient, FileServiceClient } from "@/services/grpc-client"
import { stepSummary } from "./automationSummary"
import type { AutomationBuilderTarget } from "./builderNavigation"

function openFile(path: string) {
	FileServiceClient.openFile(StringRequest.create({ value: path })).catch((error) =>
		console.error("Failed to open automation:", error),
	)
}

interface PanelActions {
	/** Starts `/name ` in the composer. */
	onRun?: (name: string) => void
	/** Opens the builder: an existing file, a blank one, or the describe-it box. */
	onEdit?: (target: AutomationBuilderTarget) => void
}

const AutomationRow: React.FC<{ automation: AutomationEntry } & PanelActions> = ({ automation, onRun, onEdit }) => {
	const [error, setError] = useState("")
	const [confirmingDelete, setConfirmingDelete] = useState(false)
	const [showActions, setShowActions] = useState(false)
	const invalid = !automation.definition
	const title = automation.definition ? automationDisplayName(automation.definition) : automation.name
	const run = (mutation: Promise<Parameters<typeof applyAutomationList>[0]>) =>
		mutation.then(applyAutomationList).catch((err) => setError(err?.message ?? String(err)))
	return (
		<div className="mb-2.5 rounded bg-text-block-background px-2 py-1.5" data-testid={`automation-row-${automation.name}`}>
			<div className="flex items-center gap-2">
				<span aria-hidden className="codicon codicon-run-all shrink-0 text-[11px]! text-description" />
				<button
					className="ph-no-capture min-w-0 flex-1 cursor-pointer truncate border-0 bg-transparent p-0 text-left text-sm text-foreground hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder)"
					onClick={() => (onEdit && !invalid ? onEdit({ path: automation.path }) : openFile(automation.path))}
					title={invalid ? `Open ${automation.path}` : "Edit in the builder"}
					type="button">
					{title}
					{title !== automation.name && (
						<span className="ml-1.5 font-mono text-xs text-description">/{automation.name}</span>
					)}
				</button>
				{onRun && !invalid && automation.trusted && (
					<Button
						className="shrink-0"
						data-testid={`automation-run-${automation.name}`}
						onClick={() => onRun(automation.name)}
						size="xs"
						variant="secondary">
						Run
					</Button>
				)}
				<button
					aria-expanded={showActions}
					aria-label={`Actions for ${automation.name}`}
					className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-xs border-0 bg-transparent p-0 text-description hover:bg-list-hover hover:text-foreground"
					onClick={() => setShowActions((open) => !open)}
					title="Automation actions"
					type="button">
					<span aria-hidden className="codicon codicon-ellipsis text-[12px]" />
				</button>
			</div>
			{showActions && (
				<div className="mt-1 ml-5 flex flex-wrap items-center gap-1.5">
					{onEdit && (
						<Button
							onClick={() => onEdit({ path: automation.path, changeWithPrompt: true })}
							size="xs"
							variant="secondary">
							Change with a prompt…
						</Button>
					)}
					<Button
						onClick={() => {
							setConfirmingDelete(true)
							setShowActions(false)
						}}
						size="xs"
						variant="secondary">
						Delete
					</Button>
				</div>
			)}
			{automation.description && <div className="mt-0.5 pl-5 text-xs text-description">{automation.description}</div>}
			{automation.definition && (
				<div className="mt-0.5 pl-5 text-[11px] text-description" data-testid={`automation-summary-${automation.name}`}>
					{stepSummary(automation.definition)}
				</div>
			)}
			{!invalid && !automation.trusted && (
				<InlineNotice
					actions={
						<>
							<Button onClick={() => openFile(automation.path)} size="xs" variant="secondary">
								View file
							</Button>
							<Button
								onClick={() =>
									run(
										AutomationServiceClient.trustAutomation(
											TrustAutomationRequest.create({
												path: automation.path,
												fingerprint: automation.fingerprint,
											}),
										),
									)
								}
								size="xs"
								variant="secondary">
								Trust this version
							</Button>
						</>
					}
					className="mt-1.5 ml-5"
					tone="warning">
					<span className="font-medium">Not trusted yet</span> (new, or changed since you trusted it). It can start
					threads and edit code, so look at the file before running it.
				</InlineNotice>
			)}
			{confirmingDelete && (
				<div className="mt-1.5 ml-5 flex flex-wrap items-center gap-2 text-xs" role="alert">
					<span className="min-w-0 flex-1">Delete {automation.name}? Its file is removed; earlier runs stay.</span>
					<Button
						onClick={() =>
							run(AutomationServiceClient.deleteAutomation(StringRequest.create({ value: automation.path })))
						}
						size="xs"
						variant="danger">
						Delete
					</Button>
					<Button onClick={() => setConfirmingDelete(false)} size="xs" variant="secondary">
						Cancel
					</Button>
				</div>
			)}
			{error && (
				<InlineNotice className="mt-1.5 ml-5" tone="error">
					{error}
				</InlineNotice>
			)}
			{invalid && (
				<ul className="m-0 mt-1 list-none pl-5 text-xs text-error" data-testid={`automation-errors-${automation.name}`}>
					{automation.errors.map((problem) => (
						<li key={problem}>{problem}</li>
					))}
				</ul>
			)}
		</div>
	)
}

const Section: React.FC<{ title: string; folder: string; items: AutomationEntry[] } & PanelActions> = ({
	title,
	folder,
	items,
	...actions
}) => (
	<div className="mb-3">
		<div className="mb-2 text-sm font-normal">{title}</div>
		<div className="mb-1 text-[11px] text-description">{folder}</div>
		{items.length === 0 && <div className="mb-2 text-xs text-description">None yet.</div>}
		{items.map((automation) => (
			<AutomationRow automation={automation} key={automation.path} {...actions} />
		))}
	</div>
)

/**
 * The Automations tab of the Rules & workflows overlay (it replaced Scripts). Rows open the builder; Run
 * starts `/name` in the composer. Only you start automations: Cline has no tool for them.
 */
const AutomationsPanel: React.FC<PanelActions> = ({ onRun, onEdit }) => {
	const { automations, globalDir, workspaceDir, loaded } = useAutomations({ pollMs: 2000 })
	const workspace = automations.filter((item) => item.scope === "workspace")
	const global = automations.filter((item) => item.scope === "global")
	const empty = loaded && automations.length === 0
	return (
		<div data-testid="automations-panel">
			<p className="m-0 mb-3 text-xs text-description">
				Steps you start by typing <span className="font-mono text-foreground">/name</span> in the chat: plan, build in a
				worktree, have several models review, and stop to ask you. Each step is a normal thread you can open. Only you
				start them.
			</p>
			{onEdit && (
				<div className="mb-3 flex flex-wrap gap-2">
					<Button data-testid="automation-new" onClick={() => onEdit({})} size="xs" variant="secondary">
						＋ New automation
					</Button>
					<Button
						data-testid="automation-describe"
						onClick={() => onEdit({ describe: true })}
						size="xs"
						variant="secondary">
						Describe it, Cline drafts it
					</Button>
				</div>
			)}
			{empty ? (
				<div
					className="rounded-sm border border-dashed border-editor-group-border px-3 py-2.5 text-xs text-description"
					data-testid="automations-empty">
					<div className="mb-1 font-medium text-foreground">No automations yet</div>
					Start with ＋ New automation, describe one and let Cline draft it, or open a task and pick ⋯ › Save as an
					automation to repeat what its threads did.
					{!workspaceDir && <div className="mt-1">Open a folder to keep automations in its repo.</div>}
				</div>
			) : (
				<>
					{(workspace.length > 0 || workspaceDir) && (
						<Section
							folder={workspaceDir ? ".clinerules/automations/ · shared with the repo" : ""}
							items={workspace}
							onEdit={onEdit}
							onRun={onRun}
							title="This repo"
						/>
					)}
					<div className={cn("-mb-2.5")}>
						<Section
							folder={globalDir ? "~/.cline/automations/ · just you, in every workspace" : ""}
							items={global}
							onEdit={onEdit}
							onRun={onRun}
							title="Everywhere"
						/>
					</div>
				</>
			)}
		</div>
	)
}

export default AutomationsPanel
