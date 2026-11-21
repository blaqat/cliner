import { EmptyRequest } from "@shared/proto/cline/common"
import { useEffect, useRef, useState } from "react"
import { useReducedMotionPreference } from "@/hooks/useReducedMotionPreference"
import { cn } from "@/lib/utils"
import { SkillsetServiceClient } from "@/services/grpc-client"
import { EatingLogo } from "./EatingLogo"
import { SkillsetToasts } from "./SkillsetToasts"
import { importDroppedFile, importDroppedUri, parseImportResult, playSkillsetImport } from "./skillsetImport"
import { getSkillsetState, setEatPhase, useSkillsetState, visibleLogoAnchor } from "./skillsetStore"

const ZIP_TYPES = ["application/zip", "application/x-zip-compressed", "application/x-zip"]
const EXPLORER_TYPES = ["application/vnd.code.uri-list", "resourceurls"]

/** During a drag only types are readable: an OS file reads as a zip, an Explorer drag only as "some files". */
export function dragKind(dataTransfer: DataTransfer | null): "zip" | "explorer" | undefined {
	if (!dataTransfer) return undefined
	const types = Array.from(dataTransfer.types ?? [])
	if (types.includes("Files")) {
		const items = Array.from(dataTransfer.items ?? [])
		if (items.some((item) => item.kind === "file" && ZIP_TYPES.includes(item.type))) return "zip"
		return undefined
	}
	return types.some((type) => EXPLORER_TYPES.includes(type)) ? "explorer" : undefined
}

/** Zip URIs in an Explorer drop. */
export function droppedZipUris(dataTransfer: DataTransfer): string[] {
	let uris: string[] = []
	const resourceUrls = dataTransfer.getData("resourceurls")
	if (resourceUrls) {
		try {
			uris = (JSON.parse(resourceUrls) as string[]).map((uri) => decodeURIComponent(uri))
		} catch {
			uris = []
		}
	}
	if (!uris.length) {
		uris = dataTransfer
			.getData("application/vnd.code.uri-list")
			.split("\n")
			.map((uri) => uri.trim())
	}
	return uris.filter((uri) => uri && /\.zip$/i.test(uri) && /^(file|vscode-file|vscode-remote):/.test(uri))
}

/**
 * Skillsets dropped anywhere on the panel (hold Shift: VS Code passes drops to
 * a webview only then). Listens on the window in the capture phase, so a zip
 * never reaches the composer's "unsupported file" check. While a zip is over
 * the panel a veil dims it and the Cline logo opens its jaw: on home and new
 * chat it sits right on the real logo; in a thread, where none is on screen,
 * it rises into the veil. Then it chews, sparkles, and a toast says what came.
 */
