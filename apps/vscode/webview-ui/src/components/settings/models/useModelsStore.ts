import type { Connection, ConnectionPatch, ModelPick, ModelRow, RoleSettings, SubagentPolicy } from "@shared/model-settings"
import type { ModelSettingsState } from "@shared/model-settings-state"
import { useCallback, useMemo, useRef, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { modelSettingsClient as client, isStaleSettings, type SecretMutation } from "./modelSettingsClient"
import { friendlyError } from "./modelsView"

export type Outcome<T> = { ok: true; value: T } | { ok: false; message: string }

const newer = (a: ModelSettingsState | undefined, b: ModelSettingsState | undefined) => {
	if (!a) return b
	if (!b) return a
	return b.settings.revision >= a.settings.revision ? b : a
}

/**
 * The published store plus whatever the last call returned, whichever is newer. Saves run one at a
 * time, each against the revision the last one left behind, so quick edits never trip the revision check.
 * If settings moved anyway (another window, or an edit that stopped a running test) the call runs once
 * more on what's there now. Tests and lookups wait for earlier saves but never hold up later ones.
 */
export const useModelsStore = () => {
	const published = useExtensionState().modelSettings
	const [returned, setReturned] = useState<ModelSettingsState>()
	const state = newer(published, returned)
	const stateRef = useRef(state)
	stateRef.current = state
	const queue = useRef<Promise<unknown>>(Promise.resolve())

	const attempt = useCallback(async <T>(work: (revision: number) => Promise<T>): Promise<Outcome<T>> => {
		const once = async () => ({ ok: true as const, value: await work(stateRef.current?.settings.revision ?? 0) })
		try {
			return await once()
		} catch (error) {
			if (!isStaleSettings(error)) {
				return { ok: false, message: friendlyError(error) }
			}
			try {
				const fresh = await client.get()
				stateRef.current = fresh
				setReturned(fresh)
				return await once()
			} catch (retried) {
				return { ok: false, message: friendlyError(retried) }
			}
		}
	}, [])

	const run = useCallback(
		<T>(work: (revision: number) => Promise<T>): Promise<Outcome<T>> => {
			const next = queue.current.then(() => attempt(work))
			queue.current = next
			return next
		},
		[attempt],
	)

	const lookup = useCallback(
		<T>(work: (revision: number) => Promise<T>): Promise<Outcome<T>> => queue.current.then(() => attempt(work)),
		[attempt],
	)

	const mutate = useCallback(
		(work: (revision: number) => Promise<ModelSettingsState>) =>
			run(async (revision) => {
				const fresh = await work(revision)
				stateRef.current = fresh
				setReturned(fresh)
				return fresh
			}),
		[run],
	)

	return useMemo(
		() => ({
			state,
			latest: () => stateRef.current,
			run,
			saveConnection: (connection: ConnectionPatch | Connection, secrets?: SecretMutation[]) =>
				mutate((revision) => client.saveConnection(revision, connection, secrets)),
			saveModels: (models: ModelRow[]) => mutate((revision) => client.saveModels(revision, models)),
			updateModel: (modelId: string, change: (current: ModelRow) => ModelRow) =>
				mutate((revision) => {
					const current = stateRef.current?.settings.models.find((model) => model.id === modelId)
					if (!current) {
						throw new Error("This model is gone. Reopen Settings to see the list as it is.")
					}
					return client.saveModels(revision, [change(current)])
				}),
			deleteModel: (modelId: string) => mutate((revision) => client.deleteModel(revision, modelId)),
			deleteConnection: (connectionId: string) => mutate((revision) => client.deleteConnection(revision, connectionId)),
			setRoles: (change: (roles: RoleSettings) => RoleSettings) =>
				mutate((revision) => client.setRoles(revision, change(stateRef.current?.settings.roles as RoleSettings))),
			setPolicy: (change: (policy: SubagentPolicy) => SubagentPolicy) =>
				mutate((revision) => client.setPolicy(revision, change(stateRef.current?.settings.subagents as SubagentPolicy))),
			savedThreadUsage: (modelIds: string[]) => lookup(() => client.savedThreadUsage(modelIds)),
			duplicate: (modelId: string) => lookup(() => client.duplicateModel(modelId)),
			discover: (connectionId: string) => lookup((revision) => client.discover(revision, connectionId)),
			preview: (pick: ModelPick) => lookup((revision) => client.preview(revision, pick)),
		}),
		[state, mutate, run, lookup],
	)
}

export type ModelsStore = ReturnType<typeof useModelsStore>
