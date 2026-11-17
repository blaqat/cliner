# Run walkthrough evals

Run commands from `apps/vscode`. These evals are manual and make one paid Generate request per fixture. They never run in the test suite.

Check the four fixed fixtures without a model call:

```sh
bun evals/walkthrough/run.ts --dry-run
```

Exercise the complete runner and provider handler against a local fake API, with no credentials or model cost:

```sh
bun evals/walkthrough/mock-smoke.ts
```

Create a local configuration file outside the repository with the saved profile records you want to compare. Use the same profile IDs, provider names, model IDs, and options as Settings → Profiles. Add credentials under each profile's ID. VS Code's secret storage cannot be read by a standalone process.

```json
{
	"profiles": [
		{
			"id": "eval",
			"name": "Eval",
			"provider": "openai",
			"modelId": "your-model",
			"options": { "openAiBaseUrl": "https://your-endpoint/v1" }
		}
	],
	"secrets": { "eval": { "openAiApiKey": "your-key" } }
}
```

Run Generate against that profile:

```sh
bun evals/walkthrough/run.ts --config /tmp/walkthrough-profiles.json --profile eval --output /tmp/walkthrough-report.json
```

Compare a new run against a previous report:

```sh
bun evals/walkthrough/run.ts --config /tmp/walkthrough-profiles.json --profile eval --baseline /tmp/walkthrough-report.json --output /tmp/walkthrough-next.json
```

The script exits with an error if any case loses more than 10% of its previous score. `score.ts` assigns up to 70 points for structure and 30 for fixture concepts. It checks coverage, duplicate and unknown aliases, size ceilings, semantic titles, and filler. Concept matching is a deterministic approximation; read the saved walkthroughs to judge factual accuracy. Dry-run scores describe the free file-grouped fallback and are not model baselines.

The runner uses the production profile resolver and API handler. A lightweight VS Code shim lets the provider helpers load outside the extension host. Configuration comes only from the supplied file. The runner does not load your real extension settings.
