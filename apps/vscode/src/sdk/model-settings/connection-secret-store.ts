import type { SecretStorage } from "vscode"

export interface ConnectionSecretStore {
	get(ref: string): Promise<string | undefined>
	set(ref: string, value: string): Promise<void>
	delete(ref: string): Promise<void>
	/** Every reference saved through this store, so a reset also finds ones no connection names any more. */
	list(): Promise<string[]>
}
const REFERENCE_LEDGER = "settings:v1:connection-references"
function validateRef(ref: string): void {
	if (!/^settings:v1:connection:[^:]+:.+$/.test(ref)) throw new Error("Invalid connection secret reference")
}
export class VSCodeConnectionSecretStore implements ConnectionSecretStore {
	private ledger: Promise<unknown> = Promise.resolve()
	constructor(private readonly storage: Pick<SecretStorage, "get" | "store" | "delete">) {}
	/** VS Code can't enumerate its secrets, so the store keeps its own list. One at a time: each change rewrites it. */
	private updateLedger(change: (refs: Set<string>) => void): Promise<void> {
		const next = this.ledger.then(async () => {
			const refs = new Set(await this.list())
			change(refs)
			if (refs.size) await this.storage.store(REFERENCE_LEDGER, JSON.stringify([...refs]))
			else await this.storage.delete(REFERENCE_LEDGER)
		})
		this.ledger = next.catch(() => {})
		return next
	}
	async list() {
		try {
			const refs = JSON.parse((await this.storage.get(REFERENCE_LEDGER)) ?? "[]")
			return Array.isArray(refs) ? refs.filter((ref): ref is string => typeof ref === "string") : []
		} catch {
			return []
		}
	}
	async get(ref: string) {
		validateRef(ref)
		return this.storage.get(ref)
	}
	async set(ref: string, value: string) {
		validateRef(ref)
		await this.updateLedger((refs) => refs.add(ref))
		await this.storage.store(ref, value)
	}
	async delete(ref: string) {
		validateRef(ref)
		await this.storage.delete(ref)
		await this.updateLedger((refs) => refs.delete(ref))
	}
}
export class InMemoryConnectionSecretStore implements ConnectionSecretStore {
	private readonly values = new Map<string, string>()
	async list() {
		return [...this.values.keys()]
	}
	async get(ref: string) {
		validateRef(ref)
		return this.values.get(ref)
	}
	async set(ref: string, value: string) {
		validateRef(ref)
		this.values.set(ref, value)
	}
	async delete(ref: string) {
		validateRef(ref)
		this.values.delete(ref)
	}
}
