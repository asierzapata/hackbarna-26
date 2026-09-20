---
name: galtea
description: Set up Galtea specifications, generated test datasets, and before/after AI product evaluations using the official Galtea CLI.
---

If the local upstream checkout exists, read `.devin/galtea-skill/skills/galtea/SKILL.md` and resolve its references from that directory. Otherwise, consult the official skill using `gh api repos/Galtea-AI/skills/contents/skills/galtea/SKILL.md -H 'Accept: application/vnd.github.raw+json'`. The upstream checkout is optional local tooling, not a required submodule.

Verify command schemas with `node scripts/galtea.mjs <resource> <verb> --help` before calling the API. Use JSON on stdin for write commands. Dataset generation and evaluation spend credits; check the organization's credit status first. Preserve existing versions and test cases, use synthetic data, and poll asynchronous evaluations to terminal status. Keep application failures separate from evaluator failures and never replace first-pass failures with successful retries.

In this project, `node scripts/galtea.mjs <arguments>` runs the pinned Galtea CLI and loads the API key from the gitignored root `.env.local`. It accepts `GALTEA_API_KEY` or `GALTEA`. Never print the key, enable verbose HTTP logging, or send real meeting data during synthetic evaluation.
