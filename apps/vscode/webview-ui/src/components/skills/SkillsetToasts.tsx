import type { SkillsetImportResult } from "@shared/skillsets"
import { useState } from "react"
import { HeaderIconButton } from "@/components/chat/task-header/HeaderIconButton"
import { LinkButton } from "@/components/common/LinkButton"
import { useToastCountdown } from "@/components/toasts/ThreadToasts"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useReducedMotionPreference } from "@/hooks/useReducedMotionPreference"
import { cn } from "@/lib/utils"
import { EatingLogo } from "./EatingLogo"
import { dismissSkillsetToast, openSkills, type SkillsetToast, useSkillsetState } from "./skillsetStore"

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`

/** The toast's two lines and its action, from what an import did. */
export function skillsetToastCopy(result: SkillsetImportResult): {
	title: string
	detail: string
	action?: string
	tone: "added" | "nothing" | "error"
} {
	const setName = result.set?.name ?? result.fileName.replace(/\.skillset\.zip$|\.zip$/i, "")
	if (result.error) {
		return {
			title: result.fileName ? `No skills in ${result.fileName}` : "Couldn't add that skillset",
			detail: result.error,
			action: "What's a skillset?",
			tone: "error",
		}
	}
	if (!result.set) {
		return {
			title: `Nothing new in ${setName}`,
			detail: `You already had ${result.alreadyHad === 1 ? "it" : `all ${result.alreadyHad}`}.`,
			tone: "nothing",
		}
	}
	const title = result.skills
		? `${plural(result.skills, "new skill")} unlocked`
		: `${plural(result.workflows, "new workflow")} unlocked`
	const extras = [
		result.skills && result.workflows ? `+${plural(result.workflows, "workflow")}` : "",
		`from ${setName}`,
		result.alreadyHad ? `already had ${result.alreadyHad}` : "",
	].filter(Boolean)
	return { title, detail: extras.join(" · "), action: "View", tone: "added" }
}

function SkillsetToastCard({ toast, windowFocused }: { toast: SkillsetToast; windowFocused: boolean }) {
	const still = useReducedMotionPreference()
	const [hovered, setHovered] = useState(false)
	const copy = skillsetToastCopy(toast.result)
	const durationMs = copy.tone === "added" ? 8000 : 10000
	const running = windowFocused && !hovered
	const close = () => dismissSkillsetToast(toast.id)
	useToastCountdown(durationMs, running, close)
	const act = () => {
		close()
		openSkills({ tab: "skills", setId: toast.result.set?.id })
	}
	return (
		<div
			className="pointer-events-auto overflow-hidden rounded-md border border-(--vscode-notifications-border,var(--vscode-editorWidget-border)) bg-(--vscode-notifications-background,var(--vscode-editorWidget-background)) text-(--vscode-notifications-foreground,var(--vscode-foreground)) shadow-[0_6px_18px_var(--vscode-widget-shadow)] animate-[toast-in_0.15s_ease-out] motion-reduce:animate-none"
			data-testid="skillset-toast"
			data-tone={copy.tone}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			role="status">
			<div className="flex items-start gap-2 py-2 pr-1.5 pl-2.5">
				{copy.tone === "error" ? (
					<span aria-hidden className="codicon codicon-warning shrink-0 text-[14px] text-warning" />
				) : (
					<EatingLogo className="size-7" label="" phase={copy.tone === "added" ? "spark" : "idle"} still />
				)}
				<div className="min-w-0 flex-1 text-[12px]">
					<div className="truncate font-medium" title={copy.title}>
						{copy.title}
					</div>
					<div className={cn("text-[11px] text-description", copy.tone !== "error" && "truncate")} title={copy.detail}>
						{copy.detail}
					</div>
					{copy.action && copy.tone === "error" && (
						<LinkButton className="mt-0.5 text-[11px]" data-testid="skillset-toast-action" onClick={act}>
							{copy.action}
						</LinkButton>
					)}
				</div>
				{copy.action && copy.tone !== "error" && (
					<Button className="shrink-0 px-2 py-0.5" data-testid="skillset-toast-action" onClick={act} size="xs">
						{copy.action}
					</Button>
				)}
				<HeaderIconButton data-testid="skillset-toast-close" icon="close" label="Dismiss" onClick={close} />
			</div>
			{!still && (
				<div
					aria-hidden
					className="h-0.5 origin-left bg-(--vscode-progressBar-background)"
					style={{
						animation: `toast-countdown ${durationMs}ms linear forwards`,
						animationPlayState: running ? "running" : "paused",
					}}
				/>
			)}
		</div>
	)
}

/**
 * What a skillset brought, top right like thread toasts but never silenced by
 * the thread toasts setting: the user just dropped the file and is waiting.
 */
export function SkillsetToasts() {
	const toasts = useSkillsetState((state) => state.toasts)
	const { windowFocused } = useExtensionState()
	if (!toasts.length) return null
	return (
		<div
			aria-live="polite"
			className="pointer-events-none fixed top-10 right-2 z-[61] flex w-[min(300px,calc(100%-16px))] flex-col gap-1.5"
			data-testid="skillset-toasts">
			{toasts.map((toast) => (
				<SkillsetToastCard key={toast.id} toast={toast} windowFocused={windowFocused !== false} />
			))}
		</div>
	)
}
