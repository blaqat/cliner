import type { ModelPick, RoleSettings, SubagentPick } from "@shared/model-settings"
import type { ModelSettingsState } from "@shared/model-settings-state"
import { useMemo, useState } from "react"
import { ModelPickButton } from "@/components/models/ModelPickButton"
import type { SelectorPick, SelectorRow } from "@/components/models/ModelSelector"
import { sameAsThreadRow, selectorDataFromModelSettings } from "@/components/models/modelSelectorRows"
import { type SettingsNavigationTarget, settingsTargetFromHost } from "../settingsTargets"
import { AdvancedFold } from "../shell/AdvancedFold"
import { SettingBlock, SettingGroup, SettingRow, ToggleRow } from "../shell/SettingRow"
import { useSettingsShell } from "../shell/SettingsShellContext"
import { CommitInput, GroupHeading, Hint, LinkButton, Notice, parseSeconds, Why } from "./fields"
import { useModelsPage } from "./modelsPageContext"
import {
	connectionName,
	connectionProblem,
	levelTitle,
	listWords,
	ROLE_LABELS,
	type RoleKey,
	rolePick,
	roleRowId,
} from "./modelsView"

const MANAGE_ROW = "models.connections"

const toPick = (pick: ModelPick | null): SelectorPick | null => (pick ? { rowId: pick.modelId, levelId: pick.levelId } : null)
const fromPick = (pick: SelectorPick): ModelPick => ({ modelId: pick.rowId, levelId: pick.levelId })

/** Says why a saved pick won't start, with both ways out right there. Nothing here is silently corrected. */
const PickWhy = ({
	pick,
	onFixLevel,
	state,
	use,
}: {
	pick: ModelPick | null
	onFixLevel: () => void
	state: ModelSettingsState
	/** The host's availability key for this pick, which says what to fix when it refuses one. */
	use: string
}) => {
	const page = useModelsPage()
	const { openRow } = useSettingsShell()
	if (!pick) {
		return null
	}
	const row = state.settings.models.find((model) => model.id === pick.modelId)
	if (!row) {
		return (
			<Why tone="bad">
				This pick's model is gone, so it won't start. <LinkButton onClick={onFixLevel}>Pick another</LinkButton>
			</Why>
		)
	}
	const connection = state.settings.connections.find((candidate) => candidate.id === row.connectionId)
	const name = row.name || row.upstreamId
	const effective = state.effective[row.id]
	const availability = state.availability[row.id]
	const hostTarget = state.availability[use]?.target
	// A connection's own problem shows once, above these rows.
	if (availability && !availability.available && connection && !connectionProblem(availability)) {
		const target = availability.target ?? { page: "models", connectionId: connection.id }
		const words = target.field === "upstreamId" ? "no model ID" : availability.reason?.replace(/\.$/, "").toLowerCase()
		return (
			<Why tone="bad">
				{connectionName(connection)}: {words}, so this pick won't start.{" "}
				<LinkButton
					onClick={() => {
						page.setOpenConnection(connection.id)
						if (!target.modelId) {
							page.setEditingConnection(connection.id, true)
						}
						openRow(settingsTargetFromHost(target))
					}}>
					Fix it
				</LinkButton>
			</Why>
		)
	}
	const reasons = effective?.reasoning.value === "yes" || pick.levelId !== "default"
	const offered = effective?.levels.value.some((level) => level.id === pick.levelId)
	if (reasons && !offered) {
		return (
			<Why tone="bad">
				{name} doesn't offer {levelTitle(pick.levelId)}, so this pick won't start.{" "}
				<LinkButton onClick={onFixLevel}>Pick a level</LinkButton>
				{" · "}
				<LinkButton
					onClick={() => {
						page.setOpenConnection(row.connectionId)
						page.setOpenModel(row.id)
						openRow(
							settingsTargetFromHost(
								hostTarget?.modelId === row.id
									? hostTarget
									: { page: "models", modelId: row.id, field: "levels" },
							),
						)
					}}>
					Edit the model
				</LinkButton>
			</Why>
		)
	}
	return null
}

