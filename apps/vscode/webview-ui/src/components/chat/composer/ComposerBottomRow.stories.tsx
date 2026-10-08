import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, waitFor } from "storybook/test"
import { createStorybookDecorator } from "@/config/StorybookDecorator"
import ChatTextArea from "../ChatTextArea"
import { ContextUsageIndicator } from "./ContextUsageIndicator"

/**
 * The composer's bottom row at sidebar widths, with the widest content: a long configuration name,
 * a reasoning-effort label, approvals, the chat cost and the 85% Compact pill. Used to check that
 * the row collapses in order and never wraps or overlaps: the play function checks real bounds.
 */
const meta: Meta<typeof ChatTextArea> = {
	title: "Views/Components/ComposerBottomRow",
	component: ChatTextArea,
	decorators: [
		createStorybookDecorator(
			{
				mode: "act",
				apiConfiguration: { actModeApiProvider: "openai-native", actModeApiModelId: "gpt-5.1" },
				apiConfigProfiles: [
					{ id: "work", name: "Work · OpenAI long configuration name", provider: "openai-native", modelId: "gpt-5.1" },
				],
				actProfileId: "work",
			},
			"max-w-none",
		),
	],
}

export default meta
type Story = StoryObj<typeof ChatTextArea>

const noop = () => {}
const WIDTHS = [250, 280, 300, 320, 360, 400, 440, 480]

const Composer = ({ width }: { width: number }) => (
	<div className="border border-(--vscode-panel-border)" data-width={width} style={{ width }}>
		<ChatTextArea
			inputValue=""
			onSelectFilesAndImages={noop}
			onSend={noop}
			placeholderText="Type a message"
			selectedFiles={[]}
			selectedImages={[]}
			sendingDisabled={false}
			setInputValue={noop}
			setSelectedFiles={noop}
			setSelectedImages={noop}
			shouldDisableFilesAndImages={false}
			usageIndicator={{
				hasCost: true,
				hasCompactNudge: true,
				render: (layout) => (
					<ContextUsageIndicator
						canCompact={true}
						contextWindow={200_000}
						cost={12.34}
						inlineCompactNudge={layout.inlineCompactNudge}
						modelLabel="OpenAI · gpt-5.1"
						onCompact={noop}
						showCost={layout.showCost}
						tokensIn={150_000}
						tokensOut={20_000}
						usedTokens={180_000}
					/>
				),
			}}
		/>
	</div>
)

export const SidebarWidths: Story = {
	render: () => (
		<div className="flex flex-col gap-4">
			{WIDTHS.map((width) => (
				<Composer key={width} width={width} />
			))}
		</div>
	),
	play: async ({ canvasElement }) => {
		const rows = () => [...canvasElement.querySelectorAll<HTMLElement>('[data-testid="composer-bottom-row"]')]
		await waitFor(() => expect(rows()).toHaveLength(WIDTHS.length))
		for (const row of rows()) {
			const bounds = row.getBoundingClientRect()
			const items = [...row.children].map((child) => child.getBoundingClientRect())
			// One line: every item shares the row's vertical band.
			for (const item of items) {
				await expect(item.top).toBeGreaterThanOrEqual(bounds.top - 1)
				await expect(item.bottom).toBeLessThanOrEqual(bounds.bottom + 1)
			}
			// No overlap, and the Ask/Act toggle stays inside the row.
			for (let i = 1; i < items.length; i++) {
				await expect(items[i].left).toBeGreaterThanOrEqual(items[i - 1].right - 0.5)
			}
			await expect(items[items.length - 1].right).toBeLessThanOrEqual(bounds.right + 0.5)
			// Nothing inside the picker group is clipped.
			const group = row.querySelector('[data-testid="composer-pickers"]')
			await expect(group).not.toBeNull()
			for (const picker of group?.children ?? []) {
				await expect(picker.getBoundingClientRect().right).toBeLessThanOrEqual(
					(group as Element).getBoundingClientRect().right + 0.5,
				)
			}
		}
	},
}
