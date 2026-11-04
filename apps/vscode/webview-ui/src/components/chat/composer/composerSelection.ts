import type { ModelSettingsState } from "@shared/model-settings-state"
import { ModelSettingsRequestV1 } from "@shared/proto/cline/models"
import type { Mode } from "@shared/storage/types"
import { useEffect, useState } from "react"
import type { SelectorLevel, SelectorPick, SelectorRow } from "@/components/models/ModelSelector"
import { describePick, samePick, selectorDataFromModelSettings } from "@/components/models/modelSelectorRows"
import type { SettingsNavigationTarget } from "@/components/settings/settingsTargets"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient } from "@/services/grpc-client"
import { formatEffort } from "./modelSelection"

/** Why a locked choice can't change. */
export const LOCKED_REASON = "A next-message-only choice can't change while Cline is working"

/** Why Reset is off. */
export const RESET_DISABLED_REASON = "Nothing to reset: this already uses the default model and effort"

/** What the Next message only switch does, by state. */
export const NEXT_MESSAGE_TIPS = {
	on: "Next message only is on: the model and effort apply to your next message, then this chat goes back to its own. Turn off to keep them for this chat.",
	off: "Next message only is off: model and effort changes stay for this chat. Turn on to use them for your next message only.",
	busy: "Can't change while Cline is working",
} as const

