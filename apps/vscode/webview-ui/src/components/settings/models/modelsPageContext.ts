import type { Connection, ModelRow } from "@shared/model-settings"
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import { useSettingsShell } from "../shell/SettingsShellContext"
import type { SecretMutation } from "./modelSettingsClient"
import { hostOf, isValidUrl } from "./modelsView"
import { type ModelsStore, useModelsStore } from "./useModelsStore"

export const createDraftConnection = (id: string): Connection => ({
	id,
	name: "",
	kind: "openai-compatible",
	baseUrl: null,
	auth: { kind: "keychain", secretRef: `settings:v1:connection:${id}:apiKey` },
	headers: [],
	requestTimeoutMs: null,
	defaults: {},
	apiFormat: "chat",
	azureApiVersion: null,
})

type Toggle = Record<string, boolean>

/** What's open on the page, and everything not saved yet. None of it is a setting. */
export const useModelsPageState = () => {
	const store = useModelsStore()
	const { ctx } = useSettingsShell()
	const [openConnection, setOpenConnection] = useState<string | null>(null)
	const [openModel, setOpenModel] = useState<string | null>(null)
	const [editing, setEditing] = useState<Toggle>({})
	const [adding, setAdding] = useState<Toggle>({})
	const [more, setMore] = useState<Toggle>({})
	const [drafts, setDrafts] = useState<Connection[]>([])
	const draftSecrets = useRef<Record<string, SecretMutation[]>>({})
	const [draftModels, setDraftModels] = useState<ModelRow[]>([])
	const [focusId, setFocusId] = useState<string>()

	const settings = store.state?.settings
	const hasNothing = !!settings && settings.connections.length === 0

	// First visit opens straight on the form: there's nothing else to do here until a connection exists.
	const seeded = useRef(false)
	useEffect(() => {
		if (seeded.current || !hasNothing) {
			return
		}
		seeded.current = true
		const id = crypto.randomUUID()
		setDrafts((current) => (current.length ? current : [createDraftConnection(id)]))
		setOpenConnection(id)
	}, [hasNothing])

	const first = settings?.connections[0]?.id
	const opened = useRef(false)
	useEffect(() => {
		if (!opened.current && first) {
			opened.current = true
			setOpenConnection((current) => current ?? first)
		}
	}, [first])

	const addDraft = useCallback(() => {
		const id = crypto.randomUUID()
		setDrafts((current) => [...current, createDraftConnection(id)])
		setOpenConnection(id)
		setOpenModel(null)
	}, [])

	const updateDraft = useCallback((id: string, change: Partial<Connection>, secrets?: SecretMutation[]) => {
		setDrafts((current) => current.map((draft) => (draft.id === id ? ({ ...draft, ...change } as Connection) : draft)))
		if (secrets?.length) {
			const kept = draftSecrets.current[id] ?? []
			draftSecrets.current[id] = [
				...kept.filter((entry) => !secrets.some((next) => next.field === entry.field)),
				...secrets,
			]
		}
	}, [])

	const dropDraft = useCallback((id: string) => {
		setDrafts((current) => current.filter((draft) => draft.id !== id))
		delete draftSecrets.current[id]
	}, [])

	/**
	 * Saves a new connection as soon as it has somewhere to go, so nothing typed is lost to a reload.
	 * It stays open on its form, with the box for adding models ready.
	 */
	const commitDraft = useCallback(
		async (draft: Connection): Promise<string | undefined> => {
			// A locked URL can't be typed: the host starts the connection on the organization's.
			const urlLocked = !!store.state?.managed.includes("openAiBaseUrl")
			if (!draft.baseUrl && !urlLocked) {
				return "Add a base URL first."
			}
			if (draft.baseUrl && !isValidUrl(draft.baseUrl)) {
				return "That isn't a URL. It starts with http:// or https://."
			}
			if (draft.auth.kind === "environment" && !draft.auth.variable) {
				return "Name the env var first."
			}
			const named = { ...draft, name: draft.name || (draft.baseUrl ? hostOf(draft.baseUrl) : "Managed connection") }
			const outcome = await store.saveConnection(named, draftSecrets.current[draft.id] ?? [])
			if (!outcome.ok) {
				return outcome.message
			}
			dropDraft(draft.id)
			setOpenConnection(draft.id)
			setEditing((current) => ({ ...current, [draft.id]: true }))
			setAdding((current) => ({ ...current, [draft.id]: true }))
			return undefined
		},
		[dropDraft, store],
	)

	const flip = useCallback(
		(set: React.Dispatch<React.SetStateAction<Toggle>>, key: string, value?: boolean) =>
			set((current) => ({ ...current, [key]: value ?? !current[key] })),
		[],
	)

	const managedKey = useCallback(
		(key: string) => {
			const remote = ctx.state.remoteConfigSettings as Record<string, unknown> | undefined
			const value = remote?.[key]
			return (value !== undefined && !(Array.isArray(value) && value.length === 0)) || !!store.state?.managed.includes(key)
		},
		[ctx.state.remoteConfigSettings, store.state?.managed],
	)

	return useMemo(
		() => ({
			store,
			openConnection,
			setOpenConnection,
			openModel,
			setOpenModel,
			isEditing: (id: string) => !!editing[id],
			setEditingConnection: (id: string, value?: boolean) => flip(setEditing, id, value),
			isAdding: (id: string) => !!adding[id],
			setAddingModels: (id: string, value?: boolean) => flip(setAdding, id, value),
			isMoreOpen: (id: string) => !!more[id],
			setMoreOpen: (id: string, value?: boolean) => flip(setMore, id, value),
			drafts,
			addDraft,
			updateDraft,
			dropDraft,
			commitDraft,
			draftModels,
			setDraftModels,
			focusId,
			setFocusId,
			managedKey,
			organization: ctx.activeOrganization?.name || "Your organization",
		}),
		[
			store,
			openConnection,
			openModel,
			editing,
			adding,
			more,
			drafts,
			addDraft,
			updateDraft,
			dropDraft,
			commitDraft,
			draftModels,
			focusId,
			managedKey,
			ctx.activeOrganization?.name,
			flip,
		],
	)
}

export type ModelsPageState = ReturnType<typeof useModelsPageState>
export type { ModelsStore }

export const ModelsPageContext = createContext<ModelsPageState | undefined>(undefined)

export const useModelsPage = () => {
	const value = useContext(ModelsPageContext)
	if (!value) {
		throw new Error("useModelsPage must be used inside ModelsPage")
	}
	return value
}
