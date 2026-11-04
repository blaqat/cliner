import type { Connection, ModelRow } from "@shared/model-settings"
import { useEffect, useMemo, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { ActionButton, Icon, LinkButton, SmallButton, Why } from "./fields"
import type { DiscoveredModel, DiscoveryResult } from "./modelSettingsClient"
import { useModelsPage } from "./modelsPageContext"
import { newModelRow, parseModelIds } from "./modelsView"

/** A long /models scrolls the page, not a box of its own: one scrollbar per pane. The filter is the fast way through. */
const PAGE_SIZE = 40

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

/**
 * Adds to a connection that already has its URL and key: tick from /models, or enter a list of IDs.
 * `extraModels` is a provider's maintained catalog, which counts as a list even when /models doesn't exist.
 */
export const AddModelsPanel = ({
	connection,
	extraModels,
	onClose,
}: {
	connection: Connection
	extraModels?: DiscoveredModel[]
	onClose: () => void
}) => {
	const { store, setOpenModel } = useModelsPage()
	const [discovery, setDiscovery] = useState<{ result?: DiscoveryResult; error?: string; loading: boolean }>({ loading: true })
	const [query, setQuery] = useState("")
	const [ticks, setTicks] = useState<Record<string, boolean>>({})
	const [pasted, setPasted] = useState<string[]>([])
	const [error, setError] = useState<string>()
	const [showAll, setShowAll] = useState(false)
	const [adding, setAdding] = useState(false)
	const inputRef = useRef<HTMLTextAreaElement>(null)

	const load = async () => {
		setDiscovery({ loading: true })
		const outcome = await store.discover(connection.id)
		// No list is normal for a gateway: the box takes IDs either way, so a failure here isn't worth a word.
		setDiscovery(outcome.ok ? { result: outcome.value, loading: false } : { loading: false })
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
	}

	// With nothing left to filter, what's entered is the IDs, so there's no step between entering them and adding them.
	const entered = rows.length ? [] : parseModelIds(query)
	const already = entered.filter(isAdded)
	const toAdd = [...new Set([...ticked, ...entered.filter((id) => !isAdded(id))])]

	const add = async () => {
		if (!toAdd.length) {
			return
		}
		setAdding(true)
		setError(undefined)
		const added: ModelRow[] = toAdd.map((id) => {
			const known = listed.get(id)
			return newModelRow(connection.id, id, known?.name ?? "", known?.classification === "chat" ? "chat" : "unknown")
		})
		// Roles stay as they are: the first model added doesn't become Chat or Background text.
		const saved = await store.saveModels(added)
		setAdding(false)
		if (!saved.ok) {
			setError(saved.message)
			return
		}
		setOpenModel(null)
		onClose()
	}

	return (
		<div className="mb-2 rounded-md border border-editor-group-border p-2.5" data-testid="add-models">
			<textarea
				aria-label="Model IDs"
				autoComplete="off"
				className="block min-h-[46px] w-full resize-none rounded-xs border border-input-foreground/20 bg-input-background px-2 py-1 font-mono text-[12px] leading-[18px] text-input-foreground shadow-sm [field-sizing:content] placeholder:text-input-placeholder focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border"
				onChange={(event) => setQuery(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && !event.shiftKey) {
						event.preventDefault()
						if (listed.size && query.trim()) {
							applyIds(query)
						} else {
							void add()
						}
					}
				}}
				onPaste={(event) => {
					// With no list, a pasted list stays in the box, where it can be read and edited.
					const text = event.clipboardData.getData("text")
					if (listed.size && /[\s,]/.test(text.trim())) {
						event.preventDefault()
						applyIds(text)
					}
				}}
				placeholder={listed.size ? "Filter, or enter model IDs" : "Model IDs, one per line or separated by commas"}
				ref={inputRef}
				rows={2}
				spellCheck={false}
				value={query}
			/>
			{shown.length > 0 && (
				<div className="mt-2 rounded-xs border border-editor-group-border py-0.5" data-testid="add-models-list">
					{shown.map((id) => {
						const added = isAdded(id)
						const on = added || !!ticks[id]
						return (
							<button
								aria-checked={on}
								className={cn(
									"m-0 flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-2 py-1 text-left text-[12px] text-foreground hover:bg-list-hover disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent",
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
									{on && <Icon className="text-[12px]!" name="check" />}
								</span>
								<span className="min-w-0 flex-1 truncate font-mono">{id}</span>
							</button>
						)
					})}
					{!showAll && !filter && rows.length > PAGE_SIZE && (
						<div className="px-2 py-1">
							<LinkButton onClick={() => setShowAll(true)}>Show all {rows.length}</LinkButton>
						</div>
					)}
				</div>
			)}
			{already.length > 0 && (
				<Why>
					{already.length === 1 ? `${already[0]} is already added.` : `${already.length} of these are already added.`}
				</Why>
			)}
			{error && <Why tone="bad">{error}</Why>}
			<div className="mt-2 flex flex-wrap items-center gap-2">
				<SmallButton disabled={adding || !toAdd.length} onClick={() => void add()} primary>
					{adding ? "Adding…" : toAdd.length > 1 ? `Add ${plural(toAdd.length, "model")}` : "Add model"}
				</SmallButton>
				{free.length > 1 && (
					<ActionButton
						onClick={() => {
							const on = !free.every((id) => ticks[id])
							setTicks((current) => ({ ...current, ...Object.fromEntries(free.map((id) => [id, on])) }))
						}}>
						{free.every((id) => ticks[id]) ? "Untick all" : "Tick all"}
					</ActionButton>
				)}
				<ActionButton onClick={onClose}>Cancel</ActionButton>
			</div>
		</div>
	)
}