/** One line per connection with a problem, naming the picks it stops, so a missing key isn't repeated on every row. */
const ConnectionProblems = ({ state }: { state: ModelSettingsState }) => {
	const page = useModelsPage()
	const { openRow } = useSettingsShell()
	const { connections, models, roles } = state.settings
	return (
		<>
			{connections.map((connection) => {
				const stopped = (Object.keys(ROLE_LABELS) as RoleKey[]).flatMap((role) => {
					const pick = rolePick(roles, role)
					const row = pick && models.find((model) => model.id === pick.modelId && model.connectionId === connection.id)
					const problem = row ? connectionProblem(state.availability[row.id]) : undefined
					return row && problem ? [{ role, problem, target: state.availability[row.id]?.target }] : []
				})
				if (!stopped.length) {
					return null
				}
				const [{ problem, target }] = stopped
				return (
					<Notice key={connection.id} tone="warn">
						{connectionName(connection)}: {problem}, so {listWords(stopped.map(({ role }) => ROLE_LABELS[role]))}{" "}
						won't start.{" "}
						<LinkButton
							onClick={() => {
								page.setOpenConnection(connection.id)
								page.setEditingConnection(connection.id, true)
								openRow(settingsTargetFromHost(target ?? { page: "models", connectionId: connection.id }))
							}}>
							Fix it
						</LinkButton>
					</Notice>
				)
			})}
		</>
	)
}

const sameRow = (id: string, label: string, levelLabel: string): SelectorRow => ({
	id,
	label,
	levels: [{ id: "same", label: levelLabel }],
	defaultLevelId: "same",
})

