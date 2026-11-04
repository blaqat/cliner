import type { ModelInfo } from "@shared/api"
import type { ModelSettingsState } from "@shared/model-settings-state"
import { ModelSettingsRequestV1 } from "@shared/proto/cline/models"
import { type Mode, OPENAI_REASONING_EFFORT_OPTIONS, type OpenaiReasoningEffort } from "@shared/storage/types"
import { useEffect, useState } from "react"
import type { SelectorLevel, SelectorPick, SelectorRow } from "@/components/models/ModelSelector"
import { describePick, samePick, selectorDataFromModelSettings } from "@/components/models/modelSelectorRows"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient } from "@/services/grpc-client"
import {
	type ComposerSelectionChanges,
	formatEffort,
	formatEffortShort,
	useConfigSelection,
	useEffortSelection,
} from "./modelSelection"

/** Stands in for the current pick when it isn't one of the saved models (none assigned yet). */
const UNSAVED_VALUE = "__unsaved__"

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

/** The lists' names for the efforts: "none" reads "Default" (its tooltip says whose). */
const EFFORT_LEVELS: SelectorLevel[] = OPENAI_REASONING_EFFORT_OPTIONS.map((option) => ({
	id: option,
	label: option === "none" ? "Default" : formatEffort(option),
	detail: option === "none" ? "Provider default" : undefined,
}))

interface ComposerSelectionOptions {
	/** Shown when no saved model is assigned (e.g. before any exist). */
	fallbackLabel: string
	modelId: string | undefined
	modelInfo: ModelInfo | undefined
	defaultEffort?: OpenaiReasoningEffort
}

/** Everything the composer's chip and menu need, whichever store the pick lives in. */
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
	manage: () => void
	/** Only the new store has a default to set from the composer. */
	makeDefault?: {
		/** Says which role the host will set. */
		tip: string
		isDefault: (pick: SelectorPick | null) => boolean
		run: (pick: SelectorPick) => void
	}
}

/** Today's saved configurations (API profiles), through today's RPC. */
function useProfileSelection(mode: Mode, { fallbackLabel, modelId, modelInfo, defaultEffort }: ComposerSelectionOptions) {
	const config = useConfigSelection(mode, fallbackLabel)
	const effort = useEffortSelection(mode, { modelId, modelInfo, defaultEffort })
	const modelValue = config.current?.id ?? UNSAVED_VALUE

	// The model list: the saved models (as the old picker listed them); a current pick that isn't saved goes first.
	// Only the current model's info is known here; another saved model is offered its efforts.
	const rows: SelectorRow[] = config.profiles.map((profile) => ({
		id: profile.id,
		label: profile.name,
		detail: profile.modelId,
		levels: profile.id === modelValue && !effort.available ? null : EFFORT_LEVELS,
		// The effort a saved model brings with it when picked (the extension applies the same).
		defaultLevelId: profile.id === modelValue ? effort.selected : (profile.reasoningEffort ?? "none"),
	}))
	if (!config.current) {
		rows.unshift({
			id: UNSAVED_VALUE,
			label: fallbackLabel,
			detail: config.profiles.length ? "not saved" : undefined,
			levels: effort.available ? EFFORT_LEVELS : null,
			defaultLevelId: effort.selected,
		})
	}

	return (): ComposerSelection => ({
		rows,
		ladder: EFFORT_LEVELS,
		pick: { rowId: modelValue, levelId: effort.selected },
		modeLabel: config.modeLabel,
		modelLabel: config.label,
		pending: config.pending,
		description: config.description,
		level: effort.available
			? {
					short: formatEffortShort(effort.selected),
					word: formatEffort(effort.selected),
					pending: effort.pending,
					description: effort.description,
					bad: false,
				}
			: undefined,
		disabledReason: config.locked ? LOCKED_REASON : undefined,
		note: config.profiles.length === 0 ? "No saved models yet" : undefined,
		busy: config.busy,
		hasChat: config.hasChat,
		nextMessageOnly: config.nextMessageOnly,
		nextMessageDisabledReason: config.busy ? NEXT_MESSAGE_TIPS.busy : undefined,
		// Reset has something to undo: a saved choice off the default or a one-message choice.
		canReset: !config.isDefault || config.nextMessageOnly,
		resetDisabledReason: RESET_DISABLED_REASON,
		// Saves what the lists show in one request, only what changed.
		commit: (next) => {
			const changes: ComposerSelectionChanges = {}
			const modelChanged = next.rowId !== modelValue && next.rowId !== UNSAVED_VALUE
			if (modelChanged) changes.profileId = next.rowId
			const row = rows.find((candidate) => candidate.id === next.rowId)
			const baseline = modelChanged ? row?.defaultLevelId : effort.selected
			if (row?.levels && next.levelId !== baseline) changes.reasoningEffort = next.levelId as OpenaiReasoningEffort
			if (Object.keys(changes).length > 0) config.assign(changes)
		},
		setNextMessageOnly: (on) => config.assign({ nextMessageOnly: on }),
		reset: config.reset,
		manage: config.manage,
	})
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** The new model settings store, through its RPCs. Undefined while it isn't published. */
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
		const pending = !!live && !!model && live.modelId !== model.upstreamId
		const savedLevel = model && state.effective[model.id]?.levels.value.find((level) => level.id === pick?.levelId)
		const liveEffort = live?.reasoningEffort ?? "none"
		const levelPending =
			!!live &&
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
			manage: () => navigateToSettings("api-config"),
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
 * The one place the composer chooses its store: the new model settings when the host publishes them,
 * otherwise today's saved configurations, data and RPCs.
 */
export function useComposerSelection(mode: Mode, options: ComposerSelectionOptions): ComposerSelection {
	const { modelSettings } = useExtensionState()
	const fromProfiles = useProfileSelection(mode, options)
	const fromModelSettings = useModelSettingsSelection(mode)
	return modelSettings ? fromModelSettings(modelSettings) : fromProfiles()
}
