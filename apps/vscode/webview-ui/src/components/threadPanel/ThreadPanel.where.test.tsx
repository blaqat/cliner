import type { HistoryItem } from "@shared/HistoryItem"
import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ThreadPanelSections } from "./ThreadPanel"

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ currentBranch: "main", navigateToWalkthrough: vi.fn(), sessionStatuses: {}, taskHistory: [] }),
}))
vi.mock("@/services/grpc-client", () => ({ SideThreadServiceClient: {}, TaskServiceClient: {} }))
vi.mock("@/components/chat/composer/ContextUsageIndicator", () => ({
	AUTO_COMPACT_PERCENT: 90,
	useComposerContextUsage: () => ({ contextWindow: 1_000_000 }),
}))
vi.mock("@/components/worktrees/useWorktree", () => ({
	useWorktree: () => ({ state: { mapping: { branch: "cline/fix-nested", mode: "mm" } } }),
	threadWorktreeAction: vi.fn(async () => ({
		summary: {
			changedFiles: 1,
			commits: 0,
			uncommittedFiles: 1,
			uncopiedFiles: 1,
			copied: false,
			canUndo: false,
			loseOnRemove: 1,
		},
	})),
}))
vi.mock("@/components/chat/composer/BranchTaskSuggestion", () => ({ useBranchTaskSuggestion: () => undefined }))
vi.mock("@/components/common/MarkdownBlock", () => ({ default: ({ markdown }: { markdown?: string }) => <p>{markdown}</p> }))

const thread: HistoryItem = { id: "t1", ts: Date.now(), task: "Fix nested", tokensIn: 0, tokensOut: 0, totalCost: 0 }

describe("This thread › where", () => {
	it("counts a worktree's changes from git, even ones no edit tool made", async () => {
		render(<ThreadPanelSections item={thread} messages={[]} usage={{ totalCost: 0 }} />)
		expect(await screen.findByText("· 1 file")).toBeTruthy()
		expect(screen.queryByText("No file changes yet")).toBeNull()
	})
})
