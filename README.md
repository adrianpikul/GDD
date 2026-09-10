# GDD

**GDD is a local, evidence-driven spec-development workflow for coding agents.** It gives teams a durable place to capture a change's intended outcome, the next verifiable slice of work, and the evidence that supports completion.

GDD does not write application code or send data to a service. It installs local prompts, skills, templates, and a small CLI into the repository you choose, so developers and agents can work from the same record.

## What GDD provides

- A compact lifecycle: **Design → Design Update → Build → Check → Archive**.
- Durable change records under `gdd/changes/<change-id>/`.
- A canonical decomposed work format: a plan, a checkbox index, and a detailed record for every task.
- Generated instructions for Codex-style skills (`.agents/skills/`) and GitHub Copilot prompt files (`.github/prompts/`).
- `status` output for people and JSON automation, plus a guarded archive operation for verified changes.
- Guardrails against unmanaged-file collisions, symbolic links in GDD-managed paths, incomplete checked tasks, and accidental archival.

## Requirements

- Node.js **22.18.0 or later**
- npm

## Get started from this repository

The repository is the supported way to try the current source. Build the CLI, then point it at another project:

```sh
git clone https://github.com/adrianpikul/GDD.git
cd GDD
npm ci
npm run build

# Install both supported integrations into a separate project.
node dist/cli.js init /path/to/your-project --all
```

You can choose one integration instead:

```sh
node dist/cli.js init /path/to/your-project --agents
node dist/cli.js init /path/to/your-project --github
```

Running `gdd init` without a host flag opens an interactive selector. Non-interactive invocations must supply `--agents`, `--github`, or `--all`.

> The unscoped npm name `gdd` is not yet a confirmed distribution channel for this repository. Until an owned package name and release process are announced, use the source workflow above rather than installing an unrelated registry package.

## Your first change

After initialization, start a nontrivial request with the generated **Design** operation. It creates a record such as:

```text
gdd/changes/add-export/
├── change.md          # intent, contract, decisions, parent evidence, and next action
├── plan.md            # task-mapped implementation and verification plan
├── tasks.md           # authoritative completion checklist
└── tasks/
    ├── T001-api.md    # outcome, acceptance/check, evidence, dependencies, next action
    └── T002-docs.md
```

Use the operations in this order:

1. **Design** — inspect the repository and write a reviewable contract and decomposed task plan. It plans only; it does not edit application source.
2. **Design Update** — revise a selected change from feedback while preserving truthful history. It can deliberately migrate an older direct record to the canonical task structure.
3. **Build** — implement the smallest unblocked task, run its check, record actual evidence, then check off that task only.
4. **Check** — verify the completed implementation against the contract without changing the intended requirements.
5. **Archive** — remove one explicitly selected, verified record after confirmation while retaining aggregate totals.

For new records, `tasks.md` is the source of truth for completion. A task is checked only after its linked task file contains current, substantive evidence. A parent change remains `open` until every task and parent-level acceptance obligation is evidenced.

## CLI reference

| Command                                 | Purpose                                                                                                    |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `gdd init [path] --agents`              | Generate Codex-style skills under `.agents/skills/` plus GDD templates and manifest.                       |
| `gdd init [path] --github`              | Generate GitHub Copilot prompt files under `.github/prompts/` plus GDD templates and manifest.             |
| `gdd init [path] --all`                 | Generate both currently supported integrations.                                                            |
| `gdd init [path] --force`               | Refresh differing GDD-managed files and repair incomplete installs; unmanaged collisions remain protected. |
| `gdd update [path]`                     | Refresh templates and assets recorded in the existing GDD manifest.                                        |
| `gdd status [path]`                     | Show change state, task progress, next actions, invalid records, and archive totals.                       |
| `gdd status [path] --state open --json` | Filter to open changes and emit machine-readable status. Valid states are `open` and `verified`.           |
| `gdd archive <slug> [path] --yes`       | Permanently remove one verified, valid change and update aggregate archive totals.                         |

Use `gdd --help` or `gdd <command> --help` for the executable's current command help.

## Integration notes

### Codex-style skills

`--agents` creates focused skills under `.agents/skills/` for Design, Design Update, Build, Check, and Archive. They carry the GDD authority boundaries into agent sessions:

- Design and Design Update plan; they do not implement source changes.
- Build delivers authorized work and records real check results.
- Check verifies without changing requirements.
- Archive requires explicit confirmation and deletes only a verified, valid GDD record.

### GitHub Copilot prompt files

`--github` creates reusable `.prompt.md` files under `.github/prompts/`. Prompt-file support varies by Copilot client and is documented as a preview capability by GitHub; use the client support matrix before standardizing it across a team. See [GitHub's customization documentation](https://docs.github.com/en/copilot/concepts/prompting/response-customization).

## Safe operation

- GDD only updates files that carry its managed marker. It refuses to overwrite an unmanaged file at the same path, even with `--force`.
- `update` refreshes managed templates and integration assets. Review local GDD-managed customizations before running it because they may be replaced by the current generator version.
- `status` exits with a nonzero code when it finds malformed records, making it suitable for a CI quality gate.
- `archive` requires a verified, structurally valid record with all tasks complete. In a non-interactive environment, it additionally requires `--yes`.
- Archiving removes the selected `gdd/changes/<slug>/` directory. It retains aggregate counts only, not a per-change history; keep project history in Git.

## Team rollout

Start with one repository and make the workflow visible in pull requests:

1. Install a single agent integration and agree on the first change-record convention.
2. Require `gdd status --json` to be clean before merging work that uses GDD records.
3. Review contracts and evidence with the code; do not treat an agent's unchecked or unsupported claim as proof.
4. Pin a GDD version, trial upgrades in a pilot repository, then roll out after reviewing generated-asset changes.

For organization-wide use, keep company-specific compliance, testing, and release requirements in customer-owned repository instructions rather than modifying generated assets directly.

## Development

```sh
npm ci
npm run format:check
npm run typecheck
npm run lint
npm test
npm run build
npm pack --dry-run
```

Tests cover generator behavior, GDD status parsing and validation, archive recovery, CLI distribution, and terminal-banner helpers.

## Project status and licence

GDD is currently a TypeScript CLI at version 1.0.0. It has no declared licence or published support policy in this repository yet; obtain maintainer approval before redistributing it or adopting it as an organizational standard.
