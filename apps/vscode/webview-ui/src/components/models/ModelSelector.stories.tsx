import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { userEvent, within } from "storybook/test"
import ChatTextArea from "@/components/chat/ChatTextArea"
import { createStorybookDecorator } from "@/config/StorybookDecorator"
import { ModelPickButton } from "./ModelPickButton"
import type { SelectorPick } from "./ModelSelector"
import { modelSettingsFixture } from "./modelSelector.fixture"
import { sameAsThreadRow, selectorDataFromModelSettings } from "./modelSelectorRows"

/**
 * The one model selector: the composer's menu, and the same lists from a settings row, with none of
 * the composer's extras. `SideBySide` shows both open at once by loading each in its own frame, since
 * a click or focus outside closes a menu.
 */
const meta: Meta = {
	title: "Views/Components/ModelSelector",
	decorators: [
		createStorybookDecorator(
			{
				mode: "act",
				modelSettings: modelSettingsFixture(),
				currentTaskItem: { id: "story", ts: 0, task: "Story", tokensIn: 0, tokensOut: 0, totalCost: 0 },
			},
			"max-w-none",
		),
	],
}

export default meta
type Story = StoryObj

const noop = () => {}

const Composer = () => (
	<div className="flex flex-col justify-end" style={{ width: 400, height: 560 }}>
		<div className="border border-(--vscode-panel-border)">
			<ChatTextArea
				inputValue=""
				onSelectFilesAndImages={noop}
				onSend={noop}
				placeholderText="Ask Cline to…"
				selectedFiles={[]}
				selectedImages={[]}
				sendingDisabled={false}
				setInputValue={noop}
				setSelectedFiles={noop}
				setSelectedImages={noop}
				shouldDisableFilesAndImages={false}
			/>
		</div>
	</div>
)

const { rows, ladder } = selectorDataFromModelSettings(modelSettingsFixture())

const SettingsRow = ({
	label,
	description,
	initial,
	withThread,
	empty,
}: {
	label: string
	description: string
	initial: SelectorPick | null
	withThread?: boolean
	empty?: boolean
}) => {
	const [pick, setPick] = useState(initial)
	const listed = empty ? [] : withThread ? [sameAsThreadRow(ladder), ...rows] : rows
	return (
		<div className="flex items-center justify-between gap-3 border-0 border-b border-solid border-(--vscode-panel-border) py-2">
			<div className="min-w-0">
				<div className="text-xs text-foreground">{label}</div>
				<div className="text-[11px] text-description">{description}</div>
			</div>
			<ModelPickButton
				ladder={ladder}
				modelsLabel={label}
				onCommit={setPick}
				onManage={noop}
				pick={empty ? null : pick}
				rows={listed}
			/>
		</div>
	)
}

const SettingsRows = ({ empty }: { empty?: boolean }) => (
	<div style={{ width: 400, height: 560 }}>
		<SettingsRow
			description="New threads start with this."
			empty={empty}
			initial={{ rowId: "sol", levelId: "medium" }}
			label="Chat"
		/>
		<SettingsRow
			description="What helpers run on."
			empty={empty}
			initial={{ rowId: "thread", levelId: "inherit" }}
			label="Subagents"
			withThread
		/>
		<SettingsRow
			description="Titles, commit messages and Generate."
			empty={empty}
			initial={{ rowId: "qwen", levelId: "default" }}
			label="Background text"
		/>
	</div>
)

export const InComposer: Story = {
	render: () => <Composer />,
	play: async ({ canvasElement }) => {
		await userEvent.click(within(canvasElement).getByTestId("model-effort-chip"))
	},
}

export const InSettingsRow: Story = {
	render: () => <SettingsRows />,
	play: async ({ canvasElement }) => {
		await userEvent.click(within(canvasElement).getAllByTestId("model-pick-button")[0])
	},
}

export const LevelsGreyedForAModel: Story = {
	render: () => (
		<div style={{ width: 400, height: 560 }}>
			<SettingsRow description="New threads start with this." initial={{ rowId: "g54", levelId: "high" }} label="Chat" />
		</div>
	),
	play: async ({ canvasElement }) => {
		await userEvent.click(within(canvasElement).getByTestId("model-pick-button"))
	},
}

export const NoModelsYet: Story = {
	render: () => <SettingsRows empty />,
	play: async ({ canvasElement }) => {
		await userEvent.click(within(canvasElement).getAllByTestId("model-pick-button")[0])
	},
}

const frame = (story: string, title: string) => (
	<figure className="m-0 flex flex-col gap-1">
		<figcaption className="text-[11px] text-description">{title}</figcaption>
		<iframe
			className="border-0"
			height={620}
			src={`iframe.html?id=views-components-modelselector--${story}&viewMode=story`}
			title={title}
			width={440}
		/>
	</figure>
)

export const SideBySide: Story = {
	render: () => (
		<div className="flex gap-4">
			{frame("in-composer", "In the composer")}
			{frame("in-settings-row", "In Settings › Models")}
		</div>
	),
}
