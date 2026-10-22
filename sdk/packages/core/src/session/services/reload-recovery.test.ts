import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileSessionService } from "./file-session-service";

const dirs: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("thread status after a host restart", () => {
	it.each([
		{ status: "idle", saved: "done", expected: "idle" },
		{ status: "completed", saved: "done", expected: "completed" },
		{ status: "running", saved: "running", expected: "cancelled" },
		{ status: "pending", saved: "waiting", expected: "pending" },
		// ask_question runs inside a tool and need not set Core's pending status.
		{ status: "running", saved: "waiting", expected: "cancelled" },
		// Graceful shutdown cancels the runtime suspended on a decision.
		{ status: "cancelled", saved: "waiting", expected: "cancelled" },
		{ status: "failed", saved: "error", expected: "failed" },
	] as const)("restores $status / $saved as $expected", async ({
		status,
		saved,
		expected,
	}) => {
		const dir = mkdtempSync(join(tmpdir(), "cline-reload-"));
		dirs.push(dir);
		vi.stubEnv("CLINE_DATA_DIR", dir);
		vi.stubEnv("CLINE_HOOKS_LOG_PATH", join(dir, "hooks.jsonl"));
		const before = new FileSessionService(dir);
		await before.createRootSessionWithArtifacts({
			sessionId: "background-thread",
			source: "vscode",
			pid: 999_999_999,
			interactive: true,
			status,
			provider: "fixture",
			model: "fixture",
			cwd: dir,
			workspaceRoot: dir,
			enableTools: true,
			enableSpawn: false,
			enableTeams: false,
			metadata: { vscodeThreadStatus: saved },
		});
		await before.persistSessionMessages("background-thread", [
			{ role: "user", content: "Test" },
			{ role: "assistant", content: "Finished" },
		]);

		// Fresh instances read only disk, with no live session or status map.
		const after = new FileSessionService(dir);
		const [record] = await after.listSessions();
		expect(record?.status).toBe(expected);
		expect(record?.metadata?.vscodeThreadStatus).toBe(saved);
		if (expected === "cancelled" && status === "running") {
			expect(record).toMatchObject({ status: "cancelled", exitCode: 0 });
			expect(record?.metadata?.terminal_marker).toBe(
				"interrupted_external_process_exit",
			);
		}
		expect((await new FileSessionService(dir).listSessions())[0]?.status).toBe(
			expected,
		);
	});

	it("preserves completed and waiting children when their parent is interrupted", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cline-child-reload-"));
		dirs.push(dir);
		vi.stubEnv("CLINE_DATA_DIR", dir);
		vi.stubEnv("CLINE_HOOKS_LOG_PATH", join(dir, "hooks.jsonl"));
		const before = new FileSessionService(dir);
		await before.createRootSessionWithArtifacts({
			sessionId: "parent",
			source: "vscode",
			pid: 999_999_999,
			interactive: true,
			provider: "fixture",
			model: "fixture",
			cwd: dir,
			workspaceRoot: dir,
			enableTools: true,
			enableSpawn: true,
			enableTeams: false,
		});
		for (const [agentId, status] of [
			["done-child", "completed"],
			["waiting-child", "pending"],
			["running-child", "running"],
		] as const) {
			const id = await before.upsertSubagentSession({
				agentId,
				parentAgentId: "parent",
				rootSessionId: "parent",
				conversationId: agentId,
			});
			expect(id).toBeDefined();
			await before.applySubagentStatusBySessionId(id!, status);
		}
		const records = await new FileSessionService(dir).listSessions();
		const statuses = Object.fromEntries(
			records.map((record) => [record.agentId ?? "parent", record.status]),
		);
		expect(statuses).toMatchObject({
			parent: "cancelled",
			"done-child": "completed",
			"waiting-child": "pending",
			"running-child": "cancelled",
		});
	});
});
