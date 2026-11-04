import type { SubagentPick, AllowedSubagentModel } from "@shared/model-settings"
import type { ModelSettingsState } from "@shared/model-settings-state"
import { ModelsServiceClient } from "@/services/grpc-client"
import {
	preference,
	POLICY_DEFAULTS,
	updateSubagentPolicy,
	policyOf,
	onlyWithSubagents,
	SUBAGENT_ACCESS,
} from "../shell/rowFactories"
export const SUBAGENTS_ROWS = [
	preference<string>({
		id: "subagents.blocking",
		label: "Can block the parent",
		description:
			"Never removes waiting tools. Parent decides lets it choose. Always wait holds the parent until helpers finish.",
		defaultValue: () => "parent-decides",
		read: (ctx) => policyOf(ctx).blocking ?? "parent-decides",
		write: (value) => updateSubagentPolicy((p) => ({ ...p, blocking: value as typeof p.blocking })),
		disabledReason: onlyWithSubagents,
	}),
	preference<SubagentPick>({
		id: "subagents.default",
		label: "Default model and level",
		description: "What a helper runs on unless the parent picks from your list.",
		defaultValue: () => ({ kind: "thread", level: "inherit" }),
		read: (ctx) => ctx.state.modelSettings?.settings.roles?.subagents ?? { kind: "thread", level: "inherit" },
		write: async (value) => {
			const latest = JSON.parse((await ModelsServiceClient.getModelSettings({ json: "{}" })).json) as ModelSettingsState
			await ModelsServiceClient.setModelRoles({
				json: JSON.stringify({
					expectedRevision: latest.settings.revision,
					roles: { ...latest.settings.roles, subagents: value },
				}),
			})
		},
		disabledReason: onlyWithSubagents,
	}),
	preference<AllowedSubagentModel[]>({
		id: "subagents.allowed",
		parent: "subagents.default",
		label: "Models the parent can choose",
		description:
			"With an empty list, the helper uses the default. A model without a level uses its lowest allowed level. Off-list picks are refused.",
		defaultValue: () => [],
		read: (ctx) => policyOf(ctx).allowed ?? [],
		write: (allowed) => updateSubagentPolicy((p) => ({ ...p, allowed })),
		disabledReason: onlyWithSubagents,
	}),
	preference<boolean>({
		id: "subagents.enabled",
		label: "Subagents",
		description: "Main threads and asides can start helpers. Helpers cannot start their own.",
		aliases: ["enable", "spawn", "helpers", "delegate"],
		managedKeys: ["subagentsEnabled"],
		defaultValue: () => POLICY_DEFAULTS.enabled,
		read: (ctx) => policyOf(ctx).enabled,
		write: (value) => updateSubagentPolicy((policy) => ({ ...policy, enabled: value })),
	}),
	preference<number>({
		id: "subagents.cap",
		label: "At most, per thread",
		description: "Past this, the parent is told to wait for one to finish.",
		aliases: ["cap", "limit", "maximum", "concurrent"],
		managedKeys: ["subagentsMaxConcurrent"],
		defaultValue: () => POLICY_DEFAULTS.maxConcurrent,
		read: (ctx) => policyOf(ctx).maxConcurrent,
		write: (value) => updateSubagentPolicy((policy) => ({ ...policy, maxConcurrent: value })),
		format: (value) => (value === 0 ? "Unlimited" : String(value)),
		disabledReason: onlyWithSubagents,
	}),
	...SUBAGENT_ACCESS.map(([key, label, description, managedKey, aliases]) =>
		preference<boolean>({
			id: `subagents.access.${key}`,
			label,
			description,
			aliases: ["access", "permissions", aliases],
			managedKeys: [managedKey],
			defaultValue: () => POLICY_DEFAULTS.access[key],
			read: (ctx) => policyOf(ctx).access[key],
			write: (value) => updateSubagentPolicy((policy) => ({ ...policy, access: { ...policy.access, [key]: value } })),
			disabledReason: onlyWithSubagents,
		}),
	),
]
