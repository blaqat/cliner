import {
	type Connection,
	ExtraBodySchema,
	type Json,
	type Knowledge,
	type ModelLevel,
	type ModelRow,
	type ModelValues,
	resolveModelValues,
} from "@shared/model-settings"
import { useEffect, useMemo, useState } from "react"
import { useSettingsShell } from "../shell/SettingsShellContext"
import { ManagedTag } from "../shell/SettingRow"
import {
	CommitInput,
	ControlRow,
	Field,
	FieldGrid,
	FoldHeader,
	GroupHeading,
	Hint,
	Icon,
	KNOWLEDGE_OPTIONS,
	LinkButton,
	OverrideTag,
	parseAmount,
	parseTokens,
	Segmented,
	SmallButton,
	SmallSwitch,
	Why,
} from "./fields"
import { useModelsPage } from "./modelsPageContext"
import type { PreviewResult } from "./modelSettingsClient"
import {
	DEFAULT_OFFERED,
	detectedFills,
	type Effective,
	fieldAnchor,
	fieldControl,
	hasOverride,
	levelTableRows,
	levelTitle,
	listWords,
	overridesShared,
	ROLE_LABELS,
	roleRowId,
	rolesUsingLevel,
	testPick,
	UNKNOWN_EXPLAINED,
	unknownsOf,
	withOverride,
	withoutOverride,
} from "./modelsView"
import { ModelCatalogPresets } from "./ModelCatalogPresets"
import { ProviderFieldControl } from "./ProviderFields"
import { isFieldVisible, providerSpec } from "./providerSpecs"
import { RemoveFlow } from "./RemoveFlow"

/**
 * One model, in place, with every field. Saved models write each field as it's left. A model with no
 * ID yet (a fresh duplicate) stays here until it has one: the host won't store a row without it.
 */
