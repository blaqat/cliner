import { useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { TaskServiceClient, StateServiceClient } from "@/services/grpc-client"
import { Button } from "@/components/ui/button"
import { AdvancedFold } from "../shell/AdvancedFold"
import { SettingRow, ToggleRow } from "../shell/SettingRow"
export function DataPage() {
	const { navigateToHistory, remoteConfigSettings } = useExtensionState()
	const [confirm, setConfirm] = useState<string>()
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState("")
	async function run(kind: string) {
		setBusy(true)
		setError("")
		try {
			if (kind === "history") await TaskServiceClient.deleteAllTaskHistory({})
			else await StateServiceClient.resetState({ metadata: undefined, global: true })
			setConfirm(undefined)
		} catch {
			setError("Could not finish. Your data is still available. Try again.")
		} finally {
			setBusy(false)
		}
	}
	return (
		<>
			<ToggleRow<string>
				rowId="data.reporting"
				isOn={(v) => v !== "disabled"}
				toValue={(on) => (on ? "enabled" : "disabled")}>
				<AdvancedFold featureId="data.reporting" summary="OpenTelemetry">
					<SettingRow rowId="data.reporting.otel">
						<dl className="text-[11px] text-description break-all">
							{Object.entries(remoteConfigSettings ?? {})
								.filter(([key]) => key.startsWith("openTelemetry"))
								.map(([key, value]) => (
									<div key={key}>
										<dt>{key.replace("openTelemetry", "")}</dt>
										<dd className="m-0">
											{/headers/i.test(key) ? "Managed headers, values hidden" : String(value)}
										</dd>
									</div>
								))}
						</dl>
					</SettingRow>
				</AdvancedFold>
			</ToggleRow>
			{["history", "reset"].map((kind) => (
				<SettingRow
					key={kind}
					rowId={`data.${kind}`}
					control={({ id }) => (
						<div className="flex gap-2">
							{kind === "history" && (
								<Button size="sm" variant="secondary" onClick={navigateToHistory}>
									Export…
								</Button>
							)}
							<Button id={id} size="sm" variant="secondary" onClick={() => setConfirm(kind)}>
								{kind === "history" ? "Clear…" : "Reset…"}
							</Button>
						</div>
					)}>
					{confirm === kind && (
						<div className="mt-2 rounded border border-warning p-2 text-[11px]">
							<p>
								{kind === "history"
									? "Clear all threads and checkpoints? This cannot be undone. Settings and notebook stay."
									: "Reset extension state? This cannot be undone."}
							</p>
							<Button disabled={busy} size="sm" onClick={() => void run(kind)}>
								Confirm {kind === "history" ? "clear" : "reset"}
							</Button>
							<Button disabled={busy} size="sm" variant="ghost" onClick={() => setConfirm(undefined)}>
								Cancel
							</Button>
						</div>
					)}
				</SettingRow>
			))}
			{error && <p role="alert">{error}</p>}
		</>
	)
}
