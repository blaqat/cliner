import {
	applyCompatibleRequestIntent,
	applyNativeRequestIntent,
	resolveProviderRegistrationSync,
	getGeneratedModelsForRuntimeProvider,
	toGatewayModelCapabilities,
	type ModelRequestIntent,
} from "@cline/llms";
import type {
	SubagentModelConnection,
	SubagentModelPolicyV1,
} from "../../../types/config";
import type { SpawnAgentInput } from "../../../extensions/tools/team/spawn-agent-tool";
import type { SubagentProfileSelection } from "./spawn-tool";

const policyModelName = (policy: SubagentModelPolicyV1, id: string): string =>
	policy.models[id]?.name ?? policy.unavailable?.[id]?.name ?? id;

/**
 * What the parent reads and can pass back. An internal id says nothing to it, so a model reads as its name.
 * The id only joins a name two models share, since it's then the only thing that tells them apart.
 */
export function describeAllowedModels(
	policy: SubagentModelPolicyV1,
	entries: SubagentModelPolicyV1["allowed"] = policy.allowed,
): string {
	const names = [
		...Object.values(policy.models).map((m) => m.name),
		...Object.values(policy.unavailable ?? {}).map((m) => m.name),
	];
	return entries
		.map((e) => {
			const name = policyModelName(policy, e.model);
			const shared = names.filter((n) => n === name).length > 1;
			return `${shared ? `${name} [id: ${e.model}]` : name} (${e.levels.join(", ")})`;
		})
		.join(", ");
}

/** The default as the parent knows it: by name, not by id. */
export function describeDefaultSubagentModel(
	policy: SubagentModelPolicyV1,
): string {
	return `${policyModelName(policy, policy.default.model)} at ${policy.default.level}`;
}

