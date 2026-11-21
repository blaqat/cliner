import type { ClineMessage } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { HeaderIconButton } from "@/components/chat/task-header/HeaderIconButton"
import { showBeside } from "@/components/sideThreads/sideThreadStore"
import { createStorybookDecorator } from "@/config/StorybookDecorator"
import { type ThreadPanelData, ThreadPanelFrame, ThreadPanelHost, ThreadPanelToggle } from "./ThreadPanelHost"

/**
 * "This thread" around a stand-in chat: the header toggle, then the panel beside the messages
 * when there's room or over them when there isn't. Resize the viewport to see both.
 */
const now = Date.now()
const item = (id: string, fields: Partial<HistoryItem> = {}): HistoryItem => ({
	id,
	ts: now - 120_000,
	task: id,
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	...fields,
})
const main = item("main", { task: "Fix the flaky dispatcher test", title: "Fix the flaky dispatcher test" })
const history = [
	main,
	item("side", { parentTaskId: "main", task: "Is 500ms too short for the retry?", sideKind: "side", ts: now - 30_000 }),
	item("closed", { parentTaskId: "main", task: "Compare with the Go client", sideKind: "side", sideClosedAt: now }),
]
const edit = (path: string, ts: number): ClineMessage => ({
	ts,
	type: "say",
	say: "tool",
	text: JSON.stringify({ tool: "editedExistingFile", path }),
})
const messages = [edit("src/dispatch/WebhookDispatcher.java", 1), edit("src/dispatch/RetryPolicy.java", 2)]
const data: ThreadPanelData = {
	item: main,
	messages,
	usage: { totalCost: 1.84, lastApiReqTotalTokens: 82_000 },
	onNewSideThread: () => {},
}

const Chat = () => (
	<div className="flex h-screen min-h-0 flex-col bg-sidebar-background text-foreground">
		<ThreadPanelHost data={data}>
			<div className="px-4 pt-2 pb-1">
				<div className="flex min-h-7.5 items-center gap-1 rounded-xs bg-(--vscode-toolbar-hoverBackground)/40 pr-1 pl-2">
					<span className="min-w-0 flex-1 truncate text-[13px]">Fix the flaky dispatcher test</span>
					<ThreadPanelToggle />
					<HeaderIconButton icon="check" label="Settle task" />
					<HeaderIconButton icon="ellipsis" label="More actions" />
				</div>
			</div>
			<ThreadPanelFrame data={data}>
				<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-2 text-[13px]">
					{Array.from({ length: 12 }, (_, index) => (
						<p className="m-0" key={index}>
							{index % 2
								? "The retry fires before the fake clock advances, so the assertion races the timer. Pinning the clock fixes it."
								: "Can you look at why WebhookDispatcherTest fails one run in five?"}
						</p>
					))}
				</div>
			</ThreadPanelFrame>
			<div className="m-3 h-16 shrink-0 rounded-xs border border-input-border bg-input-background" />
		</ThreadPanelHost>
	</div>
)

const meta: Meta<typeof Chat> = {
	title: "Views/ThreadPanel",
	component: Chat,
	parameters: { layout: "fullscreen" },
	decorators: [
		createStorybookDecorator(
			{
				currentTaskItem: main,
				taskHistory: history,
				sessionStatuses: { side: "running" },
				currentBranch: "main",
				taskGroups: [],
				sideThreadViews: [],
				clineMessages: messages,
			},
			"max-w-none",
		),
	],
}

export default meta
type Story = StoryObj<typeof Chat>

export const Panel: Story = {}

export const SideThreadBeside: Story = {
	decorators: [
		(Story) => {
			showBeside("main", "side")
			return <Story />
		},
	],
}
