import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { type ReactNode, useMemo, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { usePlatform } from "@/context/PlatformContext"
import { cn } from "@/lib/utils"
import { detectMetaKeyChar, detectOS } from "@/utils/platformUtils"
import Section from "../Section"
import { buildShortcuts, FEATURE_GROUPS, IMPROVEMENT_GROUPS, UPSTREAM_CLINE_VERSION } from "./about/aboutContent"
import { RELEASE_NOTES } from "./about/releaseNotes"

interface AboutSectionProps {
	version: string
	extensionVariant?: "legacy" | "next"
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

const VARIANT_LABELS: Record<"legacy" | "next", string> = {
	legacy: "Legacy",
	next: "Next",
}

type AboutTab = "features" | "improvements"

const TABS: { id: AboutTab; label: string }[] = [
	{ id: "features", label: "Features" },
	{ id: "improvements", label: "Improvements & fixes" },
]

const Disclosure = ({
	title,
	defaultOpen = false,
	testId,
	children,
}: {
	title: ReactNode
	defaultOpen?: boolean
	testId?: string
	children: ReactNode
}) => {
	const [open, setOpen] = useState(defaultOpen)
	return (
		<div data-testid={testId}>
			<button
				aria-expanded={open}
				className="flex w-full cursor-pointer items-center gap-1 border-0 bg-transparent p-0 py-1 text-left text-foreground"
				onClick={() => setOpen((value) => !value)}
				type="button">
				<span className={cn("codicon text-xs", open ? "codicon-chevron-down" : "codicon-chevron-right")} />
				{title}
			</button>
			{open && children}
		</div>
	)
}

/** Page-level heading (Shortcuts, What's new, Community & Support…), as on the stock About page. */
const SectionTitle = ({ children }: { children: ReactNode }) => <h3 className="m-0 mt-2 text-md font-semibold">{children}</h3>

/** A group inside a tab (Threads & inbox, Tasks & notebook…): one step below the page headings. */
const GroupTitle = ({ children }: { children: ReactNode }) => (
	<h4 className="m-0 mt-3 mb-1 text-sm font-semibold text-foreground">{children}</h4>
)

const BulletList = ({ items, className }: { items: string[]; className?: string }) => (
	<ul className={cn("m-0 flex list-disc flex-col gap-1 pl-5 text-sm text-description", className)}>
		{items.map((item) => (
			<li key={item}>{item}</li>
		))}
	</ul>
)

const FeaturesTab = () => (
	<div className="flex flex-col" data-testid="about-features">
		{FEATURE_GROUPS.map((group) => (
			<section data-testid={`about-group-${group.id}`} key={group.id}>
				<GroupTitle>{group.title}</GroupTitle>
				<BulletList items={group.items} />
			</section>
		))}
	</div>
)

const ImprovementsTab = () => (
	<div className="flex flex-col" data-testid="about-improvements">
		{IMPROVEMENT_GROUPS.map((group) => (
			<section data-testid={`about-fixes-${group.id}`} key={group.id}>
				<GroupTitle>{group.title}</GroupTitle>
				<BulletList items={group.items} />
			</section>
		))}
	</div>
)

const AboutSection = ({ version, extensionVariant, renderSectionHeader }: AboutSectionProps) => {
	const { platform, enterSendsAs } = useExtensionState()
	const { togglePlanActKeys } = usePlatform()
	const [tab, setTab] = useState<AboutTab>("features")

	const shortcuts = useMemo(
		() =>
			buildShortcuts({
				mod: detectMetaKeyChar(platform),
				alt: detectOS(platform) === "mac" ? "⌥" : "Alt",
				toggleKeys: togglePlanActKeys,
				enterSendsAs: enterSendsAs ?? "steer",
			}),
		[platform, togglePlanActKeys, enterSendsAs],
	)

	return (
		<div>
			{renderSectionHeader("about")}
			<Section>
				<div className="flex flex-col gap-2 px-4">
					<div>
						<h2 className="text-lg font-semibold">
							Cline (Fork)
							{extensionVariant && (
								<span className="ml-2 text-sm font-normal text-description">
									({VARIANT_LABELS[extensionVariant]})
								</span>
							)}
						</h2>
						<div className="text-xs text-description" data-testid="about-version">
							v{version} · based on Cline {UPSTREAM_CLINE_VERSION}
						</div>
					</div>

					<div aria-label="About" className="flex gap-3.5 border-b border-editor-group-border" role="tablist">
						{TABS.map(({ id, label }) => (
							<button
								aria-selected={tab === id}
								className={cn(
									"-mb-px cursor-pointer border-0 border-b-2 bg-transparent px-0 pb-1.5 text-xs",
									tab === id
										? "border-b-(--vscode-focusBorder) text-foreground"
										: "border-b-transparent text-description hover:text-foreground",
								)}
								data-testid={`about-tab-${id}`}
								key={id}
								onClick={() => setTab(id)}
								role="tab"
								type="button">
								{label}
							</button>
						))}
					</div>

					{tab === "features" ? <FeaturesTab /> : <ImprovementsTab />}

					<section data-testid="about-shortcuts">
						<SectionTitle>Shortcuts</SectionTitle>
						<table className="w-full border-collapse text-sm">
							<tbody>
								{shortcuts.map((row) => (
									<tr
										className="border-b border-dashed border-editor-group-border last:border-b-0"
										key={row.id}>
										<td className="py-1 pr-2 text-description">{row.label}</td>
										<td className="py-1 text-right">
											<kbd className="whitespace-nowrap rounded-xs border border-input-border px-1 text-[11px]">
												{row.keys}
											</kbd>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</section>

					<section className="mt-2">
						<Disclosure testId="about-whats-new" title={<h3 className="m-0 text-md font-semibold">What's new</h3>}>
							<div className="flex flex-col gap-0.5 pl-3">
								{RELEASE_NOTES.map((release, index) => (
									<Disclosure
										defaultOpen={index === 0}
										key={release.id}
										testId={`about-release-${release.id}`}
										title={
											<span className="text-sm">
												<b>{release.title}</b>
												<span className="ml-2 text-description">
													{[release.builds, release.date].filter(Boolean).join(" · ")}
												</span>
											</span>
										}>
										<BulletList className="mb-1 pl-8" items={release.notes} />
									</Disclosure>
								))}
							</div>
						</Disclosure>
					</section>

					<SectionTitle>Community & Support</SectionTitle>
					<p className="m-0">
						<VSCodeLink href="https://x.com/cline">X</VSCodeLink>
						{" • "}
						<VSCodeLink href="https://discord.gg/cline">Discord</VSCodeLink>
						{" • "}
						<VSCodeLink href="https://www.reddit.com/r/cline/"> r/cline</VSCodeLink>
					</p>

					<SectionTitle>Development</SectionTitle>
					<p className="m-0">
						<VSCodeLink href="https://github.com/cline/cline">GitHub</VSCodeLink>
						{" • "}
						<VSCodeLink href="https://github.com/cline/cline/issues"> Issues</VSCodeLink>
						{" • "}
						<VSCodeLink href="https://github.com/cline/cline/discussions/categories/feature-requests?discussions_q=is%3Aopen+category%3A%22Feature+Requests%22+sort%3Atop">
							{" "}
							Feature Requests
						</VSCodeLink>
					</p>

					<SectionTitle>Resources</SectionTitle>
					<p className="m-0">
						<VSCodeLink href="https://docs.cline.bot/">Documentation</VSCodeLink>
						{" • "}
						<VSCodeLink href="https://cline.bot/">https://cline.bot</VSCodeLink>
					</p>
				</div>
			</Section>
		</div>
	)
}

export default AboutSection
