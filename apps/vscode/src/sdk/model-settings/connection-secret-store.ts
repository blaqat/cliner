import type { SecretStorage } from "vscode"

export interface ConnectionSecretStore {
	get(ref: string): Promise<string | undefined>
	set(ref: string, value: string): Promise<void>
	delete(ref: string): Promise<void>
}
function validateRef(ref: string): void {
	if (!/^settings:v1:connection:[^:]+:.+$/.test(ref)) throw new Error("Invalid connection secret reference")
}
export class VSCodeConnectionSecretStore implements ConnectionSecretStore {
	constructor(private readonly storage: Pick<SecretStorage, "get" | "store" | "delete">) {}
	async get(ref: string) {
		validateRef(ref)
		return this.storage.get(ref)
	}
	async set(ref: string, value: string) {
		validateRef(ref)
		await this.storage.store(ref, value)
	}
	async delete(ref: string) {
		validateRef(ref)
		await this.storage.delete(ref)
	}
}
export class InMemoryConnectionSecretStore implements ConnectionSecretStore {
	private readonly values = new Map<string, string>()
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