/** The role rows above the list: which model does what. Picking is all they do; the model's facts live below. */
export const ModelRoles = () => {
	const { store } = useModelsPage()
	const { openRow } = useSettingsShell()
	const [errors, setErrors] = useState<Partial<Record<string, string>>>({})
	const state = store.state as ModelSettingsState
	const { rows, ladder } = useMemo(() => selectorDataFromModelSettings(state), [state])
	const roles = state.settings.roles

	const onManage = (target?: SettingsNavigationTarget) => openRow(target ?? MANAGE_ROW)
	const focusRole = (role: RoleKey) => openRow(roleRowId[role])

	const setRoles = async (key: string, change: (current: RoleSettings) => RoleSettings) => {
		const outcome = await store.setRoles(change)
		setErrors((current) => ({ ...current, [key]: outcome.ok ? undefined : outcome.message }))
	}

	const roleError = (key: string) => errors[key] && <Why tone="bad">{errors[key]}</Why>

	const subagentPick: SelectorPick =
		roles.subagents.kind === "thread"
			? { rowId: "thread", levelId: roles.subagents.level }
			: (toPick(roles.subagents.pick) ?? { rowId: "thread", levelId: "inherit" })

	const useLine = (role: "titles" | "commitMessages" | "generate", label: string, description?: React.ReactNode) => {
		const same = sameRow("same", "Same as Background text", "Its level")
		const pick = roles.background.overrides[role]
		return (
			<SettingRow
				control={({ id, disabled }) => (
					<ModelPickButton
						disabledReason={disabled ? "Your organization manages this." : undefined}
						id={id}
						ladder={ladder}
						modelsLabel={label}
						onCommit={(next) =>
							void setRoles(role, (current) => {
								const { [role]: _old, ...overrides } = current.background.overrides
								return {
									...current,
									background: {
										...current.background,
										overrides: next.rowId === "same" ? overrides : { ...overrides, [role]: fromPick(next) },
									},
								}
							})
						}
						onManage={onManage}
						pick={pick ? toPick(pick) : { rowId: "same", levelId: "same" }}
						rows={[same, ...rows]}
					/>
				)}
				rowId={roleRowId[role]}>
				{description}
				{pick && <PickWhy onFixLevel={() => focusRole(role)} pick={pick} state={state} use={`background.${role}`} />}
				{roleError(role)}
			</SettingRow>
		)
	}

	return (
		<>
			<ConnectionProblems state={state} />
			<SettingGroup title="What runs where">
				<SettingRow
					control={({ id, disabled }) => (
						<ModelPickButton
							disabledReason={disabled ? "Your organization manages this." : undefined}
							id={id}
							ladder={ladder}
							modelsLabel="Chat"
							onCommit={(next) => void setRoles("chat", (current) => ({ ...current, chat: fromPick(next) }))}
							onManage={onManage}
							pick={toPick(roles.chat)}
							rows={rows}
						/>
					)}
					rowId={roleRowId.chat}>
					{rows.length > 0 && !roles.chat && <Hint error>Threads can't start until you pick one.</Hint>}
					<PickWhy onFixLevel={() => focusRole("chat")} pick={roles.chat} state={state} use="role.chat" />
					{roleError("chat")}
				</SettingRow>
				<SettingRow<SubagentPick>
					control={({ id, disabled }) => (
						<ModelPickButton
							disabledReason={disabled ? "Your organization manages this." : undefined}
							id={id}
							ladder={ladder}
							modelsLabel="Subagents"
							onCommit={(next) =>
								void setRoles("subagents", (current) => ({
									...current,
									subagents:
										next.rowId === "thread"
											? { kind: "thread", level: next.levelId }
											: { kind: "model", pick: fromPick(next) },
								}))
							}
							onManage={onManage}
							pick={subagentPick}
							rows={[sameAsThreadRow(ladder), ...rows]}
						/>
					)}
					rowId={roleRowId.subagents}>
					<div className="text-[12px] text-description">
						What helpers run on. <LinkButton onClick={() => openRow("subagents")}>More on Subagents</LinkButton>
					</div>
					{roles.subagents.kind === "model" && (
						<PickWhy
							onFixLevel={() => focusRole("subagents")}
							pick={roles.subagents.pick}
							state={state}
							use="role.subagents"
						/>
					)}
					{roleError("subagents")}
				</SettingRow>
				<SettingRow
					control={({ id, disabled }) => (
						<ModelPickButton
							disabledReason={disabled ? "Your organization manages this." : undefined}
							id={id}
							ladder={ladder}
							modelsLabel="Background text"
							onCommit={(next) =>
								void setRoles("background", (current) => ({
									...current,
									background: { ...current.background, pick: fromPick(next) },
								}))
							}
							onManage={onManage}
							pick={toPick(roles.background.pick)}
							rows={rows}
						/>
					)}
					rowId={roleRowId.background}>
					{rows.length > 0 && !roles.background.pick && (
						<Hint error>Commit messages, thread titles and Generate have nothing to run on until you pick one.</Hint>
					)}
					<PickWhy
						onFixLevel={() => focusRole("background")}
						pick={roles.background.pick}
						state={state}
						use="role.background"
					/>
					{roleError("background")}
				</SettingRow>
				<ToggleRow rowId="models.background.titles-enabled" />
				<SettingBlock rowId="models.advanced">
					<div className="pb-3">
						<AdvancedFold featureId="models.advanced" summary="Ask model, background text, timeout">
							<GroupHeading>Chat</GroupHeading>
							<SettingRow
								control={({ id, disabled }) => {
									const pick = roles.ask.enabled ? toPick(roles.ask.pick) : { rowId: "same", levelId: "same" }
									return (
										<ModelPickButton
											disabledReason={disabled ? "Your organization manages this." : undefined}
											id={id}
											ladder={ladder}
											modelsLabel="Different model for Ask"
											onCommit={(next) =>
												void setRoles("ask", (current) => ({
													...current,
													ask:
														next.rowId === "same"
															? { enabled: false, pick: null }
															: { enabled: true, pick: fromPick(next) },
												}))
											}
											onManage={onManage}
											pick={pick}
											rows={[sameRow("same", "Same as Chat", "Chat's level"), ...rows]}
										/>
									)
								}}
								rowId={roleRowId.ask}>
								{roles.ask.enabled && (
									<PickWhy
										onFixLevel={() => focusRole("ask")}
										pick={roles.ask.pick}
										state={state}
										use="role.ask"
									/>
								)}
								{roleError("ask")}
							</SettingRow>
							<GroupHeading>Background text</GroupHeading>
							{useLine("commitMessages", "Commit messages")}
							{useLine("generate", "Walkthrough Generate")}
							{useLine(
								"titles",
								"Thread titles",
								!roles.background.titlesEnabled && (
									<div className="text-[12px] text-description">
										Only with{" "}
										<LinkButton onClick={() => openRow("models.background.titles-enabled")}>
											Generate thread titles
										</LinkButton>{" "}
										on.
									</div>
								),
							)}
							<GroupHeading>Every request</GroupHeading>
							<SettingRow<number | null>
								control={({ id, disabled, label, value, write }) => (
									<CommitInput
										className="w-[72px] text-right"
										disabled={disabled}
										id={id}
										label={label}
										mono
										onCommit={(text) => {
											const parsed = parseSeconds(text)
											if ("error" in parsed) {
												return parsed.error
											}
											write(parsed.value)
											return undefined
										}}
										placeholder="Default"
										value={value == null ? "" : String(value / 1000)}
									/>
								)}
								rowId="models.timeout"
							/>
						</AdvancedFold>
					</div>
				</SettingBlock>
			</SettingGroup>
		</>
	)
}
