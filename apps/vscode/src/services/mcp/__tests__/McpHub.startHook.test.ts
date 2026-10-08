import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { HookExecutionError } from "@core/hooks/HookError"
import { HookFactory } from "@core/hooks/hook-factory"
import { StateManager } from "@core/storage/StateManager"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import sinon from "sinon"
import { McpHub } from "../McpHub"
import { StreamableHttpReconnectHandler } from "../StreamableHttpReconnectHandler"
import { ServerConfigSchema } from "../schemas"

describe("McpHub McpServerStart hook", () => {
	let sandbox: sinon.SinonSandbox
	let run: sinon.SinonStub
	let create: sinon.SinonStub
	let enabled: boolean
	beforeEach(() => {
		sandbox = sinon.createSandbox()
		enabled = true
		sandbox.stub(StateManager, "get").returns({
			getRemoteConfigSettings: () => ({}),
			getGlobalSettingsKey: () => enabled,
		} as unknown as StateManager)
		run = sandbox.stub().resolves({ cancel: false })
		create = sandbox.stub(HookFactory.prototype, "createWithStreaming").resolves({ isNoOp: false, run } as any)
	})
	afterEach(() => sandbox.restore())
	function createHub() {
		const hub = Object.create(McpHub.prototype) as McpHub
		Object.assign(hub, {
			connections: [],
			fileWatchers: new Map(),
			listChangedRefreshTimers: new Map(),
			listChangedRefreshDeadlines: new Map(),
			listChangedRefreshGeneration: new Map(),
			clientVersion: "test",
			mcpOAuthManager: { getOrCreateProvider: async () => undefined },
		})
		sandbox.stub(hub as any, "notifyWebviewOfServerChanges").resolves()
		sandbox.stub(hub as any, "fetchServerCapabilities").resolves()
		return hub
	}
	const config = () =>
		ServerConfigSchema.parse({ type: "streamableHttp", url: "https://example.com/mcp", headers: { Secret: "hidden" } })
	for (const reason of ["initial", "restart", "reconnect", "config_changed"]) {
		it(`runs before connection for ${reason} without secrets or a chat task`, async () => {
			const hub = createHub()
			const connect = sandbox.stub(Client.prototype, "connect").resolves()
			await (hub as any).connectToServer("test", config(), "internal", reason)
			expect(run.firstCall.args[0]).toEqual({
				mcpServerStart: {
					serverName: "test",
					transportType: "streamableHttp",
					url: "https://example.com/mcp",
					args: [],
					reason,
				},
			})
			expect(run.calledBefore(connect)).toBe(true)
		})
	}
	it("uses config_changed when reconciling an existing server", async () => {
		const hub = createHub()
		sandbox.stub(Client.prototype, "connect").resolves()
		await (hub as any).connectToServer("test", config(), "internal")
		await hub.updateServerConnections({ test: { ...config(), url: "https://example.com/changed" } })
		expect(run.lastCall.args[0].mcpServerStart.reason).toBe("config_changed")
	})
	it("runs the hook on the transport reconnect callback", async () => {
		const hub = createHub()
		sandbox.stub(Client.prototype, "connect").resolves()
		sandbox.stub(StreamableHttpReconnectHandler.prototype, "handleError").callsFake(async function (
			this: StreamableHttpReconnectHandler,
		) {
			const callbacks = (this as any).callbacks
			await callbacks.deleteConnection()
			await callbacks.connectToServer()
		})
		await (hub as any).connectToServer("test", config(), "internal")
		await hub.connections[0].transport.onerror!(new Error("connection lost"))
		expect(run.callCount).toBe(2)
		expect(run.lastCall.args[0].mcpServerStart.reason).toBe("reconnect")
	})
	it("invalidates discovery when settings delete a server before it has a row", async () => {
		const hub = createHub()
		const connect = sandbox.stub(Client.prototype, "connect").resolves()
		let finish!: (value: any) => void
		create.callsFake(
			() =>
				new Promise((resolve) => {
					finish = resolve
				}),
		)
		const attempt = (hub as any).connectToServer("test", config(), "internal")
		expect(hub.connections).toHaveLength(0)
		await hub.updateServerConnections({})
		finish({ isNoOp: false, run })
		await attempt
		expect(run.callCount).toBe(0)
		expect(connect.callCount).toBe(0)
		expect(hub.connections).toHaveLength(0)
	})
	it("skips connecting on cancel", async () => {
		const hub = createHub()
		const connect = sandbox.stub(Client.prototype, "connect").resolves()
		run.resolves({ cancel: true })
		await (hub as any).connectToServer("test", config(), "internal")
		expect(connect.callCount).toBe(0)
		expect(hub.connections[0].server).toMatchObject({ status: "disconnected", error: "Skipped by McpServerStart hook" })
	})
	for (const error of [
		new Error("Refresh failed"),
		HookExecutionError.execution("hook", 3, "failed bootstrap", "McpServerStart"),
		HookExecutionError.timeout("hook", 30000, "waiting", "McpServerStart"),
	]) {
		it(`blocks connecting on ${error.message}`, async () => {
			const hub = createHub()
			const connect = sandbox.stub(Client.prototype, "connect").resolves()
			if (error.message === "Refresh failed") run.resolves({ errorMessage: error.message })
			else run.rejects(error)
			await expect((hub as any).connectToServer("test", config(), "internal")).rejects.toThrow(error.message)
			expect(connect.callCount).toBe(0)
			expect(hub.connections[0].server.error).toContain(error.message)
			if (HookExecutionError.isHookError(error)) expect(hub.connections[0].server.error).toContain(error.errorInfo.stderr!)
		})
	}
	for (const action of ["delete", "disable", "edit"]) {
		it(`invalidates a running hook on ${action}`, async () => {
			const hub = createHub()
			const connect = sandbox.stub(Client.prototype, "connect").resolves()
			let finish!: (value: object) => void
			let started!: () => void
			const running = new Promise<void>((resolve) => {
				started = resolve
			})
			run.onFirstCall().callsFake(() => {
				started()
				return new Promise((resolve) => {
					finish = resolve
				})
			})
			const attempt = (hub as any).connectToServer("test", config(), "internal")
			await running
			const signal = create.firstCall.args[2] as AbortSignal
			if (action === "delete") await hub.deleteConnection("test")
			else
				await (hub as any).connectToServer(
					"test",
					{ ...config(), disabled: action === "disable", url: "https://example.com/new" },
					"rpc",
				)
			expect(signal.aborted).toBe(true)
			finish({ cancel: false })
			await attempt
			expect(connect.callCount).toBe(action === "edit" ? 1 : 0)
			expect(hub.connections).toHaveLength(action === "delete" ? 0 : 1)
		})
	}
	it("deduplicates concurrent connects and runs again on Retry Connection", async () => {
		const hub = createHub()
		const connect = sandbox.stub(Client.prototype, "connect").resolves()
		await Promise.all([
			(hub as any).connectToServer("test", config(), "internal"),
			(hub as any).connectToServer("test", config(), "rpc"),
		])
		expect(run.callCount).toBe(1)
		expect(connect.callCount).toBe(1)
		sandbox.stub(hub as any, "readAndValidateMcpSettingsFile").resolves({ mcpServers: { test: config() } })
		await hub.restartConnectionRPC("test")
		expect(run.callCount).toBe(2)
		expect(run.lastCall.args[0].mcpServerStart.reason).toBe("restart")
	})
	it("does not discover hooks when the global setting is off or the server is disabled", async () => {
		const hub = createHub()
		sandbox.stub(Client.prototype, "connect").resolves()
		enabled = false
		await (hub as any).connectToServer("test", config(), "internal")
		enabled = true
		await (hub as any).connectToServer("disabled", { ...config(), disabled: true }, "internal")
		expect(create.callCount).toBe(0)
	})
	it("ignores obsolete startHook keys in flat and nested settings, even malformed ones", () => {
		for (const transport of [{ command: "server" }, { transport: { type: "stdio", command: "server" } }]) {
			expect(ServerConfigSchema.parse({ ...transport, startHook: "obsolete" })).not.toHaveProperty("startHook")
		}
	})
})
