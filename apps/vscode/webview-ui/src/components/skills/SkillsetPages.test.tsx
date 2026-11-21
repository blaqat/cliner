import type { InstalledSkillset, SkillsetLibrary } from "@shared/skillsets"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NewSkillsStrip } from "./NewSkillsStrip"
import { ShareSkillsetPage } from "./ShareSkillsetPage"

const mocks = vi.hoisted(() => ({
	update: vi.fn(),
	list: vi.fn(),
	exportSkillset: vi.fn(),
	reveal: vi.fn(),
}))
vi.mock("@/services/grpc-client", () => ({
	SkillsetServiceClient: {
		updateSkillsetItems: mocks.update,
		listSkillsetLibrary: mocks.list,
		exportSkillset: mocks.exportSkillset,
		revealSkillset: mocks.reveal,
	},
	FileServiceClient: { openFile: vi.fn().mockResolvedValue({}) },
}))

const set: InstalledSkillset = {
	id: "s1",
	name: "review-kit",
	fileName: "review-kit.skillset.zip",
	addedAt: 1,
	items: [
		{
			kind: "skill",
			name: "flaky-test-hunter",
			description: "Reruns a test until it fails",
			path: "/h/.agents/skills/flaky-test-hunter/SKILL.md",
			isGlobal: true,
			enabled: false,
			runsCode: true,
			isNew: true,
			setId: "s1",
			files: [
				{ path: "SKILL.md", size: 100 },
				{ path: "scripts/rerun.sh", size: 40, runsCode: true },
			],
		},
		{
			kind: "skill",
			name: "code-review-2",
			description: "Review",
			path: "/h/.agents/skills/code-review-2/SKILL.md",
			isGlobal: true,
			enabled: false,
			runsCode: false,
			isNew: true,
			clashWith: "code-review",
			setId: "s1",
			files: [{ path: "SKILL.md", size: 100 }],
		},
	],
}

beforeEach(() => {
	mocks.update.mockReset().mockResolvedValue({})
	mocks.exportSkillset.mockReset()
	mocks.reveal.mockReset().mockResolvedValue({})
	const library: SkillsetLibrary = { skills: set.items, workflows: [], sets: [set], hasWorkspace: true }
	mocks.list.mockReset().mockResolvedValue({ json: JSON.stringify(library) })
})

describe("NewSkillsStrip", () => {
	it("shows what arrived, scripts flagged, with Turn all on and per item", async () => {
		const changed = vi.fn()
		render(<NewSkillsStrip highlightSetId="s1" onChanged={changed} sets={[set]} />)
		expect(screen.getByTestId("new-skills-set")).toHaveTextContent("2 new items from review-kit")
		expect(screen.getByTestId("new-skills-set")).toHaveTextContent("Runs code")
		fireEvent.click(screen.getByRole("button", { name: /^code-review-2/ }))
		expect(screen.getByTestId("new-skills-set")).toHaveTextContent("so this one came in as code-review-2")
		fireEvent.click(screen.getByRole("button", { name: /^flaky-test-hunter/ }))
		expect(screen.getByTestId("skill-file-list")).toHaveTextContent("scripts/rerun.sh")
		fireEvent.click(screen.getByRole("button", { name: "Turn on flaky-test-hunter" }))
		await waitFor(() =>
			expect(mocks.update).toHaveBeenCalledWith(
				expect.objectContaining({ setId: "s1", action: "turn_on", paths: [set.items[0].path] }),
			),
		)
		fireEvent.click(screen.getByRole("button", { name: "Turn all on" }))
		await waitFor(() =>
			expect(mocks.update).toHaveBeenLastCalledWith(expect.objectContaining({ action: "turn_on", paths: [] })),
		)
		fireEvent.click(screen.getByRole("button", { name: /Remove all 2 from this set/ }))
		fireEvent.click(screen.getByRole("button", { name: "Remove" }))
		await waitFor(() => expect(mocks.update).toHaveBeenLastCalledWith(expect.objectContaining({ action: "remove" })))
		expect(changed).toHaveBeenCalled()
	})

	it("renders nothing once nothing is new", () => {
		const { container } = render(
			<NewSkillsStrip
				onChanged={() => {}}
				sets={[{ ...set, items: set.items.map((item) => ({ ...item, isNew: false })) }]}
			/>,
		)
		expect(container).toBeEmptyDOMElement()
	})
})

describe("ShareSkillsetPage", () => {
	it("picks items, names the set from the first pick, saves, then offers Reveal and Copy how-to", async () => {
		mocks.exportSkillset.mockResolvedValue({
			json: JSON.stringify({
				path: "/Users/me/Downloads/flaky-test-hunter.skillset.zip",
				fileName: "flaky-test-hunter.skillset.zip",
				bytes: 2048,
				items: 1,
				runsCode: 1,
				skipped: [],
				layout: ["skillset.json · README.txt", "skills/flaky-test-hunter/… (2 files, 1 script)"],
			}),
		})
		render(<ShareSkillsetPage onBack={() => {}} />)
		const save = await screen.findByRole("button", { name: "Save skillset…" })
		expect(save).toBeDisabled()
		fireEvent.click(screen.getByRole("checkbox", { name: /flaky-test-hunter/ }))
		expect(screen.getByLabelText("Skillset name")).toHaveValue("flaky-test-hunter")
		expect(screen.getByText("Saves as flaky-test-hunter.skillset.zip")).toBeInTheDocument()
		expect(screen.getByTestId("share-skillset")).toHaveTextContent("1 runs code")
		fireEvent.click(save)
		await waitFor(() =>
			expect(mocks.exportSkillset).toHaveBeenCalledWith(
				expect.objectContaining({
					name: "flaky-test-hunter",
					itemsJson: JSON.stringify([{ kind: "skill", path: set.items[0].path }]),
				}),
			),
		)
		expect(await screen.findByTestId("share-skillset-saved")).toHaveTextContent("Saved flaky-test-hunter.skillset.zip")
		expect(screen.getByTestId("share-skillset-saved")).toHaveTextContent("hold Shift and drop")
		fireEvent.click(screen.getByRole("button", { name: /^Reveal in|^Open containing/ }))
		await waitFor(() =>
			expect(mocks.reveal).toHaveBeenCalledWith(
				expect.objectContaining({ value: expect.stringContaining(".skillset.zip") }),
			),
		)
	})
})