export const ModelForm = ({ row, connection, isDraft }: { row: ModelRow; connection: Connection; isDraft: boolean }) => {
	const page = useModelsPage()
	const { store, managedKey } = page
	const { openRow } = useSettingsShell()
	const published = store.state?.effective[row.id]
	const effective: Effective =
		published && !isDraft ? published : resolveModelValues(row.overrides, undefined, connection.defaults)
	const [error, setError] = useState<string>()
	const [unknownOpen, setUnknownOpen] = useState(false)
	const [presetsOpen, setPresetsOpen] = useState(false)
	const [blockedBy, setBlockedBy] = useState<{ text: string; roles: (keyof typeof ROLE_LABELS)[] }>()
	const [action, setAction] = useState<{ tone: "ok" | "bad" | "none"; text: string }>()
	const [busy, setBusy] = useState<"detect" | "test">()
	const moreOpen = page.isMoreOpen(row.id)

	const unknown = unknownsOf(effective)
	const apiFormat = effective.apiFormat.value ?? (connection.kind === "openai-compatible" ? connection.apiFormat : null)
	const effortName = apiFormat === "responses" ? "reasoning.effort" : "reasoning_effort"
	const hasId = !!row.upstreamId

	/** Saved models change from the latest row at write time, so two quick edits never undo each other. */
	const commit = async (change: (current: ModelRow) => ModelRow): Promise<string | undefined> => {
		setBlockedBy(undefined)
		setError(undefined)
		if (isDraft) {
			const next = change(row)
			if (!next.upstreamId) {
				page.setDraftModels((current) => current.map((draft) => (draft.id === next.id ? next : draft)))
				return undefined
			}
			const saved = await store.saveModels([next])
			if (!saved.ok) {
				setError(saved.message)
				return saved.message
			}
			page.setDraftModels((current) => current.filter((draft) => draft.id !== next.id))
			return undefined
		}
		const saved = await store.updateModel(row.id, change)
		if (!saved.ok) {
			setError(saved.message)
			return saved.message
		}
		return undefined
	}

	const set = <K extends keyof ModelValues>(key: K, value: ModelValues[K]) =>
		commit((current) => withOverride(current, key, value))
	const reset = (key: keyof ModelValues) => commit((current) => withoutOverride(current, key))

	const isManagedField = (key: keyof ModelValues) => effective[key].source === "managed"

	const tag = (key: keyof ModelValues, label: string) =>
		isManagedField(key) ? (
			<ManagedTag />
		) : overridesShared(row, connection, key) ? (
			<OverrideTag label={label} onReset={() => void reset(key)} />
		) : undefined

	/** A field left empty says what it follows, or that nobody knows. Some have a real answer for "not set". */
	const placeholderFor = (key: keyof ModelValues, whenEmpty?: string) => {
		const inherited = effective[key].value
		if (inherited !== null && !hasOverride(row, key)) {
			return { placeholder: String(inherited), unknown: false }
		}
		return whenEmpty ? { placeholder: whenEmpty, unknown: false } : { placeholder: "unknown", unknown: true }
	}

	const numberField = (key: keyof ModelValues, label: string, kind: "tokens" | "amount", hint?: string, whenEmpty?: string) => {
		const own = hasOverride(row, key) ? row.overrides[key] : undefined
		const empty = placeholderFor(key, whenEmpty)
		return (
			<Field hint={hint} id={fieldAnchor(row.id, key)} label={label} tag={tag(key, label)}>
				<CommitInput
					disabled={isManagedField(key)}
					id={fieldControl(row.id, key)}
					label={label}
					mono
					onCommit={(text) => {
						const parsed = kind === "tokens" ? parseTokens(text) : parseAmount(text)
						if ("error" in parsed) {
							return parsed.error
						}
						return parsed.value === null ? reset(key) : set(key, parsed.value as never)
					}}
					placeholder={empty.placeholder}
					unknown={empty.unknown}
					value={own == null ? "" : String(own)}
				/>
			</Field>
		)
	}

	const knowledgeRow = (
		key: "images" | "tools" | "streaming" | "promptCache" | "files",
		label: string,
		description?: string,
	) => (
		<ControlRow description={description} id={fieldAnchor(row.id, key)} label={label} tag={tag(key, label)}>
			<Segmented<Knowledge>
				controlId={fieldControl(row.id, key)}
				disabled={isManagedField(key)}
				inherited={!hasOverride(row, key) && effective[key].source === "connection"}
				label={label}
				onChange={(value) => void pickKnowledge(key, value)}
				options={KNOWLEDGE_OPTIONS}
				value={effective[key].value}
			/>
		</ControlRow>
	)

	/** With no shared default, Unknown just clears the field. With one, it's a real answer that blocks inheriting. */
	const pickKnowledge = (key: "images" | "tools" | "streaming" | "promptCache" | "files" | "reasoning", value: Knowledge) => {
		if (value === "unknown" && !connection.defaults[key]) {
			return reset(key)
		}
		return set(key, value)
	}

	const levels = effective.levels.value

	const blockLevels = (next: ModelLevel[]) => {
		const removed = levels.filter((level) => !next.some((candidate) => candidate.id === level.id))
		const roles = removed.flatMap((level) => rolesUsingLevel(store.state!.settings.roles, row.id, level.id))
		if (!roles.length) {
			return false
		}
		const level = removed.find((candidate) =>
			roles.some(() => rolesUsingLevel(store.state!.settings.roles, row.id, candidate.id).length),
		)
		setBlockedBy({
			text: `${listWords(roles.map((role) => ROLE_LABELS[role]))} ${roles.length === 1 ? "is" : "are"} on ${levelTitle(level?.label ?? "this level")}. Pick another level there first, so nothing is left on a level this model doesn't offer.`,
			roles,
		})
		return true
	}

	const setReasoning = (value: Knowledge) => {
		if (value !== "yes") {
			const stuck = levels
				.filter((level) => level.id !== "default")
				.flatMap((level) => rolesUsingLevel(store.state!.settings.roles, row.id, level.id))
			if (stuck.length) {
				setBlockedBy({
					text: `${listWords(stuck.map((role) => ROLE_LABELS[role]))} ${stuck.length === 1 ? "uses" : "use"} one of this model's levels. Pick another there first.`,
					roles: stuck,
				})
				return
			}
			return pickKnowledge("reasoning", value)
		}
		// Saying it can reason with nothing to offer yet starts from Low to High.
		const onlyDefault = levels.every((level) => level.id === "default")
		return commit((current) => {
			const next = withOverride(current, "reasoning", "yes")
			return onlyDefault ? withOverride(next, "levels", DEFAULT_OFFERED) : next
		})
	}

	const toggleLevel = (level: ModelLevel, offered: boolean) => {
		const next = offered
			? levels.filter((candidate) => candidate.id !== level.id)
			: [...levels, level].sort((a, b) => a.rank - b.rank)
		if (!next.length) {
			setBlockedBy({ text: "A model has to offer at least one level. Turn another on first.", roles: [] })
			return
		}
		if (blockLevels(next)) {
			return
		}
		void set("levels", next)
	}

	const mapLevel = (level: ModelLevel, text: string) => {
		const value = text.trim()
		if (!value) {
			return "Say what to send, or turn this level off."
		}
		const request: ModelLevel["request"] =
			level.request.kind === "thinking-budget"
				? { kind: "thinking-budget", tokens: Number(value) }
				: level.request.kind === "thinking-level"
					? { kind: "thinking-level", value }
					: { kind: "effort", value }
		if (request.kind === "thinking-budget" && !(Number.isSafeInteger(request.tokens) && request.tokens > 0)) {
			return "Has to be a whole number above 0."
		}
		return set(
			"levels",
			levels.map((candidate) => (candidate.id === level.id ? { ...candidate, request } : candidate)),
		)
	}

	const test = async () => {
		setBusy("test")
		setAction(undefined)
		const started = performance.now()
		const outcome = await store.testModel(testPick(row, effective))
		const ms = Math.round(performance.now() - started)
		setBusy(undefined)
		setAction(
			!outcome.ok
				? { tone: "bad", text: outcome.message }
				: outcome.value.status === "ok"
					? { tone: "ok", text: `${row.upstreamId} answered in ${ms} ms.` }
					: {
							tone: "bad",
							text: `${row.upstreamId} didn't answer. Check the ID, the key and the connection's API type.`,
						},
		)
	}

	const detect = async () => {
		setBusy("detect")
		setAction(undefined)
		const before = unknown.length
		const outcome = await store.detect(testPick(row, effective))
		if (!outcome.ok) {
			setBusy(undefined)
			setAction({ tone: "bad", text: outcome.message })
			return
		}
		if (outcome.value.status === "no-list") {
			setBusy(undefined)
			setAction({ tone: "none", text: "This provider doesn't report details for this model. Fill in what you know." })
			return
		}
		// The host's detected facts last until the next settings change, so keep what it found on the model.
		const found = detectedFills(row, effective, outcome.value.metadata ?? {})
		const count = Object.keys(found).length
		if (count) {
			const failed = await commit((current) => ({ ...current, overrides: { ...current.overrides, ...found } }))
			if (failed) {
				setBusy(undefined)
				return
			}
		}
		setBusy(undefined)
		setAction({
			tone: "none",
			text: count
				? `Detect found ${count}. ${Math.max(0, before - count)} still unknown.`
				: `Detect found nothing new. ${before} still unknown.`,
		})
	}

	const noIdWhy = "Type the model ID first."
	const spec = connection.kind === "provider" ? providerSpec(connection.providerId) : undefined
	const providerOptions = row.providerOptions as Record<string, unknown>
	const modelFields = spec?.modelFields?.filter((field) => isFieldVisible(field, providerOptions)) ?? []

	return (
		<div className="pb-1.5 pl-[18px]" data-testid={`model-form-${row.id}`}>
			<FieldGrid>
				<Field
					hint={
						<>
							Sent as <code>model</code>.
						</>
					}
					id={fieldAnchor(row.id, "upstreamId")}
					label="Model ID">
					<CommitInput
						id={fieldControl(row.id, "upstreamId")}
						label="Model ID"
						mono
						onCommit={(text) => {
							const upstreamId = text.trim()
							if (!upstreamId) {
								return isDraft ? undefined : "A model needs an ID. Remove it if it's not wanted."
							}
							return commit((current) => ({ ...current, upstreamId }))
						}}
						placeholder="As the server names it"
						value={row.upstreamId}
					/>
				</Field>
				<Field hint="What the selector shows." id={fieldAnchor(row.id, "name")} label="Display name">
					<CommitInput
						id={fieldControl(row.id, "name")}
						label="Display name"
						onCommit={(text) => commit((current) => ({ ...current, name: text.trim() }))}
						placeholder={row.upstreamId || "Optional"}
						value={row.name}
					/>
				</Field>
			</FieldGrid>
			<div className="mt-1.5 flex flex-wrap items-center gap-1.5">
				<SmallButton disabled={!hasId || busy === "detect"} onClick={detect} title={hasId ? undefined : noIdWhy}>
					<Icon className="text-[11px]!" name="zap" />
					{busy === "detect" ? "Detecting…" : "Detect"}
				</SmallButton>
				<SmallButton aria-expanded={presetsOpen} onClick={() => setPresetsOpen((current) => !current)}>
					Start from a preset
					<Icon className="text-[10px]!" name={presetsOpen ? "chevron-up" : "chevron-down"} />
				</SmallButton>
			</div>
			{presetsOpen && (
				<ModelCatalogPresets
					onApply={(fills) => {
						setPresetsOpen(false)
						const next = { ...fills }
						for (const key of Object.keys(next) as (keyof ModelValues)[]) {
							if (hasOverride(row, key)) {
								delete next[key]
							}
						}
						void commit((current) => ({ ...current, overrides: { ...current.overrides, ...next } }))
					}}
				/>
			)}
			{unknown.length > 0 ? (
				<Why tone="warn">
					<b className="font-medium">{unknown.length} unknown:</b> {listWords(unknown)}. Cline won't guess.{" "}
					<LinkButton onClick={() => setUnknownOpen((current) => !current)}>
						{unknownOpen ? "Hide" : "What happens"}
					</LinkButton>
					{unknownOpen && (
						<ul className="m-0 mt-1 list-disc pl-4" data-testid="unknown-explained">
							{unknown.map((entry) => (
								<li key={entry}>{UNKNOWN_EXPLAINED[entry]}</li>
							))}
						</ul>
					)}
				</Why>
			) : (
				<div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-description">
					<Icon className="text-[11px]!" name="check" />
					Nothing unknown.
				</div>
			)}

			<GroupHeading>Limits</GroupHeading>
			<FieldGrid className="mt-0.5">
				{numberField(
					"contextWindow",
					"Context window",
					"tokens",
					effective.contextWindow.value === null
						? "Unknown: Cline plans with 128K and marks the ring with ~."
						: undefined,
				)}
				{numberField("maxOutputTokens", "Max output tokens", "tokens")}
			</FieldGrid>

			<GroupHeading>What it can do</GroupHeading>
			{knowledgeRow("images", "Images")}
			{knowledgeRow("tools", "Tools")}
			<div className="scroll-my-2 rounded-xs" id={fieldAnchor(row.id, "levels")}>
				<ControlRow id={fieldAnchor(row.id, "reasoning")} label="Reasoning" tag={tag("reasoning", "Reasoning")}>
					<Segmented<Knowledge>
						controlId={fieldControl(row.id, effective.reasoning.value === "yes" ? "reasoning" : "levels")}
						disabled={isManagedField("reasoning")}
						inherited={!hasOverride(row, "reasoning") && effective.reasoning.source === "connection"}
						label="Reasoning"
						onChange={(value) => void setReasoning(value)}
						options={KNOWLEDGE_OPTIONS}
						value={effective.reasoning.value}
					/>
				</ControlRow>
				{effective.reasoning.value === "yes" ? (
					<LevelTable
						connection={connection}
						effortName={effortName}
						levels={levels}
						onMap={mapLevel}
						onToggle={toggleLevel}
						row={row}
						onReset={() => void reset("levels")}
					/>
				) : effective.reasoning.value === "no" ? (
					<Hint>The selector shows no levels for this model.</Hint>
				) : (
					<Hint>The selector can't offer levels until you say whether it can reason. Detect tries it.</Hint>
				)}
				{blockedBy && (
					<Why tone="warn">
						{blockedBy.text}{" "}
						{blockedBy.roles.map((role) => (
							<LinkButton key={role} onClick={() => openRow(roleRowId[role])}>
								Open {ROLE_LABELS[role]}
							</LinkButton>
						))}
					</Why>
				)}
			</div>

			<GroupHeading>Request</GroupHeading>
			<FieldGrid className="mt-0.5">
				{numberField("temperature", "Temperature", "amount", undefined, "Server default")}
			</FieldGrid>
			<ControlRow id={fieldAnchor(row.id, "verbosity")} label="Verbosity" tag={tag("verbosity", "Verbosity")}>
				<Segmented<"default" | "low" | "medium" | "high">
					controlId={fieldControl(row.id, "verbosity")}
					label="Verbosity"
					onChange={(value) => void (value === "default" ? reset("verbosity") : set("verbosity", value))}
					options={[
						{ value: "default", label: "Default" },
						{ value: "low", label: "Low" },
						{ value: "medium", label: "Medium" },
						{ value: "high", label: "High" },
					]}
					value={effective.verbosity.value ?? "default"}
					wrap
				/>
			</ControlRow>
			<ExtraBodyEditor onSave={(extraBody) => set("extraBody", extraBody)} value={effective.extraBody.value} />

			<GroupHeading>Price · USD per 1M tokens</GroupHeading>
			<ControlRow
				description="Self-hosted, or someone else pays. Cost shows $0."
				id={fieldAnchor(row.id, "free")}
				label="Free"
				tag={tag("free", "Free")}>
				<SmallSwitch
					checked={effective.free.value}
					id={fieldControl(row.id, "free")}
					label="Free"
					onChange={(free) => void set("free", free)}
				/>
			</ControlRow>
			{!effective.free.value && (
				<>
					<FieldGrid className="mt-0">
						{numberField("inputPrice", "Input", "amount")}
						{numberField("outputPrice", "Output", "amount")}
					</FieldGrid>
					{(effective.inputPrice.value === null || effective.outputPrice.value === null) && (
						<Hint>Cost shows “unknown” until both are set, never $0.</Hint>
					)}
				</>
			)}

			{modelFields.length > 0 && (
				<>
					<GroupHeading>{connection.name}</GroupHeading>
					<FieldGrid className="mt-0.5">
						{modelFields.map((field) => (
							<ProviderFieldControl
								field={field}
								id={fieldControl(row.id, field.id)}
								key={field.id}
								locked={managedKey(field.id)}
								onChange={(value) => {
									const cleared = value === "" || value === undefined
									return commit((current) => {
										const { [field.id]: _old, ...rest } = current.providerOptions as Record<string, unknown>
										return {
											...current,
											providerOptions: (cleared
												? rest
												: { ...rest, [field.id]: value }) as ModelRow["providerOptions"],
										}
									})
								}}
								value={providerOptions[field.id]}
							/>
						))}
					</FieldGrid>
				</>
			)}

			<FoldHeader
				onToggle={() => page.setMoreOpen(row.id)}
				open={moreOpen}
				summary="max input, streaming, prompt cache, files, system role, API type, thinking budget"
				title="More"
			/>
			{moreOpen && (
				<>
					<FieldGrid className="mt-0">
						{numberField(
							"maxInputTokens",
							"Max input tokens",
							"tokens",
							"If the server limits input apart from the context window.",
							"No limit of its own",
						)}
						{numberField(
							"thinkingBudgetTokens",
							"Thinking budget",
							"tokens",
							"Tokens. Empty follows the level.",
							"From the level",
						)}
					</FieldGrid>
					{knowledgeRow("streaming", "Streaming")}
					{knowledgeRow("promptCache", "Prompt cache")}
					{effective.promptCache.value === "yes" && !effective.free.value && (
						<FieldGrid className="mt-0">
							{numberField("cacheReadPrice", "Cache read price", "amount")}
							{numberField("cacheWritePrice", "Cache write price", "amount")}
						</FieldGrid>
					)}
					{knowledgeRow("files", "Files", "Attach documents, not just images.")}
					<ControlRow id={fieldAnchor(row.id, "systemRole")} label="System role" tag={tag("systemRole", "System role")}>
						<Segmented<"system" | "developer">
							controlId={fieldControl(row.id, "systemRole")}
							label="System role"
							onChange={(value) => void set("systemRole", value)}
							options={[
								{ value: "system", label: "system" },
								{ value: "developer", label: "developer" },
							]}
							value={effective.systemRole.value}
						/>
					</ControlRow>
					{connection.kind === "openai-compatible" && (
						<ControlRow id={fieldAnchor(row.id, "apiFormat")} label="API type" tag={tag("apiFormat", "API type")}>
							<Segmented<"same" | "chat" | "responses">
								controlId={fieldControl(row.id, "apiFormat")}
								label="API type"
								onChange={(value) => void (value === "same" ? reset("apiFormat") : set("apiFormat", value))}
								options={[
									{ value: "same", label: "Same as connection" },
									{ value: "chat", label: "Chat" },
									{ value: "responses", label: "Responses" },
								]}
								value={effective.apiFormat.value ?? "same"}
								wrap
							/>
						</ControlRow>
					)}
				</>
			)}

			<RequestPreview disabledReason={hasId ? undefined : noIdWhy} effective={effective} row={row} />

			{action && (
				<div
					className={
						action.tone === "bad"
							? "mt-1 text-[11px] text-error"
							: action.tone === "ok"
								? "mt-1 text-[11px] text-success"
								: "mt-1 text-[11px] text-description"
					}
					role="status">
					{action.text}
				</div>
			)}
			{error && <Why tone="bad">{error}</Why>}
			<div className="mt-1.5 flex flex-wrap items-center gap-2">
				<SmallButton disabled={!hasId || busy === "test"} onClick={test} title={hasId ? undefined : noIdWhy}>
					{busy === "test" ? "Testing…" : "Test this model"}
				</SmallButton>
				{isDraft ? (
					<LinkButton onClick={() => page.setDraftModels((current) => current.filter((draft) => draft.id !== row.id))}>
						Remove
					</LinkButton>
				) : (
					<RemoveFlow
						modelIds={[row.id]}
						label="Remove"
						onRemove={() => store.deleteModel(row.id)}
						onRemoved={() => page.setOpenModel(null)}
						question={`Remove ${row.name || row.upstreamId}?`}
						removedName={row.name || row.upstreamId}
					/>
				)}
			</div>
			<div className="mt-2 flex items-start gap-1.5 text-[11px] text-description">
				<Icon className="mt-px text-[11px]! opacity-70" name="chip" />
				<span>Shows in the composer and every selector.</span>
			</div>
		</div>
	)
}

