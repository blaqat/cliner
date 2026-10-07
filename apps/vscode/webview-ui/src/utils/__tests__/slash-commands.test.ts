import type { McpServer } from "@shared/mcp"
import { describe, expect, it } from "vitest"
import {
	getMatchingSlashCommands,
	getMcpPromptCommands,
	parseModeSwitchCommand,
	shouldShowSlashCommandsMenu,
	slashCommandRegex,
	validateSlashCommand,
} from "../slash-commands"

// Helper to create a mock MCP server
function createMockMcpServer(overrides: Partial<McpServer> = {}): McpServer {
	return {
		name: "test-server",
		status: "connected",
		config: "{}",
		prompts: [],
		tools: [],
		resources: [],
		resourceTemplates: [],
		...overrides,
	}
}

describe("slash-commands", () => {
	describe("getMcpPromptCommands", () => {
		it("should return empty array when no servers provided", () => {
			const result = getMcpPromptCommands([])
			expect(result).toEqual([])
		})

		it("should return empty array when servers have no prompts", () => {
			const servers = [createMockMcpServer({ prompts: [] })]
			const result = getMcpPromptCommands(servers)
			expect(result).toEqual([])
		})

		it("should skip disconnected servers", () => {
			const servers = [
				createMockMcpServer({
					status: "disconnected",
					prompts: [{ name: "test-prompt", description: "A test prompt" }],
				}),
			]
			const result = getMcpPromptCommands(servers)
			expect(result).toEqual([])
		})

		it("should skip servers with connecting status", () => {
			const servers = [
				createMockMcpServer({
					status: "connecting",
					prompts: [{ name: "test-prompt", description: "A test prompt" }],
				}),
			]
			const result = getMcpPromptCommands(servers)
			expect(result).toEqual([])
		})

		it("should generate commands for connected servers with prompts", () => {
			const servers = [
				createMockMcpServer({
					name: "my-server",
					prompts: [{ name: "summarize", description: "Summarize text" }],
				}),
			]
			const result = getMcpPromptCommands(servers)
			expect(result).toEqual([
				{
					name: "mcp:my-server:summarize",
					description: "Summarize text",
					section: "mcp",
				},
			])
		})

		it("should use title as fallback description", () => {
			const servers = [
				createMockMcpServer({
					name: "server",
					prompts: [{ name: "prompt", title: "My Prompt Title" }],
				}),
			]
			const result = getMcpPromptCommands(servers)
			expect(result[0].description).toBe("My Prompt Title")
		})

		it("should use default description when no description or title", () => {
			const servers = [
				createMockMcpServer({
					name: "server",
					prompts: [{ name: "prompt" }],
				}),
			]
			const result = getMcpPromptCommands(servers)
			expect(result[0].description).toBe("MCP prompt from server")
		})

		it("should handle multiple prompts from single server", () => {
			const servers = [
				createMockMcpServer({
					name: "multi-server",
					prompts: [
						{ name: "prompt1", description: "First prompt" },
						{ name: "prompt2", description: "Second prompt" },
						{ name: "prompt3", description: "Third prompt" },
					],
				}),
			]
			const result = getMcpPromptCommands(servers)
			expect(result).toHaveLength(3)
			expect(result.map((c) => c.name)).toEqual([
				"mcp:multi-server:prompt1",
				"mcp:multi-server:prompt2",
				"mcp:multi-server:prompt3",
			])
		})

		it("should handle multiple servers with prompts", () => {
			const servers = [
				createMockMcpServer({
					name: "server-a",
					prompts: [{ name: "promptA", description: "From A" }],
				}),
				createMockMcpServer({
					name: "server-b",
					prompts: [{ name: "promptB", description: "From B" }],
				}),
			]
			const result = getMcpPromptCommands(servers)
			expect(result).toHaveLength(2)
			expect(result[0].name).toBe("mcp:server-a:promptA")
			expect(result[1].name).toBe("mcp:server-b:promptB")
		})

		it("should skip servers with undefined prompts", () => {
			const servers = [
				createMockMcpServer({
					name: "server",
					prompts: undefined,
				}),
			]
			const result = getMcpPromptCommands(servers)
			expect(result).toEqual([])
		})
	})

	describe("getMatchingSlashCommands with default commands", () => {
		it("shows /compact for the comp prefix", () => {
			const result = getMatchingSlashCommands("comp")

			expect(result).toContainEqual({
				name: "compact",
				description: "Condenses your current context window",
				section: "default",
				cliCompatible: true,
			})
		})
	})

	describe("getMatchingSlashCommands with MCP servers", () => {
		const mcpServers = [
			createMockMcpServer({
				name: "test-server",
				prompts: [
					{ name: "summarize", description: "Summarize content" },
					{ name: "translate", description: "Translate text" },
				],
			}),
		]

		it("should include MCP commands in results when no query", () => {
			const result = getMatchingSlashCommands("", {}, {}, undefined, undefined, mcpServers)
			const mcpCommands = result.filter((cmd) => cmd.section === "mcp")
			expect(mcpCommands).toHaveLength(2)
		})

		it("should filter MCP commands by query prefix", () => {
			const result = getMatchingSlashCommands("mcp:test", {}, {}, undefined, undefined, mcpServers)
			const mcpCommands = result.filter((cmd) => cmd.section === "mcp")
			expect(mcpCommands).toHaveLength(2)
		})

		it("should filter to specific MCP prompt", () => {
			const result = getMatchingSlashCommands("mcp:test-server:sum", {}, {}, undefined, undefined, mcpServers)
			expect(result).toHaveLength(1)
			expect(result[0].name).toBe("mcp:test-server:summarize")
		})

		it("should return empty for non-matching MCP query", () => {
			const result = getMatchingSlashCommands("mcp:nonexistent", {}, {}, undefined, undefined, mcpServers)
			expect(result).toHaveLength(0)
		})
	})

	describe("validateSlashCommand with MCP servers", () => {
		const mcpServers = [
			createMockMcpServer({
				name: "server",
				prompts: [{ name: "prompt", description: "Test" }],
			}),
		]

		it("should return full for exact MCP command match", () => {
			const result = validateSlashCommand("mcp:server:prompt", {}, {}, undefined, undefined, mcpServers)
			expect(result).toBe("full")
		})

		it("should return partial for partial MCP command match", () => {
			const result = validateSlashCommand("mcp:server:pro", {}, {}, undefined, undefined, mcpServers)
			expect(result).toBe("partial")
		})

		it("should return partial for server prefix only", () => {
			const result = validateSlashCommand("mcp:serv", {}, {}, undefined, undefined, mcpServers)
			expect(result).toBe("partial")
		})

		it("should return null for non-matching MCP command", () => {
			const result = validateSlashCommand("mcp:unknown:cmd", {}, {}, undefined, undefined, mcpServers)
			expect(result).toBe(null)
		})
	})

	describe("slashCommandRegex with MCP format", () => {
		it("should match MCP command format with colons", () => {
			const text = "/mcp:server:prompt"
			const match = text.match(slashCommandRegex)
			expect(match).not.toBeNull()
			expect(match![2]).toBe("/mcp:server:prompt")
		})

		it("should match MCP command in middle of text", () => {
			const text = "Please run /mcp:server:prompt now"
			const match = text.match(slashCommandRegex)
			expect(match).not.toBeNull()
			expect(match![2]).toBe("/mcp:server:prompt")
		})

		it("should not match MCP-like pattern in URL", () => {
			const text = "http://example.com/mcp:test"
			const match = text.match(slashCommandRegex)
			// Should not match because / is not preceded by whitespace or start
			expect(match).toBeNull()
		})
	})

	describe("/ask and /act mode-switch commands", () => {
		it("offers /ask and /act in the slash menu", () => {
			const names = getMatchingSlashCommands("").map((cmd) => cmd.name)
			expect(names).toContain("ask")
			expect(names).toContain("act")
		})

		it("validates /ask and /act as full commands", () => {
			expect(validateSlashCommand("ask")).toBe("full")
			expect(validateSlashCommand("act")).toBe("full")
		})

		it("filters both commands for the /a prefix", () => {
			const names = getMatchingSlashCommands("a").map((cmd) => cmd.name)
			expect(names).toContain("ask")
			expect(names).toContain("act")
		})
	})

	describe("parseModeSwitchCommand", () => {
		it("parses a bare /ask as plan mode with no text", () => {
			expect(parseModeSwitchCommand("/ask")).toEqual({ mode: "plan", rest: "" })
		})

		it("parses a bare /act as act mode with no text", () => {
			expect(parseModeSwitchCommand("/act")).toEqual({ mode: "act", rest: "" })
		})

		it("returns the text after the command", () => {
			expect(parseModeSwitchCommand("/act build the thing")).toEqual({ mode: "act", rest: "build the thing" })
			expect(parseModeSwitchCommand("/ask   why is this slow?")).toEqual({ mode: "plan", rest: "why is this slow?" })
		})

		it("matches a standalone token anywhere in the text and removes it", () => {
			expect(parseModeSwitchCommand("please /act on this")).toEqual({ mode: "act", rest: "please on this" })
			expect(parseModeSwitchCommand("text\n/ask why")).toEqual({ mode: "plan", rest: "text why" })
			expect(parseModeSwitchCommand("please review this /act")).toEqual({ mode: "act", rest: "please review this" })
		})

		it("lets the last mode command win when several appear", () => {
			expect(parseModeSwitchCommand("/ask /act build it")).toEqual({ mode: "act", rest: "build it" })
			expect(parseModeSwitchCommand("/act build /ask carefully")).toEqual({ mode: "plan", rest: "build carefully" })
			expect(parseModeSwitchCommand("a /act b /ask c")).toEqual({ mode: "plan", rest: "a b c" })
		})

		it("collapses the whitespace a removed command leaves behind", () => {
			expect(parseModeSwitchCommand("please  /act   build")).toEqual({ mode: "act", rest: "please build" })
		})

		it("preserves multi-line text after the command", () => {
			expect(parseModeSwitchCommand("/act first\nsecond")).toEqual({ mode: "act", rest: "first\nsecond" })
		})

		it("matches case-insensitively", () => {
			expect(parseModeSwitchCommand("/ACT go")).toEqual({ mode: "act", rest: "go" })
		})

		it("does not match a prefix of a longer word", () => {
			expect(parseModeSwitchCommand("/activity today")).toBeNull()
			expect(parseModeSwitchCommand("/asked about it")).toBeNull()
			expect(parseModeSwitchCommand("run /actions now")).toBeNull()
		})

		it("does not match inside words or paths", () => {
			expect(parseModeSwitchCommand("a/act")).toBeNull()
			expect(parseModeSwitchCommand("foo/ask")).toBeNull()
			expect(parseModeSwitchCommand("see http://example.com/ask now")).toBeNull()
			expect(parseModeSwitchCommand("run foo/act it")).toBeNull()
		})

		it("does not match plain text or other commands", () => {
			expect(parseModeSwitchCommand("")).toBeNull()
			expect(parseModeSwitchCommand("hello")).toBeNull()
			expect(parseModeSwitchCommand("/compact")).toBeNull()
		})
	})

	describe("shouldShowSlashCommandsMenu", () => {
		it("shows for a command typed at the cursor mid-message", () => {
			expect(shouldShowSlashCommandsMenu("/compact now /re", "/compact now /re".length)).toBe(true)
		})

		it("still shows for the first command", () => {
			expect(shouldShowSlashCommandsMenu("/re", 3)).toBe(true)
		})

		it("does not show when the slash is inside a word or path", () => {
			expect(shouldShowSlashCommandsMenu("see foo/re", "see foo/re".length)).toBe(false)
		})

		it("does not show when whitespace follows the slash before the cursor", () => {
			expect(shouldShowSlashCommandsMenu("/compact now /re tail", "/compact now /re".length)).toBe(true)
			expect(shouldShowSlashCommandsMenu("text / tail", "text / ".length)).toBe(false)
		})
	})
})
