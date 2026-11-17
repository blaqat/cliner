import { useEffect, useLayoutEffect, useState } from "react"
import { cn } from "@/lib/utils"
import { SETTING_GROUP_TITLE_CLASS, SettingBlock } from "../shell/SettingRow"
import { useSettingsShell } from "../shell/SettingsShellContext"
import { ConnectionCard } from "./ConnectionCard"
import { ActionButton, LinkButton, Notice, Why } from "./fields"
import { ModelRoles } from "./ModelRoles"
import { ModelsPageContext, useModelsPage, useModelsPageState } from "./modelsPageContext"
import { isMoreField, roleRowId } from "./modelsView"
import { ProviderChooser } from "./ProviderChooser"

const NothingCanRun = () => {
	const { store } = useModelsPage()
	const { openRow } = useSettingsShell()
	const settings = store.state?.settings
	if (!settings) {
		return null
	}
	if (!settings.models.length) {
		return (
			<Notice tone="warn">
				<b className="font-semibold">Nothing can run yet.</b>{" "}
				{settings.connections.length ? "Add a model below." : "Add a connection below."}
			</Notice>
		)
	}
	const missing = [!settings.roles.chat && "Chat", !settings.roles.background.pick && "Background text"].filter(Boolean)
	if (!missing.length) {
		return null
	}
	return (
		<Notice tone="warn">
			{!settings.roles.chat && (
				<div>
					<b className="font-semibold">Nothing can run yet.</b> Threads need a Chat model.{" "}
					<LinkButton onClick={() => openRow(roleRowId.chat)}>Pick one</LinkButton>
				</div>
			)}
			{!settings.roles.background.pick && (
				<div>
					Background text needs a model. <LinkButton onClick={() => openRow(roleRowId.background)}>Pick one</LinkButton>
				</div>
			)}
		</Notice>
	)
}

const AddLines = () => {
	const page = useModelsPage()
	const [chooserOpen, setChooserOpen] = useState(false)
	const compatibleAllowed = !page.managedKey("remoteConfiguredProviders")
	return (
		<>
			<div className="mt-3 flex flex-wrap gap-2">
				<SettingBlock rowId="models.add-connection">
					<ActionButton
						disabled={!compatibleAllowed}
						icon="add"
						id="setting-models-add-connection-control"
						onClick={() => {
							page.addDraft()
							setChooserOpen(false)
						}}
						title={compatibleAllowed ? undefined : `${page.organization} chooses the providers here.`}>
						Add connection
					</ActionButton>
				</SettingBlock>
				<SettingBlock rowId="models.add-provider">
					<ActionButton
						aria-expanded={chooserOpen}
						icon="add"
						id="setting-models-add-provider-control"
						onClick={() => setChooserOpen((open) => !open)}>
						Add provider
					</ActionButton>
				</SettingBlock>
			</div>
			{!compatibleAllowed && <Why>{page.organization} chooses the providers here, so a new connection may be refused.</Why>}
			{chooserOpen && (
				<ProviderChooser
					onAddConnection={() => {
						page.addDraft()
						setChooserOpen(false)
					}}
					onClose={() => setChooserOpen(false)}
				/>
			)}
		</>
	)
}

/** Fix links land on real controls: this opens whatever the target needs before the shell looks for the anchor. */
const useNavigationTargets = () => {
	const page = useModelsPage()
	const { navigationTarget } = useSettingsShell()
	const settings = page.store.state?.settings
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs once per navigation request.
	useLayoutEffect(() => {
		const target = navigationTarget?.target
		if (!target || !settings) {
			return
		}
		const [kind, id, field] = target.split(":")
		if (kind === "connection") {
			page.setOpenConnection(id)
			page.setOpenModel(null)
			page.setEditingConnection(id, true)
		} else if (kind === "model") {
			const row = [...settings.models, ...page.draftModels].find((model) => model.id === id)
			if (row) {
				page.setOpenConnection(row.connectionId)
				page.setOpenModel(row.id)
				if (isMoreField(field)) {
					page.setMoreOpen(row.id, true)
				}
			}
		}
	}, [navigationTarget?.requestId])
}

const ModelsList = () => {
	const page = useModelsPage()
	const settings = page.store.state?.settings
	useNavigationTargets()

	// A fresh duplicate lands on its empty ID box.
	useEffect(() => {
		if (page.focusId) {
			document.getElementById(page.focusId)?.focus({ preventScroll: true })
			page.setFocusId(undefined)
		}
	}, [page.focusId, page.setFocusId])

	if (!settings) {
		return <Why>The model settings aren't ready. Reopen Settings to try again.</Why>
	}
	const saved = settings.connections.map((connection) => ({ connection, isDraft: false }))
	// One keyed list: a new connection saved mid-form stays the same card, so what's being typed isn't lost.
	const unsaved = page.drafts
		.filter((draft) => !settings.connections.some((connection) => connection.id === draft.id))
		.map((connection) => ({ connection, isDraft: true }))
	const cards = [...saved, ...unsaved]
	return (
		<>
			<NothingCanRun />
			<ModelRoles />
			<SettingBlock rowId="models.connections">
				{cards.length > 0 && <h3 className={cn(SETTING_GROUP_TITLE_CLASS, "mt-5")}>Connections</h3>}
				{cards.map(({ connection, isDraft }) => (
					<ConnectionCard connection={connection} isDraft={isDraft} key={connection.id} />
				))}
			</SettingBlock>
			<AddLines />
		</>
	)
}

/** The setup page: what does each job, then every model set up, under where it runs. */
export const ModelsPage = () => {
	const value = useModelsPageState()
	return (
		<ModelsPageContext.Provider value={value}>
			<ModelsList />
		</ModelsPageContext.Provider>
	)
}
