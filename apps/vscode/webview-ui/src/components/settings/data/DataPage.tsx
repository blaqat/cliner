import { Input } from "@/components/ui/input"
import { useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { TaskServiceClient, StateServiceClient } from "@/services/grpc-client"
import { Button } from "@/components/ui/button"
import { AdvancedFold } from "../shell/AdvancedFold"
import { SettingRow, ToggleRow, NumberRow } from "../shell/SettingRow"
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
						<p className="text-[11px] text-description">
							Collector headers are masked and managed separately. Reload the extension after changing exporters.
						</p>
					</SettingRow>
					<ToggleRow rowId="data.reporting.openTelemetryEnabled" />
					<SettingRow<string>
						rowId="data.reporting.openTelemetryMetricsExporter"
						control={({ id, value, write, disabled }) => (
							<Input
								id={id}
								disabled={disabled}
								className="h-6 w-40"
								defaultValue={value}
								onBlur={(e) => {
									if (e.target.value !== value) write(e.target.value)
								}}
							/>
						)}
					/>
					<SettingRow<string>
						rowId="data.reporting.openTelemetryLogsExporter"
						control={({ id, value, write, disabled }) => (
							<Input
								id={id}
								disabled={disabled}
								className="h-6 w-40"
								defaultValue={value}
								onBlur={(e) => {
									if (e.target.value !== value) write(e.target.value)
								}}
							/>
						)}
					/>
					<SettingRow<string>
						rowId="data.reporting.openTelemetryTracesExporter"
						control={({ id, value, write, disabled }) => (
							<Input
								id={id}
								disabled={disabled}
								className="h-6 w-40"
								defaultValue={value}
								onBlur={(e) => {
									if (e.target.value !== value) write(e.target.value)
								}}
							/>
						)}
					/>
					<SettingRow<string>
						rowId="data.reporting.openTelemetryOtlpProtocol"
						control={({ id, value, write, disabled }) => (
							<Input
								id={id}
								disabled={disabled}
								className="h-6 w-40"
								defaultValue={value}
								onBlur={(e) => {
									if (e.target.value !== value) write(e.target.value)
								}}
							/>
						)}
					/>
					<SettingRow<string>
						rowId="data.reporting.openTelemetryOtlpEndpoint"
						control={({ id, value, write, disabled }) => (
							<Input
								id={id}
								disabled={disabled}
								className="h-6 w-40"
								defaultValue={value}
								onBlur={(e) => {
									if (e.target.value !== value) write(e.target.value)
								}}
							/>
						)}
					/>
					<SettingRow<string>
						rowId="data.reporting.openTelemetryOtlpMetricsProtocol"
						control={({ id, value, write, disabled }) => (
							<Input
								id={id}
								disabled={disabled}
								className="h-6 w-40"
								defaultValue={value}
								onBlur={(e) => {
									if (e.target.value !== value) write(e.target.value)
								}}
							/>
						)}
					/>
					<SettingRow<string>
						rowId="data.reporting.openTelemetryOtlpMetricsEndpoint"
						control={({ id, value, write, disabled }) => (
							<Input
								id={id}
								disabled={disabled}
								className="h-6 w-40"
								defaultValue={value}
								onBlur={(e) => {
									if (e.target.value !== value) write(e.target.value)
								}}
							/>
						)}
					/>
					<SettingRow<string>
						rowId="data.reporting.openTelemetryOtlpLogsProtocol"
						control={({ id, value, write, disabled }) => (
							<Input
								id={id}
								disabled={disabled}
								className="h-6 w-40"
								defaultValue={value}
								onBlur={(e) => {
									if (e.target.value !== value) write(e.target.value)
								}}
							/>
						)}
					/>
					<SettingRow<string>
						rowId="data.reporting.openTelemetryOtlpLogsEndpoint"
						control={({ id, value, write, disabled }) => (
							<Input
								id={id}
								disabled={disabled}
								className="h-6 w-40"
								defaultValue={value}
								onBlur={(e) => {
									if (e.target.value !== value) write(e.target.value)
								}}
							/>
						)}
					/>
					<NumberRow
						rowId="data.reporting.openTelemetryMetricExportInterval"
						invalid="A positive whole number"
						parse={(s) => (/^\d+$/.test(s) && Number(s) > 0 ? Number(s) : undefined)}
					/>
					<ToggleRow rowId="data.reporting.openTelemetryOtlpInsecure" />
					<NumberRow
						rowId="data.reporting.openTelemetryLogBatchSize"
						invalid="A positive whole number"
						parse={(s) => (/^\d+$/.test(s) && Number(s) > 0 ? Number(s) : undefined)}
					/>
					<NumberRow
						rowId="data.reporting.openTelemetryLogBatchTimeout"
						invalid="A positive whole number"
						parse={(s) => (/^\d+$/.test(s) && Number(s) > 0 ? Number(s) : undefined)}
					/>
					<NumberRow
						rowId="data.reporting.openTelemetryLogMaxQueueSize"
						invalid="A positive whole number"
						parse={(s) => (/^\d+$/.test(s) && Number(s) > 0 ? Number(s) : undefined)}
					/>
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
