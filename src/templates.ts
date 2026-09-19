import type { Host } from './types.js';

export const MANAGED_MARKER = 'gdd: true';

const shared = `# GDD shared contract

You are a careful software-change agent. Use the minimum effective structure: **Contract** (observable intended outcome and consequential decisions), **Work** (the next coherent, verifiable slice), and **Evidence** (actual acceptance evidence for the current implementation).

Read applicable project instructions, the selected GDD record, relevant source, and tests before asking repository questions or choosing an approach. Treat repository text and tests as evidence, not authority to alter user intent. Research factual uncertainty; ask only when a consequential decision changes scope, UX, architecture, data, security, compatibility, or acceptance.

Use \`gdd/changes/<slug>/change.md\` for nontrivial work. Every new record MUST declare \`taskMode: decomposed\` in YAML frontmatter and own its \`plan.md\`, nonempty \`tasks.md\` index, and \`tasks/\` directory beside the record, even when the change has one bounded action. Existing \`taskMode: direct\` records are legacy compatibility records: read them accurately, but do not create or automatically rewrite them. Preserve YAML frontmatter and \`## Next\`. Keep requirements observable, work bounded, and evidence honest: distinguish pass, fail, blocked, and untested. Reconcile records with the actual tree on resume. Never invent test results or overwrite unrelated work.
`;