const LevelTable = ({
	row,
	connection,
	levels,
	effortName,
	onToggle,
	onMap,
	onReset,
}: {
	row: ModelRow
	connection: Connection
	levels: ModelLevel[]
	effortName: string
	onToggle: (level: ModelLevel, offered: boolean) => void
	onMap: (level: ModelLevel, text: string) => Promise<string | undefined> | string | undefined
	onReset: () => void
}) => {
	const rows = levelTableRows(levels)
	const lastOn = levels.length === 1
	const firstEnabled = rows.find((entry) => !(lastOn && entry.offered))?.level.id
	return (
		<div className="mt-0.5 mb-1 rounded-[5px] border border-editor-group-border px-2 py-1.5" data-testid="level-table">
			{overridesShared(row, connection, "levels") && (
				<div className="mb-1 flex items-center gap-1.5">
					<OverrideTag label="Levels" onReset={onReset} />
				</div>
			)}
			<div className="grid grid-cols-[52px_44px_minmax(0,1fr)] items-center gap-x-2 gap-y-[3px] text-[11.5px]">
				<span className="text-[10px] text-description">Level</span>
				<span className="text-[10px] text-description">Offered</span>
				<span className="text-[10px] text-description">
					Sent as <code>{effortName}</code>
				</span>
				{rows.map(({ level, offered }) => (
					<LevelRow
						firstControlId={level.id === firstEnabled ? fieldControl(row.id, "levels") : undefined}
						key={level.id}
						lastOn={lastOn && offered}
						level={level}
						offered={offered}
						onMap={onMap}
						onToggle={onToggle}
					/>
				))}
			</div>
		</div>
	)
}