export function selectSubagentModel(
	input: Pick<SpawnAgentInput, "model" | "profile" | "reasoningEffort">,
	policy: SubagentModelPolicyV1,
	parent: SubagentModelConnection,
): SubagentProfileSelection {
	const unavailable = (id: string) => {
		const broken = policy.unavailable?.[id];
		return broken
			? `Model "${broken.name}" can't run: ${broken.reason}`
			: "A model on the allowed list is no longer set up. Open Settings > Models to fix it.";
	};
	const levelUnavailable = (name: string, level: string) =>
		`Saved level is unavailable: ${name} doesn't offer "${level}". Open Settings > Subagents to fix it.`;
	if (input.profile !== undefined)
		return {
			error: "The profile parameter is no longer supported. Use model instead.",
		};
	try {
		if (
			new Set(policy.allowed.map((e) => e.model)).size !==
				policy.allowed.length ||
			policy.version !== 1 ||
			!["never", "parent-decides", "always"].includes(policy.blocking)
		)
			throw new Error("Invalid subagent model policy.");
		for (const [id, record] of Object.entries(policy.models)) {
			if (
				id === "parent" ||
				id !== record.id ||
				new Set(record.levels.map((l) => l.id)).size !== record.levels.length ||
				record.levels.some((l) => !Number.isFinite(l.rank))
			)
				throw new Error("Invalid subagent model policy.");
		}
		const resolve = (
			id: string,
			savedLevel: string,
			isDefault = false,
		): SubagentProfileSelection => {
			let level = savedLevel;
			let record = id === "parent" ? undefined : policy.models[id];
			if (id !== "parent" && !record) throw new Error(unavailable(id));
			if (id === "parent" && level === "inherit") {
				return {
					profileId: id,
					profileName: id,
					reasoningEffort: parent.reasoningEffort,
					overrides: {},
				};
			}
			if (id === "parent") {
				const known =
					parent.knownModels?.[parent.modelId] ??
					parent.providerConfig?.knownModels?.[parent.modelId] ??
					parent.providerConfig?.modelInfo ??
					getGeneratedModelsForRuntimeProvider(parent.providerId)?.[
						parent.modelId
					];
				const efforts =
					known?.reasoningOptions?.flatMap((o) =>
						o.type === "effort" ? o.values : [],
					) ?? [];
				const offered = (id: string) =>
					parent.providerConfig?.settingsModelLevels?.find((l) => l.id === id);
				if (!offered(level) && !efforts.some((e) => e === level)) {
					// The parent changes per thread, so a saved default can't name a level
					// for every model. It runs at the model's default; never above it.
					if (level !== "default" && !isDefault)
						throw new Error(levelUnavailable("the parent model", level));
					level = "default";
				}
				const runtimeLevel = offered(level);
				record = {
					id: "thread",
					name: "parent",
					connection: parent,
					levels: [
						{
							id: level,
							label: level,
							rank: 0,
							request:
								runtimeLevel?.request ??
								(level === "default"
									? { kind: "default" }
									: { kind: "effort", value: level }),
						},
					],
				};
			}
			const selected = record!.levels.find((l) => l.id === level);
			if (!selected) throw new Error(levelUnavailable(record!.name, level));
			const connection = record!.connection;
			const pc = {
				...connection.providerConfig,
				providerId: connection.providerId,
				modelId: connection.modelId,
			};
			const intent: ModelRequestIntent = {
				temperature: connection.temperature ?? null,
				verbosity: null,
				maxOutputTokens: connection.maxTokensPerTurn ?? null,
				thinkingBudgetTokens: null,
				systemRole: "system",
				extraBody: {},
				...pc.settingsRequestIntent,
				level: selected.request,
			};
			const compatible =
				pc.providerId === "openai-compatible" ||
				pc.clientType === "openai-compatible";
			const overrides = {
				apiKey: undefined,
				baseUrl: undefined,
				headers: undefined,
				onAuthError: undefined,
				knownModels: undefined,
				temperature: undefined,
				maxTokensPerTurn: undefined,
				...connection,
				thinking: undefined,
				reasoningEffort: undefined,
				thinkingBudgetTokens: undefined,
				providerConfig: {
					...pc,
					reasoningEffort: undefined,
					thinkingBudgetTokens: undefined,
					thinking: undefined,
				},
			} as SubagentModelConnection;
			if (pc.settingsFetchAtLevel) {
				// The connection's fetch already applies its own level. Build it at the
				// selected one rather than wrapping it, or that level is sent instead.
				overrides.providerConfig!.fetch = pc.settingsFetchAtLevel(
					selected.request,
				);
			} else if (compatible) {
				const format =
					pc.routingProviderId === "openai-native" ? "responses" : "chat";
				applyCompatibleRequestIntent({}, format, intent);
				const transport = pc.fetch ?? globalThis.fetch;
				overrides.providerConfig!.fetch = (async (url, init) => {
					if (typeof init?.body !== "string") return transport(url, init);
					return transport(url, {
						...init,
						body: JSON.stringify(
							applyCompatibleRequestIntent(
								JSON.parse(init.body),
								format,
								intent,
							),
						),
					});
				}) as typeof fetch;
			} else {
				const registration = resolveProviderRegistrationSync(pc);
				const known =
					connection.knownModels?.[connection.modelId] ??
					pc.knownModels?.[connection.modelId] ??
					pc.modelInfo ??
					getGeneratedModelsForRuntimeProvider(connection.providerId)?.[
						connection.modelId
					];
				const model = known
					? {
							...known,
							capabilities: toGatewayModelCapabilities(known.capabilities),
							metadata: {
								family: known.family,
								reasoningDefaultOn: known.metadata?.reasoningDefaultOn,
							},
							id: connection.modelId,
							name: known.name ?? connection.modelId,
							providerId: connection.providerId,
						}
					: registration?.manifest.models.find(
							(m) => m.id === connection.modelId,
						);
				if (!model) {
					if (selected.request.kind !== "default")
						throw new Error(levelUnavailable(record!.name, level));
				} else {
					const request = applyNativeRequestIntent(
						{
							providerId: connection.providerId,
							modelId: connection.modelId,
							messages: [],
						},
						{
							provider: registration?.manifest ?? {
								id: connection.providerId,
								name: connection.providerId,
								defaultModelId: connection.modelId,
								models: [model],
							},
							model,
							config: { providerId: connection.providerId },
						},
						intent,
					);
					overrides.reasoningEffort = request.reasoning?.effort;
					overrides.thinkingBudgetTokens = request.reasoning?.budgetTokens;
					overrides.thinking = request.reasoning?.enabled;
				}
				overrides.providerConfig!.settingsRequestIntent = intent;
			}
			return {
				profileId: id,
				profileName: record!.name,
				reasoningEffort: level,
				overrides,
			};
		};
		const usable = (entries: SubagentModelPolicyV1["allowed"]) =>
			entries.flatMap((entry) => {
				const known = policy.models[entry.model];
				if (entry.model === "parent") return [entry];
				if (!known) return [];
				const levels = entry.levels.filter((id) =>
					known.levels.some((l) => l.id === id),
				);
				return levels.length ? [{ ...entry, levels }] : [];
			});
		const describe = (entries: SubagentModelPolicyV1["allowed"]) =>
			describeAllowedModels(policy, entries);
		const nameOf = (modelId: string) => policyModelName(policy, modelId);
		const explicit =
			input.model !== undefined || input.reasoningEffort !== undefined;
		// A stale default or allowed entry only affects a call that asks for it.
		if (!explicit) {
			try {
				return resolve(policy.default.model, policy.default.level, true);
			} catch (error) {
				const others = usable(policy.allowed);
				throw new Error(
					`The default subagent model can't start. ${error instanceof Error ? error.message : String(error)}${
						others.length
							? ` Pass model to use one of these instead: ${describe(others)}.`
							: ""
					}`,
				);
			}
		}
		if (!policy.allowed.length)
			return {
				error:
					"A model and level can't be chosen here. Omit them to use the default.",
			};
		const allowed = policy.allowed.map((e) => ({
			...e,
			levels: [...e.levels],
		}));
		const defaultEntry = allowed.find((e) => e.model === policy.default.model);
		if (defaultEntry) {
			if (!defaultEntry.levels.includes(policy.default.level))
				defaultEntry.levels.push(policy.default.level);
		} else
			allowed.push({
				model: policy.default.model,
				levels: [policy.default.level],
			});
		let id = input.model ?? policy.default.model;
		if (
			!(id in policy.models) &&
			!(id in (policy.unavailable ?? {})) &&
			id !== "parent"
		) {
			// A model can be asked for by its name or the id its provider knows it by.
			const named = [
				...Object.values(policy.models).map((m) => ({
					id: m.id,
					name: m.name,
					upstream: m.connection.modelId,
				})),
				...Object.entries(policy.unavailable ?? {}).map(
					([modelId, broken]) => ({
						id: modelId,
						name: broken.name,
						upstream: undefined,
					}),
				),
			].filter((m) => m.name === id || m.upstream === id);
			if (named.length > 1)
				return {
					error: `Model name "${id}" is ambiguous. Pass the model id: ${named.map((m) => `${m.name} (${m.id})`).join(", ")}.`,
				};
			if (named.length === 1) id = named[0]!.id;
		}
		const entry = allowed.find((e) => e.model === id);
		if (!entry)
			return {
				error: `Model "${input.model}" is not allowed. Allowed: ${describe(usable(allowed))}. Omit model to use the default: ${describeDefaultSubagentModel(policy)}.`,
			};
		if (id !== "parent" && !policy.models[id])
			return { error: unavailable(id) };
		const parentRanks = [
			"default",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		];
		const rank = (level: string): number => {
			if (id !== "parent")
				return (
					policy.models[id]!.levels.find((l) => l.id === level)?.rank ??
					Infinity
				);
			const inherited = parent.providerConfig?.settingsRequestIntent?.level;
			const runtimeLevel = parent.providerConfig?.settingsModelLevels?.find(
				(l) => l.id === level,
			);
			if (runtimeLevel) return runtimeLevel.rank;
			if (level === "inherit") {
				const currentRequest =
					inherited ??
					(parent.reasoningEffort
						? { kind: "effort", value: parent.reasoningEffort }
						: { kind: "default" });
				const currentLevel = parent.providerConfig?.settingsModelLevels?.find(
					(l) => JSON.stringify(l.request) === JSON.stringify(currentRequest),
				);
				if (currentLevel) return currentLevel.rank;
				return inherited?.kind === "effort"
					? parentRanks.indexOf(inherited.value)
					: parentRanks.indexOf(parent.reasoningEffort ?? "default");
			}
			return parentRanks.indexOf(level);
		};
		const levels = [...entry.levels].sort((a, b) => rank(a) - rank(b));
		if (input.reasoningEffort !== undefined) {
			if (!levels.includes(input.reasoningEffort))
				return {
					error: `Reasoning effort "${input.reasoningEffort}" is not allowed for ${nameOf(id)}. Allowed: ${entry.levels.join(", ")}.`,
				};
			return resolve(id, input.reasoningEffort);
		}
		// Named with no level: the lowest allowed one this model still offers.
		let lastError: unknown = new Error(
			`No level is allowed for ${nameOf(id)}. Open Settings > Subagents to fix it.`,
		);
		for (const level of levels) {
			try {
				return resolve(id, level);
			} catch (error) {
				lastError = error;
			}
		}
		throw lastError;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			error: /Open Settings/.test(message)
				? message
				: `${message.replace(/\.$/, "")}. Open Settings > Subagents to fix it.`,
		};
	}
}
