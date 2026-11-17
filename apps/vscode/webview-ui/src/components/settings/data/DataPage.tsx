import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { StateServiceClient, TaskServiceClient } from "@/services/grpc-client"
import { AdvancedFold } from "../shell/AdvancedFold"
import { NumberRow, SettingGroup, SettingRow, ToggleRow } from "../shell/SettingRow"
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
			<SettingGroup title="Reporting">
				<ToggleRow<string>
					isOn={(v) => v !== "disabled"}
					rowId="data.reporting"
					toValue={(on) => (on ? "enabled" : "disabled")}>
					<AdvancedFold featureId="data.reporting" summary="OpenTelemetry">
						<SettingRow rowId="data.reporting.otel">
							<p className="text-[12px] text-description">
								Collector headers are masked and managed separately. Reload the extension after changing
								exporters.
							</p>
						</SettingRow>
						<ToggleRow rowId="data.reporting.openTelemetryEnabled" />
						<SettingRow<string>
							control={({ id, value, write, disabled }) => (
								<Input
									className="h-6 w-40"
									defaultValue={value}
									disabled={disabled}
									id={id}
									onBlur={(e) => {
										if (e.target.value !== value) write(e.target.value)
									}}
								/>
							)}
							rowId="data.reporting.openTelemetryMetricsExporter"
						/>
						<SettingRow<string>
							control={({ id, value, write, disabled }) => (
								<Input
									className="h-6 w-40"
									defaultValue={value}
									disabled={disabled}
									id={id}
									onBlur={(e) => {
										if (e.target.value !== value) write(e.target.value)
									}}
								/>
							)}
							rowId="data.reporting.openTelemetryLogsExporter"
						/>
						<SettingRow<string>
							control={({ id, value, write, disabled }) => (
								<Input
									className="h-6 w-40"
									defaultValue={value}
									disabled={disabled}
									id={id}
									onBlur={(e) => {
										if (e.target.value !== value) write(e.target.value)
									}}
								/>
							)}
							rowId="data.reporting.openTelemetryTracesExporter"
						/>
						<SettingRow<string>
							control={({ id, value, write, disabled }) => (
								<Input
									className="h-6 w-40"
									defaultValue={value}
									disabled={disabled}
									id={id}
									onBlur={(e) => {
										if (e.target.value !== value) write(e.target.value)
									}}
								/>
							)}
							rowId="data.reporting.openTelemetryOtlpProtocol"
						/>
						<SettingRow<string>
							control={({ id, value, write, disabled }) => (
								<Input
									className="h-6 w-40"
									defaultValue={value}
									disabled={disabled}
									id={id}
									onBlur={(e) => {
										if (e.target.value !== value) write(e.target.value)
									}}
								/>
							)}
							rowId="data.reporting.openTelemetryOtlpEndpoint"
						/>
						<SettingRow<string>
							control={({ id, value, write, disabled }) => (
								<Input
									className="h-6 w-40"
									defaultValue={value}
									disabled={disabled}
									id={id}
									onBlur={(e) => {
										if (e.target.value !== value) write(e.target.value)
									}}
								/>
							)}
							rowId="data.reporting.openTelemetryOtlpMetricsProtocol"
						/>
						<SettingRow<string>
							control={({ id, value, write, disabled }) => (
								<Input
									className="h-6 w-40"
									defaultValue={value}
									disabled={disabled}
									id={id}
									onBlur={(e) => {
										if (e.target.value !== value) write(e.target.value)
									}}
								/>
							)}
							rowId="data.reporting.openTelemetryOtlpMetricsEndpoint"
						/>
						<SettingRow<string>
							control={({ id, value, write, disabled }) => (
								<Input
									className="h-6 w-40"
									defaultValue={value}
									disabled={disabled}
									id={id}
									onBlur={(e) => {
										if (e.target.value !== value) write(e.target.value)
									}}
								/>
							)}
							rowId="data.reporting.openTelemetryOtlpLogsProtocol"
						/>
						<SettingRow<string>
							control={({ id, value, write, disabled }) => (
								<Input
									className="h-6 w-40"
									defaultValue={value}
									disabled={disabled}
									id={id}
									onBlur={(e) => {
										if (e.target.value !== value) write(e.target.value)
									}}
								/>
							)}
							rowId="data.reporting.openTelemetryOtlpLogsEndpoint"
						/>
						<NumberRow
							invalid="A positive whole number"
							parse={(s) => (/^\d+$/.test(s) && Number(s) > 0 ? Number(s) : undefined)}
							rowId="data.reporting.openTelemetryMetricExportInterval"
						/>
						<ToggleRow rowId="data.reporting.openTelemetryOtlpInsecure" />
						<NumberRow
							invalid="A positive whole number"
							parse={(s) => (/^\d+$/.test(s) && Number(s) > 0 ? Number(s) : undefined)}
							rowId="data.reporting.openTelemetryLogBatchSize"
						/>
						<NumberRow
							invalid="A positive whole number"
							parse={(s) => (/^\d+$/.test(s) && Number(s) > 0 ? Number(s) : undefined)}
							rowId="data.reporting.openTelemetryLogBatchTimeout"
						/>
						<NumberRow
							invalid="A positive whole number"
							parse={(s) => (/^\d+$/.test(s) && Number(s) > 0 ? Number(s) : undefined)}
							rowId="data.reporting.openTelemetryLogMaxQueueSize"
						/>
					</AdvancedFold>
				</ToggleRow>
			</SettingGroup>
			<SettingGroup title="Your data">
				{["history", "reset"].map((kind) => (
					<SettingRow
						control={({ id }) => (
							<div className="flex gap-2">
								{kind === "history" && (
									<Button onClick={navigateToHistory} size="sm" variant="secondary">
										Export…
									</Button>
								)}
								<Button id={id} onClick={() => setConfirm(kind)} size="sm" variant="secondary">
									{kind === "history" ? "Clear…" : "Reset…"}
								</Button>
							</div>
						)}
						key={kind}
						rowId={`data.${kind}`}>
						{confirm === kind && (
							<div className="mt-2 rounded border border-warning p-2 text-[12px]">
								<p>
									{kind === "history"
										? "Clear all threads and checkpoints? This cannot be undone. Settings and notebook stay."
										: "Reset all extension settings? This removes every connection and model, the keys saved for them, and all other settings. This cannot be undone."}
								</p>
								<Button disabled={busy} onClick={() => void run(kind)} size="sm">
									Confirm {kind === "history" ? "clear" : "reset"}
								</Button>
								<Button disabled={busy} onClick={() => setConfirm(undefined)} size="sm" variant="ghost">
									Cancel
								</Button>
							</div>
						)}
					</SettingRow>
				))}
			</SettingGroup>
			{error && <p role="alert">{error}</p>}
		</>
	)
}
