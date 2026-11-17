import type { ChangeWalkthrough } from "@shared/Walkthrough"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { createStorybookDecorator } from "@/config/StorybookDecorator"
import { TaskServiceClient } from "@/services/grpc-client"
import WalkthroughView from "./WalkthroughView"

const hunk = (id: string, path: string, patch: string, oldStart: number, newStart: number) => ({
	id,
	fingerprint: `fp-${id}`,
	fileId: `file-${path}`,
	path,
	header: patch.split("\n")[0],
	patch,
	oldStart,
	newStart,
	external: true,
})

/** A merge request the agent presented with Cline's review: eight notes, one high, one line that isn't in the diff. */
const sample: ChangeWalkthrough = {
	version: 1,
	taskId: "story",
	scope: "authored",
	fingerprint: "story-1",
	source: "authored",
	authoredId: "story",
	origin: { label: "GitHub PR #412", url: "https://github.com/acme/notify/pull/412" },
	title: "Retry failed webhook deliveries",
	focus: "Deliveries now retry up to `MAX_TRIES` times with exponential backoff, and the web app shows a Retrying state.",
	warnings: [],
	chapters: [
		{
			id: "c1",
			title: "Retries",
			stops: [
				{
					id: "s1",
					title: "Retry limits",
					prose: "`MAX_TRIES` and the base delay live next to the dispatcher.",
					hunkIds: ["h1"],
				},
				{
					id: "s2",
					title: "Retry loop with backoff",
					prose: "`deliver` now loops: it returns on success or on the last try, and sleeps `backoff(attempt)` in between.",
					hunkIds: ["h2"],
				},
			],
		},
		{
			id: "c2",
			title: "Web app",
			stops: [{ id: "s3", title: "Show “Retrying” in the app", prose: "A new status value.", hunkIds: ["h3"] }],
		},
	],
	support: [],
	hunks: [
		hunk(
			"h1",
			"server/src/webhooks/limits.ts",
			"@@ -1,2 +1,4 @@\n export const TIMEOUT_MS = 10_000\n+export const MAX_TRIES = 5\n+export const BASE_DELAY_MS = 500\n",
			1,
			1,
		),
		hunk(
			"h2",
			"server/src/webhooks/dispatcher.ts",
			[
				"@@ -38,6 +38,14 @@ export class WebhookDispatcher {",
				" async deliver(hook: Webhook, event: Event) {",
				"-  const res = await this.client.send(request(hook, event))",
				"-  return DeliveryResult.from(res)",
				"+  for (let attempt = 1; ; attempt++) {",
				"+    const res = await this.client.send(request(hook, event))",
				"+    log.info(`try ${attempt}`, res.status)",
				"+    if (res.status < 300 || attempt >= MAX_TRIES) {",
				"+      return DeliveryResult.from(res, attempt)",
				"+    }",
				"+    await sleep(BASE_DELAY_MS * 2 ** (attempt - 1))",
				"+  }",
				" }",
			].join("\n"),
			38,
			38,
		),
		hunk(
			"h3",
			"web/src/api/types.ts",
			'@@ -6,3 +6,4 @@\n export type DeliveryStatus =\n   | "delivered"\n   | "failed"\n+  | "retrying"\n',
			6,
			6,
		),
	],
	review: {
		summary: "Good direction and easy to follow. Fix the 4xx retries before merging; the rest can be follow-ups.",
		notes: [
			{
				id: "n8",
				kind: "suggestion",
				title: "Test the retry path",
				text: "`dispatcher.test.ts` isn't touched. A fake server that returns 503, then 200, would cover the loop.",
			},
			{
				id: "n5",
				kind: "question",
				stopId: "s1",
				title: "Per-hook limit?",
				text: "The PR mentions per-customer retry limits, but `MAX_TRIES` is a constant. Follow-up?",
			},
			{
				id: "n1",
				kind: "risk",
				severity: "high",
				stopId: "s2",
				hunkId: "h2",
				line: 6,
				endLine: 7,
				title: "Retries 4xx responses too",
				text: "Anything ≥ 300 is retried, so a 400, 401 or 410 uses all 5 tries. Retry only 5xx, 408 and 429.",
			},
			{
				id: "n4",
				kind: "nice",
				stopId: "s2",
				hunkId: "h2",
				line: 5,
				title: "Try number in the log",
				text: "Logging each try with its number makes a failed delivery easy to trace.",
			},
			{
				id: "n2",
				kind: "risk",
				stopId: "s2",
				hunkId: "h2",
				line: 9,
				title: "Blocks a worker while waiting",
				text: "A dead endpoint holds the dispatcher for 7.5 s. Schedule the retry instead.",
			},
			{
				id: "n3",
				kind: "suggestion",
				stopId: "s2",
				hunkId: "h2",
				line: 9,
				title: "Add jitter to the backoff",
				text: "Hooks that fail together retry in lockstep. About ±20% jitter spreads them out.",
			},
			{
				id: "n9",
				kind: "question",
				stopId: "s2",
				title: "Honor Retry-After?",
				text: "A 429 often says how long to wait. Use it instead of the backoff when it's there?",
			},
			{
				id: "n10",
				kind: "suggestion",
				stopId: "s2",
				title: "Name the 300",
				text: "An `isSuccess(status)` helper says what `< 300` means.",
			},
			{
				id: "lost",
				kind: "suggestion",
				stopId: "s3",
				hunkId: "h3",
				line: 12,
				title: "Parse the date once",
				text: "Turn `nextAttemptAt` into a `Date` where it's fetched.",
			},
		],
	},
}

let current: ChangeWalkthrough = sample
Object.assign(TaskServiceClient, {
	getChangeWalkthrough: async () => ({ value: JSON.stringify(current) }),
	sendWalkthroughNotes: async () => ({}),
})

function Page({ walk }: { walk: ChangeWalkthrough }) {
	current = walk
	return <WalkthroughView authoredId="story" key={walk.fingerprint} onDone={() => {}} taskId="story" />
}

const meta: Meta<typeof Page> = {
	title: "Views/Walkthrough/Review notes",
	component: Page,
	decorators: [createStorybookDecorator({ clineMessages: [], taskHistory: [], taskGroups: [] }, "max-w-none")],
	parameters: { layout: "fullscreen" },
}

export default meta
type Story = StoryObj<typeof Page>

export const WithReview: Story = { args: { walk: sample } }

export const NothingToFlag: Story = {
	args: { walk: { ...sample, fingerprint: "story-2", review: { summary: "Small and safe.", notes: [] } } },
}
