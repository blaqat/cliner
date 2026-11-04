import type { Connection, ConnectionPatch, ModelPick, ModelRow, RoleSettings, SubagentPolicy } from "@shared/model-settings"
import type { ModelSettingsState } from "@shared/model-settings-state"
import { useCallback, useMemo, useRef, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { modelSettingsClient as client, type DeleteResult, type SecretMutation } from "./modelSettingsClient"
import { friendlyError } from "./modelsView"

export type Outcome<T> = { ok: true; value: T } | { ok: false; message: string }

const isStale = (error: unknown) =>
	/another window|settings changed/i.test(error instanceof Error ? error.message : String(error))

const newer = (a: ModelSettingsState | undefined, b: ModelSettingsState | undefined) => {
	if (!a) return b
	if (!b) return a
	return b.settings.revision >= a.settings.revision ? b : a
}

/**
 * The published store plus whatever the last call returned, whichever is newer. Calls run one at a
 * time, each against the revision the last one left behind, so quick edits never trip the revision check.
 * A real mismatch (another window) refreshes and says so; the person retries.
 */
export const useModelsStore = () => {
	const published = useExtensionState().modelSettings
	const [returned, setReturned] = useState<ModelSettingsState>()
	const state = newer(published, returned)
	const stateRef = useRef(state)
	stateRef.current = state
	const queue = useRef<Promise<unknown>>(Promise.resolve())

	const run = useCallback(<T>(work: (revision: number) => Promise<T>): Promise<Outcome<T>> => {
		const next = queue.current.then(async (): Promise<Outcome<T>> => {
			try {
				return { ok: true, value: await work(stateRef.current?.settings.revision ?? 0) }
			} catch (error) {
				if (isStale(error)) {
					try {
						const fresh = await client.get()
						stateRef.current = fresh
						setReturned(fresh)
					} catch {
						// The error below still says what happened.
					}
				}
				return { ok: false, message: friendlyError(error) }
			}
		})
		queue.current = next
		return next
	}, [])

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

	const remove = useCallback(
		(work: (revision: number) => Promise<DeleteResult>) =>
			run(async (revision) => {
				const result = await work(revision)
				if (!("dependencies" in result)) {
					stateRef.current = result
					setReturned(result)
				}
				return result
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
			deleteModel: (modelId: string) => remove((revision) => client.deleteModel(revision, modelId)),
			deleteConnection: (connectionId: string) => remove((revision) => client.deleteConnection(revision, connectionId)),
			setRoles: (change: (roles: RoleSettings) => RoleSettings) =>
				mutate((revision) => client.setRoles(revision, change(stateRef.current?.settings.roles as RoleSettings))),
			setPolicy: (change: (policy: SubagentPolicy) => SubagentPolicy) =>
				mutate((revision) => client.setPolicy(revision, change(stateRef.current?.settings.subagents as SubagentPolicy))),
			duplicate: (modelId: string) => run(() => client.duplicateModel(modelId)),
			discover: (connectionId: string) => run((revision) => client.discover(revision, connectionId)),
			testConnection: (connectionId: string) => run((revision) => client.testConnection(revision, connectionId)),
			testModel: (pick: ModelPick) => run((revision) => client.testModel(revision, pick)),
			detect: (pick: ModelPick) => run((revision) => client.detect(revision, pick)),
			preview: (pick: ModelPick) => run((revision) => client.preview(revision, pick)),
		}),
		[state, mutate, remove, run],
	)
}

export type ModelsStore = ReturnType<typeof useModelsStore>
