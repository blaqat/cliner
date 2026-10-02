import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { StateManager } from "@core/storage/StateManager"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import sinon from "sinon"
import { McpHub } from "../McpHub"
import { ServerConfigSchema } from "../schemas"

describe("McpHub startHook", () => {
	let sandbox: sinon.SinonSandbox
	beforeEach(() => {
		sandbox = sinon.createSandbox()
		sandbox.stub(StateManager, "get").returns({ getRemoteConfigSettings: () => ({}) } as unknown as StateManager)
	})
	afterEach(() => sandbox.restore())
	function createHub() {
		const hub = Object.create(McpHub.prototype) as McpHub
		Object.assign(hub, {
			connections: [],
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
	function config(script: string, timeout = 3) {
		return ServerConfigSchema.parse({
			type: "streamableHttp",
			url: "https://example.com/mcp",
			startHook: { command: process.execPath, args: ["-e", script], timeout },
		})
	}
	it("passes patched headers to transport and leaves saved config untouched", async () => {
		const hub = createHub()
		const connect = sandbox.stub(Client.prototype, "connect").resolves()
		await (hub as any).connectToServer(
			"test",
			config('console.log(JSON.stringify({headers:{Authorization:"fresh"}}))'),
			"internal",
		)
		expect(connect.callCount).toBe(1)
		expect((hub.connections[0].transport as any)._requestInit.headers).toEqual({ Authorization: "fresh" })
		expect(JSON.parse(hub.connections[0].server.config)).not.toHaveProperty("headers")
		expect(hub.connections[0].server.status).toBe("connected")
	})
	it("passes patched env to stdio and expands hook environment settings", async () => {
		const hub = createHub()
		sandbox.stub(Client.prototype, "connect").resolves()
		sandbox.stub(StdioClientTransport.prototype, "start").resolves()
		const input = ServerConfigSchema.parse({
			command: "server",
			env: { EXISTING: "yes" },
			startHook: {
				command: process.execPath,
				args: [
					"-e",
					'if(process.env.CUSTOM!==process.env.PATH) process.exit(1); console.log(JSON.stringify({env:{FRESH:"token"}}))',
				],
				env: { CUSTOM: "${env:PATH}" },
			},
		})
		await (hub as any).connectToServer("test", input, "internal")
		expect((hub.connections[0].transport as any)._serverParams.env).toMatchObject({ EXISTING: "yes", FRESH: "token" })
		expect(JSON.parse(hub.connections[0].server.config).env).toEqual({ EXISTING: "yes" })
	})

	it("does not attempt transport connection after a hook fails", async () => {
		const hub = createHub()
		const connect = sandbox.stub(Client.prototype, "connect").resolves()
		await expect(
			(hub as any).connectToServer("test", config('console.error("failed bootstrap"); process.exit(3)'), "internal"),
		).rejects.toThrow("Start hook failed")
		expect(connect.callCount).toBe(0)
		expect(hub.connections[0].server.error).toContain("failed bootstrap")
		expect(hub.connections[0].server.status).toBe("disconnected")
	})
	it("blocks connection on timeout", async () => {
		const hub = createHub()
		const connect = sandbox.stub(Client.prototype, "connect").resolves()
		await expect((hub as any).connectToServer("test", config("setTimeout(()=>{},10000)", 0.05), "internal")).rejects.toThrow(
			"timed out",
		)
		expect(connect.callCount).toBe(0)
	})
	for (const action of ["delete", "disable", "edit"]) {
		it(`invalidates a running hook on ${action}`, async () => {
			const hub = createHub()
			const connect = sandbox.stub(Client.prototype, "connect").resolves()
			const attempt = (hub as any).connectToServer(
				"test",
				config('setTimeout(()=>console.log("obsolete"),10000)'),
				"internal",
			)
			await new Promise((resolve) => setTimeout(resolve, 30))
			if (action === "delete") await hub.deleteConnection("test")
			else
				await (hub as any).connectToServer(
					"test",
					{ ...config('console.log("new")'), disabled: action === "disable" },
					"rpc",
				)
			await attempt
			expect(connect.callCount).toBe(action === "edit" ? 1 : 0)
			expect(hub.connections).toHaveLength(action === "delete" ? 0 : 1)
			if (action === "disable") expect(hub.connections[0].server.disabled).toBe(true)
		})
	}

	it("deduplicates concurrent connect requests and reruns on RPC restart", async () => {
		const hub = createHub()
		const connect = sandbox.stub(Client.prototype, "connect").resolves()
		const input = config('setTimeout(()=>console.log("ready"),40)')
		await Promise.all([
			(hub as any).connectToServer("test", input, "internal"),
			(hub as any).connectToServer("test", input, "rpc"),
		])
		expect(connect.callCount).toBe(1)
		sandbox.stub(hub as any, "deleteConnection").callsFake(async () => {
			hub.connections = []
		})
		sandbox.stub(hub as any, "readAndValidateMcpSettingsFile").resolves({ mcpServers: { test: input } })
		const fingerprint = hub.computeToolFingerprint()
		const changed = sandbox.spy()
		hub.setToolListChangeCallback(changed)
		await hub.restartConnectionRPC("test")
		await new Promise((resolve) => setTimeout(resolve, 350))
		expect(connect.callCount).toBe(2)
		expect(hub.computeToolFingerprint()).not.toBe(fingerprint)
		expect(changed.callCount).toBe(1)
		hub.clearToolListChangeCallback()
	})
})