const LevelRow = ({
	level,
	offered,
	lastOn,
	firstControlId,
	onToggle,
	onMap,
}: {
	level: ModelLevel
	offered: boolean
	lastOn: boolean
	firstControlId?: string
	onToggle: (level: ModelLevel, offered: boolean) => void
	onMap: (level: ModelLevel, text: string) => Promise<string | undefined> | string | undefined
}) => {
	const title = levelTitle(level.label)
	const request = level.request
	const sent =
		request.kind === "effort" || request.kind === "thinking-level"
			? request.value
			: request.kind === "thinking-budget"
				? String(request.tokens)
				: ""
	return (
		<>
			<span className="truncate" title={title}>
				{title}
			</span>
			<SmallSwitch
				checked={offered}
				disabled={lastOn}
				id={firstControlId}
				label={`Offer ${title}`}
				onChange={() => onToggle(level, offered)}
				title={lastOn ? "A model has to offer at least one level." : undefined}
			/>
			{request.kind === "default" ? (
				<span className="text-[11px] text-description opacity-80">Nothing sent</span>
			) : (
				<div className="min-w-0">
					<CommitInput
						disabled={!offered}
						label={`${title} is sent as`}
						mono
						onCommit={(text) => onMap(level, text)}
						placeholder={level.id}
						value={sent}
					/>
				</div>
			)}
		</>
	)
}

