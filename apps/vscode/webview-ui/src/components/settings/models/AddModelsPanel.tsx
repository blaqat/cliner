import type { Connection, ModelRow } from "@shared/model-settings"
import { useEffect, useMemo, useRef, useState } from "react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { Hint, Icon, LinkButton, SmallButton, Why } from "./fields"
import { useModelsPage } from "./modelsPageContext"
import type { DiscoveredModel, DiscoveryResult } from "./modelSettingsClient"
import { connectionName, detectedFills, hostOf, newModelRow, parseModelIds, testPick } from "./modelsView"
import { SharedDefaults } from "./SharedDefaults"

/** A long /models scrolls the page, not a box of its own: one scrollbar per pane. The filter is the fast way through. */
const PAGE_SIZE = 40

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

/**
 * Adds to a connection that already has its URL and key: tick from /models, or paste a list of IDs.
 * `extraModels` is a provider's maintained catalog, which counts as a list even when /models doesn't exist.
 */
export const AddModelsPanel = ({
	connection,
	extraModels,
	onClose,
	showShared = true,
}: {
	connection: Connection
	extraModels?: DiscoveredModel[]
	onClose: () => void
	showShared?: boolean
}) => {
	const { store, setNote, setEditingConnection, setOpenModel } = useModelsPage()
	const [discovery, setDiscovery] = useState<{ result?: DiscoveryResult; error?: string; loading: boolean }>({ loading: true })
	const [query, setQuery] = useState("")
	const [ticks, setTicks] = useState<Record<string, boolean>>({})
	const [pasted, setPasted] = useState<string[]>([])
	const [status, setStatus] = useState<string>()
	const [error, setError] = useState<string>()
	const [showAll, setShowAll] = useState(false)
	const [adding, setAdding] = useState(false)
	const inputRef = useRef<HTMLInputElement>(null)
	const name = connectionName(connection)

	const load = async () => {
		setDiscovery({ loading: true })
		const outcome = await store.discover(connection.id)
		setDiscovery(outcome.ok ? { result: outcome.value, loading: false } : { error: outcome.message, loading: false })
	}
	// biome-ignore lint/correctness/useExhaustiveDependencies: lists once per open, not on every store change.
	useEffect(() => {
		void load()
		inputRef.current?.focus({ preventScroll: true })
	}, [connection.id])

	const listed = useMemo(() => {
		const byId = new Map<string, DiscoveredModel>()
		for (const model of [...(discovery.result?.models ?? []), ...(extraModels ?? [])]) {
			// A positively non-chat entry never shows, whichever list it came from.
			if (model.classification !== "non-chat" && !byId.has(model.upstreamId)) {
				byId.set(model.upstreamId, model)
			}
		}
		return byId
	}, [discovery.result, extraModels])

	const existing = store.state?.settings.models.filter((row) => row.connectionId === connection.id) ?? []
	const isAdded = (id: string) => existing.some((row) => row.upstreamId === id)
	const allIds = [...new Set([...listed.keys(), ...pasted])]
	const filter = query.trim().toLowerCase()
	const rows = allIds.filter((id) => !filter || id.toLowerCase().includes(filter))
	const shown = showAll || filter ? rows : rows.slice(0, PAGE_SIZE)
	const free = allIds.filter((id) => !isAdded(id))
	const ticked = free.filter((id) => ticks[id])

	const applyIds = (text: string) => {
		const ids = parseModelIds(text)
		if (!ids.length) {
			return
		}
		const offList = ids.filter((id) => !listed.has(id))
		setPasted((current) => [...new Set([...current, ...offList])])
		setTicks((current) => {
			const next = { ...current }
			for (const id of ids) {
				if (!isAdded(id)) {
					next[id] = true
				}
			}
			return next
		})
		setQuery("")
		const hasList = listed.size > 0
		setStatus(
			ids.length > 1 || (hasList && offList.length)
				? `Pasted ${plural(ids.length, "ID")}.${hasList && offList.length ? ` ${offList.length} ${offList.length === 1 ? "isn't" : "aren't"} on /models; Cline will still send ${offList.length === 1 ? "it" : "them"}.` : ""}`
				: undefined,
		)
	}

	const add = async () => {
		if (!ticked.length) {
			setStatus("Tick a model first, or paste some IDs.")
			return
		}
		setAdding(true)
		setError(undefined)
		const added: ModelRow[] = ticked.map((id) => {
			const known = listed.get(id)
			return newModelRow(connection.id, id, known?.name ?? "", known?.classification === "chat" ? "chat" : "unknown")
		})
		// Roles stay as they are: the first model added doesn't become Chat or Background text.
		const saved = await store.saveModels(added)
		if (!saved.ok) {
			setAdding(false)
			setError(saved.message)
			return
		}
		// Detect runs once per model at this revision, then one save holds what it found.
		const fills: ModelRow[] = []
		await Promise.all(
			added.map(async (row) => {
				const state = store.latest()
				const detected = await store.detect(testPick(row, state?.effective[row.id]))
				if (!detected.ok) {
					return
				}
				const found = detectedFills(row, state?.effective[row.id], detected.value.metadata ?? {})
				if (Object.keys(found).length) {
					fills.push({ ...row, overrides: { ...row.overrides, ...found } })
				}
			}),
		)
		if (fills.length) {
			await store.saveModels(fills)
		}
		setAdding(false)
		setNote(connection.id, `Added ${plural(added.length, "model")}.`)
		setOpenModel(null)
		onClose()
	}

	const result = discovery.result
	const host = hostOf(connection.baseUrl)
	const why = discovery.loading ? (
		<Hint>Asking {host} what it has…</Hint>
	) : discovery.error ? (
		<Why tone="bad">
			{discovery.error} <LinkButton onClick={load}>Try again</LinkButton>
		</Why>
	) : result?.status === "auth" ? (
		<Why tone="warn">
			{host} turned the key down, so there's no list.{" "}
			<LinkButton onClick={() => setEditingConnection(connection.id, true)}>Check the key</LinkButton>, or type or paste
			IDs.
		</Why>
	) : result?.status === "network" ? (
		<Why tone="warn">
			Can't reach {host}, so there's no list. Type or paste IDs, or <LinkButton onClick={load}>try again</LinkButton>.
		</Why>
	) : result?.status === "no-list" && !listed.size ? (
		<Hint>This connection has no /models, so type or paste IDs.</Hint>
	) : null

	return (
		<div className="mt-1.5 rounded-[5px] border border-editor-group-border px-2 py-1.5" data-testid="add-models">
			<div className="mb-1 text-[12px] font-medium">Add to {name}</div>
			<Input
				aria-label={listed.size ? "Filter /models, or paste IDs" : "Type or paste model IDs"}
				autoComplete="off"
				className="h-6 rounded-xs px-[7px] py-0 font-mono text-[11px] md:text-[11px]"
				onChange={(event) => setQuery(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault()
						applyIds(query)
					}
				}}
				onPaste={(event) => {
					const text = event.clipboardData.getData("text")
					if (/[\s,]/.test(text.trim())) {
						event.preventDefault()
						applyIds(text)
					}
				}}
				placeholder={listed.size ? "Filter /models, or paste IDs" : "Type or paste model IDs"}
				ref={inputRef}
				spellCheck={false}
				value={query}
			/>
			{why}
			{(rows.length > 0 || (filter && !rows.length)) && (
				<div className="mt-1.5 rounded-xs border border-editor-group-border py-0.5" data-testid="add-models-list">
					{shown.map((id) => {
						const known = listed.get(id)
						const added = isAdded(id)
						const on = added || !!ticks[id]
						return (
							<button
								aria-checked={on}
								className={cn(
									"flex w-full cursor-pointer items-center gap-1.5 border-0 bg-transparent px-1.5 py-[3px] text-left text-[11px] outline-none hover:bg-list-hover focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-(--vscode-focusBorder) disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent",
								)}
								disabled={added}
								key={id}
								onClick={() => setTicks((current) => ({ ...current, [id]: !current[id] }))}
								role="checkbox"
								type="button">
								<span
									className={cn(
										"grid size-3.5 shrink-0 place-items-center rounded-[3px] border border-solid border-editor-group-border",
										on && "border-button-background bg-button-background text-button-foreground",
									)}>
									{on && <Icon className="text-[11px]!" name="check" />}
								</span>
								<span className="min-w-0 flex-1 truncate font-mono">{id}</span>
								{added ? (
									<span className="shrink-0 text-[10.5px] text-description">added</span>
								) : !known && listed.size > 0 ? (
									<span className="shrink-0 text-[10.5px] text-description">not on /models</span>
								) : known && known.name !== id && known.name ? (
									<span className="shrink-0 truncate text-[10.5px] text-description">{known.name}</span>
								) : null}
							</button>
						)
					})}
					{filter && !rows.length && (
						<button
							className="flex w-full cursor-pointer items-center gap-1.5 border-0 bg-transparent px-1.5 py-[3px] text-left font-mono text-[11px] hover:bg-list-hover"
							onClick={() => applyIds(query)}
							type="button">
							<Icon className="text-[11px]!" name="add" />
							Add “{query.trim()}” by ID
						</button>
					)}
					{!showAll && !filter && rows.length > PAGE_SIZE && (
						<div className="px-1.5 py-[3px]">
							<LinkButton onClick={() => setShowAll(true)}>Show all {rows.length}</LinkButton>
						</div>
					)}
				</div>
			)}
			{status && (
				<div className="mt-1 text-[11px] text-description" role="status">
					{status}
				</div>
			)}
			<Hint>
				{showShared
					? "New models start from this connection's shared defaults, then Detect fills in what the server reports."
					: "Detect fills in what the server reports. The rest stays unknown until you set it."}
			</Hint>
			{showShared && <SharedDefaults connection={connection} />}
			{error && <Why tone="bad">{error}</Why>}
			<div className="mt-1.5 flex flex-wrap items-center gap-2">
				<SmallButton disabled={adding} onClick={add} primary={ticked.length > 0}>
					{adding ? "Adding…" : ticked.length ? `Add ${plural(ticked.length, "model")}` : "Tick a model to add"}
				</SmallButton>
				{free.length > 1 && (
					<LinkButton
						onClick={() => {
							const on = !free.every((id) => ticks[id])
							setTicks((current) => ({ ...current, ...Object.fromEntries(free.map((id) => [id, on])) }))
						}}>
						{free.every((id) => ticks[id]) ? "Clear" : "Tick all"}
					</LinkButton>
				)}
				<LinkButton onClick={onClose}>Cancel</LinkButton>
			</div>
		</div>
	)
}
