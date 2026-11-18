/** Compact transcript view for SDK-generated child messages. */
export function SubagentUpdateRow({ text }: { text: string }) {
	const sideNotes = [...text.matchAll(/<side_thread_update thread="([^"]+)">\s*([\s\S]*?)\s*<\/side_thread_update>/g)]
	if (sideNotes.length)
		return (
			<div>
				{sideNotes.map(([, thread, body], index) => (
					<details className="text-sm opacity-80" key={`${thread}-${index}`}>
						<summary>Aside {thread} says…</summary>
						<pre className="whitespace-pre-wrap">
							{body.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")}
						</pre>
					</details>
				))}
			</div>
		)
	const updates = [...text.matchAll(/<subagent_update agent="([^"]+)" status="([^"]+)">\s*([\s\S]*?)\s*<\/subagent_update>/g)]
	if (!updates.length)
		return (
			<details className="text-sm opacity-80">
				<summary>Subagent update</summary>
				<pre className="whitespace-pre-wrap">{text}</pre>
			</details>
		)
	return (
		<div>
			{updates.map(([, agent, status, body], index) => (
				<details className="text-sm opacity-80" key={`${agent}-${index}`}>
					<summary>
						Subagent {agent} {status === "done" ? "finished" : status === "message" ? "says…" : status}
					</summary>
					<pre className="whitespace-pre-wrap">{body}</pre>
				</details>
			))}
		</div>
	)
}