const parseExtraValue = (text: string): Json => {
	try {
		return JSON.parse(text) as Json
	} catch {
		return text
	}
}

const ExtraBodyEditor = ({
	value,
	onSave,
}: {
	value: Record<string, Json>
	onSave: (next: Record<string, Json>) => Promise<string | undefined>
}) => {
	const entries = useMemo(
		() => Object.entries(value).map(([key, item]) => ({ key, text: typeof item === "string" ? item : JSON.stringify(item) })),
		[value],
	)
	const [pending, setPending] = useState<{ id: number; key: string; text: string }[]>([])

	const save = async (next: Record<string, Json>) => {
		const checked = ExtraBodySchema.safeParse(next)
		if (!checked.success) {
			return "That name is handled by its own control (like temperature or tools), or holds a credential. Use the control instead."
		}
		return onSave(next)
	}

	return (
		<div data-testid="extra-body">
			<div className="mt-2 flex flex-wrap items-center gap-x-1.5 text-[11px] text-description">
				<span>Extra body params</span>
				<span className="opacity-70">merged into every request</span>
			</div>
			{entries.map((entry) => (
				<div className="mt-1 grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-1" key={entry.key}>
					<CommitInput
						label="Param name"
						mono
						onCommit={(text) => {
							const name = text.trim()
							const next = Object.fromEntries(
								Object.entries(value).map(([key, item]) => (key === entry.key ? [name, item] : [key, item])),
							)
							return name ? save(next) : "Give it a name, or remove it."
						}}
						placeholder="top_p"
						value={entry.key}
					/>
					<CommitInput
						label="Param value"
						mono
						onCommit={(text) => save({ ...value, [entry.key]: parseExtraValue(text) })}
						placeholder="Value or JSON"
						value={entry.text}
					/>
					<button
						aria-label={`Remove ${entry.key}`}
						className="grid size-[22px] cursor-pointer place-items-center rounded-xs border-0 bg-transparent text-description hover:bg-list-hover hover:text-foreground"
						onClick={() => {
							const { [entry.key]: _removed, ...rest } = value
							void save(rest)
						}}
						title="Remove"
						type="button">
						<Icon name="close" />
					</button>
				</div>
			))}
			{pending.map((item) => (
				<div className="mt-1 grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-1" key={item.id}>
					<CommitInput
						label="Param name"
						mono
						onCommit={async (text) => {
							const key = text.trim()
							if (!key) {
								return undefined
							}
							setPending((current) => current.map((entry) => (entry.id === item.id ? { ...entry, key } : entry)))
							if (!item.text) {
								return undefined
							}
							const failed = await save({ ...value, [key]: parseExtraValue(item.text) })
							if (!failed) {
								setPending((current) => current.filter((entry) => entry.id !== item.id))
							}
							return failed
						}}
						placeholder="top_p"
						value={item.key}
					/>
					<CommitInput
						label="Param value"
						mono
						onCommit={async (text) => {
							setPending((current) => current.map((entry) => (entry.id === item.id ? { ...entry, text } : entry)))
							if (!item.key) {
								return undefined
							}
							const failed = await save({ ...value, [item.key]: parseExtraValue(text) })
							if (!failed) {
								setPending((current) => current.filter((entry) => entry.id !== item.id))
							}
							return failed
						}}
						placeholder="Value or JSON"
						value={item.text}
					/>
					<button
						aria-label="Remove"
						className="grid size-[22px] cursor-pointer place-items-center rounded-xs border-0 bg-transparent text-description hover:bg-list-hover"
						onClick={() => setPending((current) => current.filter((entry) => entry.id !== item.id))}
						type="button">
						<Icon name="close" />
					</button>
				</div>
			))}
			<div className="mt-1.5">
				<LinkButton onClick={() => setPending((current) => [...current, { id: Date.now(), key: "", text: "" }])}>
					<Icon className="text-[11px]!" name="add" />
					Add param
				</LinkButton>
			</div>
		</div>
	)
}

