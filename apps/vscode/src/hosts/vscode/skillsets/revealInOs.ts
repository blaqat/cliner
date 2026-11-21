import * as vscode from "vscode"

/** Shows a file in Finder / File Explorer / the file manager, selected. */
export async function revealInOs(filePath: string): Promise<void> {
	await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(filePath))
}