/** Everything the composer's chip and menu need. */
export interface ComposerSelection {
	rows: SelectorRow[]
	ladder: SelectorLevel[]
	pick: SelectorPick | null
	modeLabel: string
	modelLabel: string
	/** The running session still uses another model. */
	pending: boolean
	description: string
	/** Undefined for a model without a level control. */
	level?: { short: string; word: string; pending: boolean; description: string; bad: boolean }
	disabledReason?: string
	note?: string
	noteLink?: string
	busy: boolean
	hasChat: boolean
	nextMessageOnly: boolean
	nextMessageDisabledReason?: string
	canReset: boolean
	resetDisabledReason: string
	commit: (pick: SelectorPick) => void
	setNextMessageOnly: (on: boolean) => void
	reset: () => void
	manage: (target?: SettingsNavigationTarget) => void
	/** Nothing to set before the store exists. */
	makeDefault?: {
		/** Says which role the host will set. */
		tip: string
		isDefault: (pick: SelectorPick | null) => boolean
		run: (pick: SelectorPick) => void
	}
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The model settings store, through its RPCs. */
function useModelSettingsSelection(mode: Mode) {
	const {
		composerApiSelection,
		composerNextMessageOnly,
		currentTaskItem,
		turnState,
		focusedSessionModels,
		navigateToSettings,
	} = useExtensionState()
	const taskId = currentTaskItem?.id ?? ""
	// The switch answers at once; the host's next state replaces this.
	const [armed, setArmed] = useState<boolean | null>(null)
	const [error, setError] = useState<string>()
	useEffect(() => setArmed(null), [composerNextMessageOnly, taskId])

	return (state: ModelSettingsState): ComposerSelection => {
		const { rows, ladder } = selectorDataFromModelSettings(state)
		const { roles } = state.settings
		const askHasOwnModel = mode === "plan" && roles.ask.enabled
		const defaultModelPick = askHasOwnModel ? roles.ask.pick : roles.chat
		const defaultPick = defaultModelPick && { rowId: defaultModelPick.modelId, levelId: defaultModelPick.levelId }
		const threadPick = composerApiSelection?.modelSelectionV1?.[mode === "plan" ? "ask" : "act"] ?? defaultModelPick
		const pick = threadPick && { rowId: threadPick.modelId, levelId: threadPick.levelId }
		const shown = describePick(rows, pick)
		const row = rows.find((candidate) => candidate.id === pick?.rowId)
		const model = state.settings.models.find((candidate) => candidate.id === pick?.rowId)
		const modeLabel = mode === "plan" ? "Ask" : "Act"
		const roleLabel = askHasOwnModel ? "Ask" : "Chat"
		const busy = turnState?.phase === "streaming" || turnState?.phase === "awaiting_approval"
		const nextMessageOnly = armed ?? !!composerNextMessageOnly
		const live = focusedSessionModels?.[mode]
		const pending = !!live && !!model && (live.pick ? live.pick.modelId !== model.id : live.modelId !== model.upstreamId)
		const savedLevel = model && state.effective[model.id]?.levels.value.find((level) => level.id === pick?.levelId)
		const liveEffort = live?.reasoningEffort ?? "none"
		const levelPending = live?.pick
			? live.pick.levelId !== pick?.levelId
			: !!live &&
				((savedLevel?.request.kind === "default" && liveEffort !== "none") ||
					(savedLevel?.request.kind === "effort" && liveEffort !== savedLevel.request.value))

		const send = (next: SelectorPick, nextOnly: boolean) => {
			setError(undefined)
			void ModelsServiceClient.setThreadModelSelection(
				ModelSettingsRequestV1.create({
					json: JSON.stringify({
						taskId,
						mode,
						pick: { modelId: next.rowId, levelId: next.levelId },
						nextMessageOnly: nextOnly,
					}),
				}),
			).catch((failure) => {
				console.error("Failed to update chat model:", failure)
				setArmed(null)
				setError(`Couldn't save that: ${errorText(failure)}`)
			})
		}

		const orphaned = !!pick && !row
		const note =
			error ??
			(orphaned
				? "The model this chat used is gone. Pick another."
				: rows.length > 0 && !pick
					? `No ${roleLabel} model is picked, so nothing can run. Pick one here, or set the default in`
					: undefined)

		return {
			rows,
			ladder,
			pick,
			modeLabel,
			modelLabel: shown.model,
			pending,
			description: live
				? `${modeLabel} currently uses ${live.provider}:${live.modelId}${pending ? `; ${shown.model} change pending` : ""}`
				: row
					? `${modeLabel} uses ${row.label} (${row.detail})`
					: "Open Settings › Models",
			level: shown.level
				? {
						short: shown.level,
						word: row?.levels?.find((level) => level.id === pick?.levelId)?.label ?? shown.level,
						pending: levelPending,
						description: levelPending
							? `Currently uses ${formatEffort(liveEffort)}; change pending`
							: `Reasoning effort: ${shown.level}`,
						bad: !shown.levelOffered,
					}
				: undefined,
			disabledReason: nextMessageOnly && busy ? LOCKED_REASON : undefined,
			note,
			noteLink: !error && !orphaned && note ? "Settings › Models" : undefined,
			busy,
			hasChat: !!currentTaskItem,
			nextMessageOnly,
			nextMessageDisabledReason: busy ? NEXT_MESSAGE_TIPS.busy : !pick ? "Pick a model first" : undefined,
			canReset: !!defaultPick && (!samePick(pick, defaultPick) || nextMessageOnly),
			resetDisabledReason: defaultPick
				? RESET_DISABLED_REASON
				: `Nothing to reset to: no default ${roleLabel} model is set yet`,
			commit: (next) => send(next, nextMessageOnly),
			setNextMessageOnly: (on) => {
				if (!pick) return
				setArmed(on)
				send(pick, on)
			},
			reset: () => {
				if (!defaultPick) return
				setArmed(false)
				send(defaultPick, false)
			},
			manage: (target) => navigateToSettings(target ?? "models"),
			makeDefault: {
				tip: askHasOwnModel
					? "Sets the Ask model: new chats start with this on Ask. Other chats keep theirs."
					: mode === "plan"
						? "Ask follows Chat, so this sets the Chat model: new chats start with this. Other chats keep theirs."
						: "Sets the Chat model: new chats start with this. Other chats keep theirs.",
				isDefault: (next) => !!next && samePick(next, defaultPick),
				run: (next) => {
					setError(undefined)
					void (async () => {
						const response = await ModelsServiceClient.getModelSettings(ModelSettingsRequestV1.create({ json: "{}" }))
						const latest = JSON.parse(response.json) as ModelSettingsState
						await ModelsServiceClient.makeModelDefault(
							ModelSettingsRequestV1.create({
								json: JSON.stringify({
									expectedRevision: latest.settings.revision,
									mode,
									pick: { modelId: next.rowId, levelId: next.levelId },
								}),
							}),
						)
					})().catch((failure) => {
						console.error("Failed to make the model the default:", failure)
						setError(`Couldn't make this the default: ${errorText(failure)}`)
					})
				},
			},
		}
	}
}

/**
 * Before the move has made the store, the chip names what's running and the choices wait for it.
 * The menu still opens: the approval tiles work either way, and its note links to what's holding things up.
 */
function unavailableSelection(
	mode: Mode,
	runningLabel: string,
	manage: () => void,
	busy: boolean,
	hasChat: boolean,
): ComposerSelection {
	const why = "Model choices come back once your setup has moved"
	return {
		rows: [],
		ladder: [],
		pick: null,
		modeLabel: mode === "plan" ? "Ask" : "Act",
		modelLabel: runningLabel,
		pending: false,
		description: `Running on your last selection. ${why}.`,
		note: `Running on your last selection. ${why}. See`,
		noteLink: "Settings",
		busy,
		hasChat,
		nextMessageOnly: false,
		nextMessageDisabledReason: why,
		canReset: false,
		resetDisabledReason: why,
		commit: () => {},
		setNextMessageOnly: () => {},
		reset: () => {},
		manage,
	}
}

export function useComposerSelection(mode: Mode, runningLabel: string): ComposerSelection {
	const { currentTaskItem, modelSettings, navigateToSettings, turnState } = useExtensionState()
	const fromModelSettings = useModelSettingsSelection(mode)
	if (modelSettings) {
		return fromModelSettings(modelSettings)
	}
	const busy = turnState?.phase === "streaming" || turnState?.phase === "awaiting_approval"
	return unavailableSelection(mode, runningLabel, () => navigateToSettings("models"), busy, !!currentTaskItem)
}
