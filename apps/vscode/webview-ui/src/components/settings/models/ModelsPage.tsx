import { useEffect, useLayoutEffect, useState } from "react"
import { SettingBlock } from "../shell/SettingRow"
import { useSettingsShell } from "../shell/SettingsShellContext"
import { ConnectionCard } from "./ConnectionCard"
import { Icon, LinkButton, Notice, Why } from "./fields"
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
				<b className="font-semibold">Nothing can run yet.</b> Add a model below. Background text needs one too, or commit
				messages have nothing to run on.
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
					Commit messages, thread titles and Generate need a Background text model.{" "}
					<LinkButton onClick={() => openRow(roleRowId.background)}>Pick one</LinkButton>
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
			<div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
				<SettingBlock rowId="models.add-connection">
					<LinkButton
						disabled={!compatibleAllowed}
						id="setting-models-add-connection-control"
						onClick={() => {
							page.addDraft()
							setChooserOpen(false)
						}}
						title={compatibleAllowed ? undefined : `${page.organization} chooses the providers here.`}>
						<Icon className="text-[12px]!" name="add" />
						Add a connection
					</LinkButton>
				</SettingBlock>
				<SettingBlock rowId="models.add-provider">
					<LinkButton
						aria-expanded={chooserOpen}
						id="setting-models-add-provider-control"
						onClick={() => setChooserOpen((open) => !open)}>
						<Icon className="text-[12px]!" name="add" />
						Add a model from another provider
					</LinkButton>
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
	const count = settings.models.length
	const showing = settings.models.filter((model) => model.enabled !== false).length
	return (
		<>
			<NothingCanRun />
			<ModelRoles />
			<SettingBlock rowId="models.connections">
				{(count > 0 || settings.connections.length > 0) && (
					<div className="mt-5 mb-2 text-[13px] font-semibold text-foreground">Set-up models</div>
				)}
				{settings.connections.map((connection) => (
					<ConnectionCard connection={connection} isDraft={false} key={connection.id} />
				))}
				{page.drafts.map((connection) => (
					<ConnectionCard connection={connection} isDraft key={connection.id} />
				))}
			</SettingBlock>
			<AddLines />
			{count > 0 && (
				<div className="mt-2.5 flex items-start gap-1.5 text-[12px] text-description">
					<Icon className="mt-px text-[12px]! opacity-70" name="chip" />
					<span>
						{showing === count
							? count === 1
								? "This model shows"
								: `All ${count} show`
							: `${showing} of ${count} show`}{" "}
						in the composer and every selector.
					</span>
				</div>
			)}
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