export function SkillsetDropLayer() {
	const phase = useSkillsetState((state) => state.phase)
	const still = useReducedMotionPreference()
	const stillRef = useRef(still)
	stillRef.current = still
	const leaveTimer = useRef<ReturnType<typeof setTimeout>>()
	const [anchor, setAnchor] = useState<DOMRect>()

	useEffect(() => {
		const endHover = () => {
			if (getSkillsetState().phase === "over") setEatPhase("idle")
		}
		const onDragOver = (event: DragEvent) => {
			const kind = dragKind(event.dataTransfer)
			if (!kind) return
			// An Explorer drag might be paths for the composer: accept it everywhere (so a zip can land
			// anywhere) but leave it to the composer; its name is only readable on drop.
			if (kind === "explorer") {
				event.preventDefault()
				return
			}
			event.preventDefault()
			event.stopPropagation()
			if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"
			const current = getSkillsetState().phase
			if (current === "idle" || current === "over") {
				if (current === "idle") setAnchor(visibleLogoAnchor())
				setEatPhase("over")
			}
			// dragover repeats while the pointer is over the panel; when it stops, the drag left.
			clearTimeout(leaveTimer.current)
			leaveTimer.current = setTimeout(endHover, 220)
		}
		const onDragEnter = (event: DragEvent) => {
			if (dragKind(event.dataTransfer) !== "zip") return
			event.preventDefault()
			event.stopPropagation()
		}
		const onDragLeave = (event: DragEvent) => {
			if (dragKind(event.dataTransfer) !== "zip") return
			event.stopPropagation()
			if (!event.relatedTarget) {
				clearTimeout(leaveTimer.current)
				leaveTimer.current = setTimeout(endHover, 60)
			}
		}
		const onDrop = (event: DragEvent) => {
			const dataTransfer = event.dataTransfer
			if (!dataTransfer) return
			clearTimeout(leaveTimer.current)
			const files = Array.from(dataTransfer.files ?? [])
			const zip = files.find((file) => /\.zip$/i.test(file.name) || ZIP_TYPES.includes(file.type))
			if (zip) {
				event.preventDefault()
				event.stopPropagation()
				if (getSkillsetState().phase === "idle") setAnchor(visibleLogoAnchor())
				void importDroppedFile(zip, stillRef.current)
				return
			}
			const uri = files.length ? undefined : droppedZipUris(dataTransfer)[0]
			if (uri) {
				event.preventDefault()
				event.stopPropagation()
				setAnchor(visibleLogoAnchor())
				void importDroppedUri(uri, stillRef.current)
				return
			}
			if (getSkillsetState().phase === "over") setEatPhase("idle")
			// Not a skillset and not over the composer: nothing takes it (as before), and nothing opens.
			if (!(event.target instanceof Element && event.target.closest('[data-testid="composer-card"]')))
				event.preventDefault()
		}
		window.addEventListener("dragenter", onDragEnter, true)
		window.addEventListener("dragover", onDragOver, true)
		window.addEventListener("dragleave", onDragLeave, true)
		window.addEventListener("drop", onDrop, true)
		return () => {
			clearTimeout(leaveTimer.current)
			window.removeEventListener("dragenter", onDragEnter, true)
			window.removeEventListener("dragover", onDragOver, true)
			window.removeEventListener("dragleave", onDragLeave, true)
			window.removeEventListener("drop", onDrop, true)
		}
	}, [])

	// Added from the command palette (Cline: Add skillset…): the same moment, minus the chewing.
	useEffect(() => {
		const cancel = SkillsetServiceClient.subscribeToSkillsetImports(EmptyRequest.create(), {
			onResponse: (response) => {
				setAnchor(visibleLogoAnchor())
				void playSkillsetImport(Promise.resolve(parseImportResult(response.json)), {
					still: stillRef.current,
					chew: false,
				})
			},
			onError: (error) => console.error("Skillset import subscription failed:", error),
			onComplete: () => {},
		})
		return cancel
	}, [])

	const active = phase !== "idle"
	const size = anchor ? Math.max(48, Math.round(anchor.width)) : 76
	const label =
		phase === "over"
			? "Drop to add skills"
			: phase === "eating"
				? "Adding…"
				: phase === "spark"
					? "Unlocked"
					: phase === "shake"
						? "That's not a skillset"
						: ""

	return (
		<>
			{active && (
				<div
					aria-live="polite"
					className={cn(
						"skillset-veil pointer-events-none fixed inset-0 z-[60] bg-[color-mix(in_srgb,var(--vscode-sideBar-background,var(--vscode-editor-background))_92%,transparent)]",
						still && "is-still",
					)}
					data-phase={phase}
					data-testid="skillset-veil">
					<div className="absolute inset-1.5 rounded-md border-2 border-dashed border-(--vscode-focusBorder) opacity-70" />
					<div
						className="absolute flex flex-col items-center text-center"
						style={
							anchor
								? { left: anchor.left + anchor.width / 2, top: anchor.top, transform: "translateX(-50%)" }
								: { left: "50%", top: "32%", transform: "translateX(-50%)" }
						}>
						<div className={cn(!anchor && "skillset-veil-logo")} style={{ width: size, height: size }}>
							<EatingLogo
								className={cn(
									"size-full",
									still &&
										phase === "over" &&
										"rounded-full outline-2 outline-dashed outline-offset-4 outline-(--vscode-focusBorder)",
								)}
								phase={phase}
								still={still}
							/>
						</div>
						<div className="mt-2 w-max max-w-[calc(100vw-32px)] rounded-full bg-(--vscode-sideBar-background,var(--vscode-editor-background)) px-3 py-1 text-[13px] font-semibold text-foreground shadow-[0_0_0_6px_var(--vscode-sideBar-background,var(--vscode-editor-background))]">
							{label}
						</div>
						{phase === "over" && (
							<div className="w-max max-w-[calc(100vw-32px)] bg-(--vscode-sideBar-background,var(--vscode-editor-background)) px-2 text-[11px] text-description">
								Skillsets are .zip files of skills and workflows
							</div>
						)}
					</div>
				</div>
			)}
			<SkillsetToasts />
		</>
	)
}
