import { useState } from "react"
import { useSettingsShell } from "../shell/SettingsShellContext"
import { LinkButton, SmallButton, Why } from "./fields"
import { useModelsPage } from "./modelsPageContext"
import type { DeleteResult } from "./modelSettingsClient"
import { clearRole, type DependencyLine, modelName, readDependencies, ROLE_LABELS, roleRowId } from "./modelsView"
import type { Outcome } from "./useModelsStore"

/**
 * Removing, in place and with no modal. The host decides what stands in the way; each thing it names
 * gets its own line and its own way out. Nothing is deleted until the host says nothing depends on it.
 */
export const RemoveFlow = ({
	label,
	removedName,
	question,
	onRemove,
	onRemoved,
	linkClassName,
	modelIds = [],
}: {
	label: string
	removedName: string
	question: string
	onRemove: () => Promise<Outcome<DeleteResult>>
	onRemoved: () => void
	linkClassName?: string
	/** The models this removes, to say which saved threads will ask for a new pick. */
	modelIds?: string[]
}) => {
	const { store } = useModelsPage()
	const { openRow } = useSettingsShell()
	/** Saved threads never stand in the way; undefined until the host has counted, null if it couldn't. */
	const [savedThreads, setSavedThreads] = useState<number | null>()
	const [step, setStep] = useState<"idle" | "confirm">("idle")
	const [lines, setLines] = useState<DependencyLine[]>()
	const [error, setError] = useState<string>()
	const [busy, setBusy] = useState(false)

	const attempt = async () => {
		setBusy(true)
		setError(undefined)
		const outcome = await onRemove()
		setBusy(false)
		if (!outcome.ok) {
			setError(outcome.message)
			return
		}
		if ("dependencies" in outcome.value) {
			setLines(readDependencies(outcome.value.dependencies))
			return
		}
		onRemoved()
	}

	const fix = async (work: () => Promise<Outcome<unknown>>, line: DependencyLine) => {
		setError(undefined)
		const outcome = await work()
		if (!outcome.ok) {
			setError(outcome.message)
			return
		}
		setLines((current) => current?.filter((candidate) => candidate !== line))
	}

	const open = () => {
		setStep("confirm")
		setSavedThreads(undefined)
		if (modelIds.length) {
			void store
				.savedThreadUsage(modelIds)
				.then((outcome) => setSavedThreads(outcome.ok ? outcome.value.savedThreads : null))
		}
	}

	const close = () => {
		setStep("idle")
		setLines(undefined)
		setError(undefined)
	}

	if (step === "idle") {
		return (
			<LinkButton className={linkClassName} onClick={open}>
				{label}
			</LinkButton>
		)
	}

	const models = lines?.filter((line): line is Extract<DependencyLine, { kind: "model" }> => line.kind === "model") ?? []
	const others = lines?.filter((line) => line.kind !== "model") ?? []
	const nameOf = (modelId: string) => {
		const row = store.state?.settings.models.find((model) => model.id === modelId)
		return row ? modelName(row) : modelId
	}

	const removeModels = async () => {
		setError(undefined)
		const left: DependencyLine[] = []
		for (const line of models) {
			const outcome = await store.deleteModel(line.modelId)
			if (!outcome.ok) {
				setError(outcome.message)
				left.push(line)
			} else if ("dependencies" in outcome.value) {
				left.push(line, ...readDependencies(outcome.value.dependencies))
			}
		}
		setLines(
			[...others, ...left].filter(
				(line, index, all) => all.findIndex((other) => JSON.stringify(other) === JSON.stringify(line)) === index,
			),
		)
	}

	return (
		<div
			className="mt-1.5 grid basis-full gap-1.5 rounded-xs border border-error/35 bg-error/10 px-2 py-1.5 text-[11.5px]"
			data-testid="remove-flow">
			{!lines && <span>{question}</span>}
			{!!savedThreads && (
				<span>
					{savedThreads === 1 ? "1 saved thread uses" : `${savedThreads} saved threads use`} this. They'll ask you to
					pick a model when reopened.
				</span>
			)}
			{savedThreads === null && <span>Saved threads that use this will ask you to pick a model when reopened.</span>}
			{lines && (
				<>
					<span>
						{lines.length
							? `${removedName} is still in use. Clear these, then remove it.`
							: "Nothing depends on it now."}
					</span>
					<ul className="m-0 grid list-none gap-1 p-0" data-testid="remove-dependencies">
						{models.length > 0 && (
							<li className="flex flex-wrap items-center gap-x-2">
								<span className="min-w-0">
									{models.length === 1
										? `Its model ${nameOf(models[0].modelId)}`
										: `Its ${models.length} models`}{" "}
									have to go first.
								</span>
								<LinkButton onClick={removeModels}>
									{models.length === 1 ? "Remove it" : "Remove them"}
								</LinkButton>
							</li>
						)}
						{others.map((line, index) => (
							<li className="flex flex-wrap items-center gap-x-2" key={`${line.kind}-${index}`}>
								{line.kind === "role" && (
									<>
										<span className="min-w-0">{ROLE_LABELS[line.role]} uses it.</span>
										<LinkButton onClick={() => openRow(roleRowId[line.role])}>Pick another</LinkButton>
										<LinkButton
											onClick={() =>
												fix(() => store.setRoles((roles) => clearRole(roles, line.role)), line)
											}>
											Clear it
										</LinkButton>
									</>
								)}
								{line.kind === "allowed" && (
									<>
										<span className="min-w-0">It's on the list of models subagents can choose.</span>
										<LinkButton onClick={() => openRow("subagents")}>Open Subagents</LinkButton>
										<LinkButton
											onClick={() =>
												fix(
													() =>
														store.setPolicy((policy) => ({
															...policy,
															allowed: policy.allowed.filter(
																(_, position) => position !== line.index,
															),
														})),
													line,
												)
											}>
											Take it off the list
										</LinkButton>
									</>
								)}
								{line.kind === "other" && <span className="min-w-0 font-mono text-[11px]">{line.path}</span>}
							</li>
						))}
					</ul>
				</>
			)}
			{error && <Why tone="bad">{error}</Why>}
			<div className="flex flex-wrap items-center gap-1.5">
				<SmallButton danger disabled={busy} onClick={attempt}>
					{lines ? "Try removing again" : "Remove"}
				</SmallButton>
				<SmallButton onClick={close}>Cancel</SmallButton>
			</div>
		</div>
	)
}