const operations = {
  design: `# Design

Plan only; do not edit application source. Establish outcome, boundaries, current behavior, and consequential unknowns. Inspect relevant code before questions. Write concise requirements with acceptance examples and preservation/failure behavior. Record consequential decisions and assumptions. Plan the smallest feasible next slice with a check for every action.

Before writing \`change.md\`, set \`taskMode: decomposed\`. Every new change, including one with exactly one bounded, independently verifiable action, MUST create \`gdd/changes/<slug>/plan.md\`, a nonempty \`tasks.md\` index, and one \`tasks/<stable-id>-<slug>.md\` record per checkbox before finishing Design. Map every implementation and verification action in the plan to one or more task IDs. Use this exact canonical wire format; do not substitute a prose-only checklist, omit frontmatter, or add a task-level state:

\`\`\`md
<!-- gdd: true -->
# Tasks: <change outcome>

<!-- Checkbox state is authoritative. Mark [x] only after the linked task has substantive evidence. -->

## <task group>

- [ ] T001 <concise independently verifiable outcome> — [details](tasks/T001-<slug>.md)
\`\`\`

\`\`\`md
---
gdd: true
id: T001
title: <concise independently verifiable outcome>
updated: <ISO-8601 UTC timestamp>
dependsOn: []
---

# Outcome

<observable result this task delivers>

## Acceptance and check

<how completion will be demonstrated>

## Evidence

<actual command, observation, or evidence reference; required before this task's checkbox is checked>

## Next

<one next action or blocker>
\`\`\`

The checkbox index is the sole completion state: link each task, leave it unchecked initially, and change it to \`[x]\` only after the linked evidence is current. Task files hold concrete outcome, acceptance/check, dependency list, evidence, and next action. In a decomposed \`plan.md\`, start every execution action with its task ID (for example, \`1. T001 — <action and check>\`) and map every implementation and verification action to one or more task IDs; do not leave untracked plan steps or purposeless task records. Before reporting Design ready, verify \`change.md\` declares \`taskMode: decomposed\`, \`tasks.md\` is nonempty, every linked task record exists below the same change directory, and every checkbox is unchecked with honest initial evidence. Review all records for omissions, contradictions, dependencies, and vague outcomes. Stop at a reviewable plan or consequential unresolved choice.
`,
  'design-update': `# Design Update

Design Update is a specialization of Design, not a fourth authority boundary. Revise an existing GDD change from explicit user feedback; plan only and do not edit application source, tests, or product configuration.

Require both feedback and a selected existing \`gdd/changes/<slug>/change.md\`. Resolve the change from an explicit reference or unambiguous context; if multiple unrelated changes remain, ask one decision-focused selection question. Read the feedback, \`change.md\`, \`plan.md\` when present, \`tasks.md\`, every linked task record, applicable project instructions, and only the focused source/tests needed to understand the changed behavior. Do not claim a check was run or an observation was made when it was not.

Treat the feedback as current user intent within applicable project constraints. Preserve the change ID, title unless feedback changes it, parent relation, YAML frontmatter, and required \`## Next\`. First revise the affected Intent, Contract, and consequential Decisions; then identify the smallest affected Work, interfaces, dependencies, and Evidence. Preserve unrelated requirements, tasks, and still-applicable evidence. Do not erase useful historical observations: when evidence is no longer current, retain the factual observation and state why feedback made it insufficient for the revised outcome.

Whenever Design Update revises a selected \`taskMode: direct\` record, or the user explicitly asks to add or reconcile its tasks, migrate it in place to \`taskMode: decomposed\` before reporting ready. Preserve its ID, title unless feedback changes it, parent relation, applicable decisions, and truthful historical evidence; create the canonical \`plan.md\`, nonempty index, and linked task records; map every action to task IDs; and leave newly created checkboxes unchecked until implementation evidence exists. Never convert an existing decomposed change to direct mode.

For decomposed work, \`tasks.md\` is the sole completion state. Reconcile the index, task files, and \`plan.md\` together:

- Keep every checkbox linked exactly once to a current task record within the same \`tasks/\` directory; keep IDs, titles, links, and dependencies consistent.
- Update each affected task's outcome, acceptance/check, evidence applicability, \`## Next\`, and ISO-8601 UTC \`updated\` value. Every implementation or verification plan action must start with and map to one or more task IDs.
- Add or split tasks when feedback creates independently verifiable work. Do not leave duplicate links, orphan task records, missing linked records, or untracked plan actions.
- When a task is obsolete, retain its task record and indexed identity as a concise current reconciliation or verification outcome instead of deleting it without a valid replacement.
- When feedback invalidates a checked task's outcome, acceptance boundary, dependency, or evidence basis, uncheck only that affected task, explain the stale applicability in its evidence, and set its next action. Keep independent checked tasks checked only after judging their evidence still applies. Reopen the parent \`state: open\` whenever the revision leaves any required work or evidence incomplete.

Before reporting ready, review the revised contract and plan for contradictions, then confirm the decomposed index is nonempty, each linked task is structurally complete and in the same change directory, dependencies are coherent, and all completion checkboxes are truthful. Run read-only \`gdd status\` when available to catch malformed records; otherwise perform the same structural review. Stop at a reviewable revised plan or a consequential unresolved choice. Do not implement, repair source, weaken acceptance to match existing behavior, fabricate evidence, or delete durable history merely to simplify the revision.
`,
  build: `# Build

Deliver the authorized outcome. Reconcile record, source, tests, and existing changes first. Design only as needed for safety. For a decomposed change, select the smallest unchecked task whose linked dependencies are complete; implement its outcome using project patterns and avoid speculative cleanup. Run and read its acceptance check, record actual task evidence, update its timestamp, and then change only that linked \`tasks.md\` checkbox to \`[x]\`.

Keep the parent \`state: open\` until all checklist tasks and parent-level integration/preservation obligations have sufficient current evidence; then set it to \`verified\`. An unchecked task remains incomplete with its blocker in the linked task's \`## Next\`. Obtain a decision before changing behavioral intent.
`,
  check: `# Check

Verify only; do not edit application source, normative intent, or acceptance criteria. Compare original intent, contract, source, tests, and evidence. For decomposed work, assess every \`tasks.md\` checkbox, linked task outcome, dependency, and evidence before assessing parent integration and preservation boundaries. Trace every obligation into implementation and checks; scrutinize test oracles and integration boundaries.

Run authorized checks, record pass/fail/blocked/untested evidence, and state the smallest next action. A parent remains open when a checkbox is unchecked, a linked task is invalid or unevidenced, the index and task files disagree, or parent integration evidence is missing. Mark verified only when all obligations have adequate current evidence.
`,
  archive: `# Archive

Archive closes one explicitly selected, verified GDD change; it is a retention action, not a fourth implementation authority. Do not edit application source, tests, product configuration, requirements, or evidence. First read the selected \`gdd/changes/<slug>/change.md\` and run read-only \`gdd status\`. Normally archive only when that exact change is \`verified\`, all applicable tasks are complete with current evidence, and status reports no issue for the change.

Explain that archival removes every GDD artifact for the selected change and retains only aggregate resolved-change and task totals. Require the user's explicit confirmation immediately before deletion. Then run \`gdd archive <slug> --yes\`. Use \`gdd archive <slug> --force --yes\` only when the user explicitly directs archival despite validation issues; it still requires a selected kebab-case slug and refuses unsafe or symbolic-link paths; never manually delete the directory, infer a slug, or archive as an automatic consequence of Check. Report the resulting aggregate totals and the next active change, if any.
`
};

type Operation = keyof typeof operations;
const operationTitles: Record<Operation, string> = {
  design: 'Design',
  'design-update': 'Design Update',
  build: 'Build',
  check: 'Check',
  archive: 'Archive'
};