/** What the host would send, built by the host. It never guesses, and says so when it can't show the exact request. */
const RequestPreview = ({ row, effective, disabledReason }: { row: ModelRow; effective: Effective; disabledReason?: string }) => {
	const { store } = useModelsPage()
	const [open, setOpen] = useState(false)
	const [preview, setPreview] = useState<{ result?: PreviewResult; error?: string; loading: boolean }>({ loading: false })
	const revision = store.state?.settings.revision
	const pick = testPick(row, effective)

	// biome-ignore lint/correctness/useExhaustiveDependencies: refetches when the store changes or the pick does, not each render.
	useEffect(() => {
		if (!open || disabledReason) {
			return
		}
		let current = true
		setPreview((previous) => ({ ...previous, loading: true }))
		void store.preview(pick).then((outcome) => {
			if (current) {
				setPreview(outcome.ok ? { result: outcome.value, loading: false } : { error: outcome.message, loading: false })
			}
		})
		return () => {
			current = false
		}
	}, [open, revision, pick.levelId, pick.modelId, disabledReason])

	const text = (() => {
		const result = preview.result
		if (!result?.exact) {
			return undefined
		}
		const headers = Object.entries(result.request.headers).map(([name, value]) => `${name}: ${value}`)
		return [
			`${result.request.method} ${result.request.url}`,
			...headers,
			"",
			JSON.stringify(result.request.body, null, 2),
		].join("\n")
	})()

	return (
		<div data-testid="request-preview">
			<FoldHeader
				onToggle={() => setOpen((current) => !current)}
				open={open}
				summary="exactly what gets sent"
				title="Preview the request"
			/>
			{open && disabledReason && <Hint>{disabledReason}</Hint>}
			{open && !disabledReason && preview.loading && !text && <Hint>Building it…</Hint>}
			{open && !disabledReason && preview.error && <Why tone="bad">{preview.error}</Why>}
			{open && !disabledReason && preview.result && !preview.result.exact && (
				<Why>Can't show this one exactly: {preview.result.reason}.</Why>
			)}
			{open && !disabledReason && text && (
				<pre className="m-0 rounded-md border border-editor-group-border bg-input-background px-2.5 py-2 font-mono text-[11px] leading-[1.55] whitespace-pre-wrap break-words text-description">
					{text}
				</pre>
			)}
		</div>
	)
}
