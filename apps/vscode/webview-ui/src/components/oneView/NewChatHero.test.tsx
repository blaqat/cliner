import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { NewChatHero } from "./NewChatHero"

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => ({ environment: "production" }) }))

describe("NewChatHero", () => {
	it("shows a big logo and a larger heading now that the threads live in the list", () => {
		render(<NewChatHero />)
		const hero = screen.getByTestId("one-view-new-chat-hero")
		expect(screen.getByTestId("home-logo")).toHaveClass("size-16")
		expect(hero.querySelector("svg")).toBeInTheDocument()
		const heading = screen.getByRole("heading", { name: "What should Cline do?" })
		expect(heading).toHaveClass("text-[19px]", "font-semibold")
	})
})