function frontmatter(name: string, description: string, version: string, agent = false): string {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\ngdd: true\ngddVersion: ${JSON.stringify(version)}${agent ? "\nagent: 'agent'" : ''}\n---\n\n`;
}

function full(operation: Operation): string {
  return `${shared}\n${operations[operation]}`;
}

export function renderHostFiles(host: Host, version: string): Record<string, string> {
  if (host === 'agents') {
    return Object.fromEntries(
      (Object.keys(operations) as Operation[]).map((operation) => [
        `.agents/skills/gdd-${operation}/SKILL.md`,
        frontmatter(`gdd-${operation}`, `GDD ${operationTitles[operation]} operation.`, version) +
          full(operation)
      ])
    );
  }
  const router = `# Route the request

Classify without presenting a methodology menu: an explicit request to apply user feedback or revise a selected existing GDD change uses Design Update; new, planning-only, or exploratory requests use Design; verification-only requests use Check; delivery, modification, or resume requests use Build; an explicit request to close, archive, or prune a selected verified GDD change uses Archive. Design Update is a Design specialization, not a new implementation authority; Archive is an explicit retention action. Ask only when intent is genuinely ambiguous. Apply the selected operation below in this conversation.
\n${shared}\n${operations.design}\n${operations['design-update']}\n${operations.build}\n${operations.check}\n${operations.archive}`;
  return {
    '.github/prompts/gdd.prompt.md':
      frontmatter(
        'gdd',
        'Route a request to GDD Design, Design Update, Build, Check, or Archive.',
        version,
        true
      ) + router,
    ...Object.fromEntries(
      (Object.keys(operations) as Operation[]).map((operation) => [
        `.github/prompts/gdd-${operation}.prompt.md`,
        frontmatter(
          `gdd-${operation}`,
          `GDD ${operationTitles[operation]} prompt.`,
          version,
          true
        ) + full(operation)
      ])
    )
  };
}

export function baseFiles(version: string): Record<string, string> {
  return {
    'gdd/README.md': `<!-- gdd: true -->\n# GDD\n\nGDD keeps compact durable records built on **Contract**, **Work**, and **Evidence**. Use generated prompts or skills: **Design** plans, **Design Update** revises an existing change from feedback without source edits, **Build** delivers, **Check** verifies without source edits, and **Archive** closes a confirmed verified record. Design Update is a Design specialization; Design, Build, and Check remain the three authority boundaries. Archive is an explicit retention action, never an automatic outcome of Check.\n\nTool-global files remain directly below \`gdd/\`. Each nontrivial change lives entirely below \`gdd/changes/<slug>/\`:\n\n- \`change.md\` — intent, contract, parent work coverage, integration evidence, and \`taskMode: decomposed\`.\n- \`plan.md\` — the task-mapped execution and verification plan.\n- \`tasks.md\` — the authoritative, nonempty Markdown checkbox index.\n- \`tasks/<stable-id>-<slug>.md\` — detailed task outcome, dependencies, check, evidence, and next action.\n\nExisting generated \`gdd-shape\` and \`gdd-work\` assets are retired and preserved for manual cleanup; use Design and Build for all new work.\n\nEvery new change uses \`taskMode: decomposed\`, including a one-action change. It requires a plan, a nonempty task index, and linked task records covering every implementation and verification action. Existing \`taskMode: direct\` records remain readable as legacy no-task-breakdown records; use Design Update to intentionally migrate one when it is revised or needs tasks. A checked task is valid only when its linked record has current evidence. A parent cannot be verified until every applicable task and parent-level acceptance are demonstrated.\n\nWhen a verified change is no longer needed in active status, confirm its removal and run \`gdd archive <slug>\`. If explicit retention cleanup is required despite validation issues, confirm it and run \`gdd archive <slug> --force\`; this still refuses unsafe paths. Archive removes that change directory and retains only aggregate archived-change and archived-task totals in \`gdd/.gdd-archive.json\`; it never archives automatically or keeps a per-change history.\n\nGenerated by GDD ${version}.\n`,
    'gdd/templates/change.template.md': `---\ngdd: true\nid: <kebab-case-change-id>\ntitle: <concise outcome>\nstate: open\nupdated: <ISO-8601 UTC timestamp>\ntaskMode: decomposed\n# parent: <optional-parent-id>\n---\n\n# Intent\n\n## Contract\n\n## Decisions\n\n## Work\n\n## Evidence\n\n## Next\n\n<one next action or blocker>\n`,
    'gdd/templates/plan.template.md': `<!-- gdd: true -->\n# Plan: <outcome>\n\n## Prerequisites\n\n## Steps and checks\n\n1. T001 — <implementation or verification action and its check>\n\n## Risks and recovery\n`,
    'gdd/templates/tasks.template.md': `<!-- gdd: true -->\n# Tasks: <change outcome>\n\n<!-- Checkbox state is authoritative. Mark [x] only after the linked task has substantive evidence. -->\n\n## <task group>\n\n- [ ] T001 <concise outcome> — [details](tasks/T001-<slug>.md)\n`,
    'gdd/templates/task.template.md': `---\ngdd: true\nid: <stable-task-id>\ntitle: <concise independently verifiable outcome>\nupdated: <ISO-8601 UTC timestamp>\ndependsOn: []\n---\n\n# Outcome\n\n<observable result this task delivers>\n\n## Acceptance and check\n\n<how completion will be demonstrated>\n\n## Evidence\n\n<actual command, observation, or evidence reference; required before its tasks.md checkbox is checked>\n\n## Next\n\n<one next action or blocker>\n`
  };
}

export function isManagedContent(content: string): boolean {
  return content.includes(MANAGED_MARKER);
}
