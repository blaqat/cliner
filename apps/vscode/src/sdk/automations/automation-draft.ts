import { type AutomationDefinition, emptyAutomation } from "@shared/automations"
import { parseAutomationFile } from "./automation-file"

/** The longest description sent to the model. */
const MAX_DESCRIPTION_CHARS = 4000

export const DRAFT_SYSTEM_PROMPT = `You turn a short description of a repeatable coding workflow into an automation file for Cline.
Reply with only the file, no commentary, no code fence around it. The file format:

---
name: lowercase-name-with-dashes
title: Short Title
description: One line on what it does
arguments:
  - name: ticket
    kind: ticket        # text | ticket | branch | choice
    required: true
    description: The ticket key
  - name: depth
    kind: choice
    choices: [quick, thorough]
    default: quick
---

## Open the task
- id: task
- kind: task
- ticket: {{ticket}}

## Research
- id: research
- kind: thread
- model: default
- mode: ask

Read {{ticket}} and the code it touches. End with a short summary of what you found.

## Review
- id: review
- kind: together

Review this plan and list risks:

{{steps.research}}

### Review A
- id: review-a
- model: default
- mode: ask

### Review B
- id: review-b
- model: default
- mode: ask

## Pick one
- id: pick
- kind: checkpoint
- choices from: review

Which review should the build follow?

## Build
- id: build
- kind: thread
- model: default
- mode: act
- worktree: new

Build it following:

{{steps.pick}}

Rules:
- Step kinds: task (find or open the task for a ticket; only as the first step), thread (one prompt thread), together (two or more ### threads that run at the same time; each may have its own prompt, otherwise they share the step's prompt), checkpoint (waits for the user to pick; "choices from: <together id>" offers that group's threads, or "choices: A, B").
- mode is ask (reads and answers) or act (edits files). Use act only for steps that change code, and give those "worktree: new".
- Write "model: default" unless the description names a model. Only add "level:" when the description asks for one.
- {{name}} fills in an argument; {{steps.id}} fills in an earlier step's final reply. Never refer to a later step.
- Every id is lowercase letters, digits and dashes, unique across the file.
- If you had to guess something important, add one line per guess at the very end, after the steps, starting with "GUESS: ".`

export interface AutomationDraft {
	definition: AutomationDefinition
	guesses: string[]
}

export function draftPrompt(description: string): string {
	return `Describe-it request:\n${description.trim().slice(0, MAX_DESCRIPTION_CHARS)}`
}

/** Reads a model's reply into a definition the builder can open, problems and all. */
export function parseDraftReply(reply: string): AutomationDraft {
	const lines = reply.replace(/\r\n/g, "\n").split("\n")
	const guesses = lines.filter((line) => line.startsWith("GUESS: ")).map((line) => line.slice("GUESS: ".length).trim())
	let text = lines
		.filter((line) => !line.startsWith("GUESS: "))
		.join("\n")
		.trim()
	// Models wrap files in a fence despite being asked not to.
	const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/.exec(text)
	if (fenced) text = fenced[1].trim()
	const start = text.indexOf("---")
	if (start > 0) text = text.slice(start)
	const parsed = parseAutomationFile(text, "new-automation")
	return { definition: parsed.draft ?? { ...emptyAutomation(), description: "" }, guesses }
}
