# Contributing to SkillFoo

SkillFoo V3.2 U1 is deliberately narrow: only `SKILL.md` may change, while a controlled evaluator may use hash-bound, read-only runtime context through `reference-v1`. Contributions must keep the candidate root, runtime context, and evaluation split separate. This runtime capability is zero-network engineering evidence, not a model-effect claim.

## Local setup

Use Node.js 20 or later.

```bash
npm ci
npm run build
npm test
node dist/cli.js --help
```

## Change boundaries

- Keep U1 candidate changes limited to `SKILL.md`; references, attachments, replay results, scripts, and other package files are immutable inputs, never mutation targets.
- Read-only references/attachments and declarative hash-bound replay belong to the controlled runtime context. Do not add arbitrary script execution, web fetching, plugins, databases, front ends, U2 behavior, or full-package mutation under a U1 change.
- Do not weaken frozen tests, rubrics, thresholds, capability boundaries, confirmation gates, sealed isolation, or rollback behavior to make a result pass.
- Do not add public commands or examples that bypass real-human confirmation for live Provider execution.
- Keep the public live path bound to current formal human evidence; offline fixtures must never authorize it.
- Treat Provider responses as untrusted and keep strict parsing, deterministic gates, and desensitized failures fail-closed.

## Verification

Choose verification according to the claim:

- deterministic authorization, hash, schema, and sealed-read boundaries: focused contract or regression tests;
- TypeScript integration: `npm run build`;
- repository behavior: `npm test`;
- CLI packaging: `node dist/cli.js --help`;
- probabilistic model quality: bounded evaluation with an explicit evidence boundary, never a unit-test claim.

Strict test-first development is appropriate only for a focused deterministic high-risk contract or reproducible defect. It is not a blanket requirement for documentation, evaluation, configuration, or model-quality work.

## Test and fixture hygiene

- Use synthetic, portable fixtures under temporary directories.
- Frozen-context fixtures must bind every readable file or replay by hash, remain synthetic and portable, and never imply a real Provider or optimization-effect result.
- A fixture confirmation must use `confirmationMode: "test-fixture"` and must never enter a live formal path.
- Tests must not call a real Provider, consume canonical holdout data, or create human-looking confirmation records.
- Do not add machine-specific absolute paths or depend on a developer's local evidence directory.
- Remove temporary, backup, copied, and staging files after verification.

## Public contribution hygiene

Never commit or attach:

- private live-run evidence or raw model responses;
- sealed holdout files or their bodies;
- API credentials or `.env` files;
- human-confirmation records or identities;
- internal paths, attachment metadata, or business questionnaires.

Report security-sensitive findings according to `SECURITY.md`.

## Pull request checklist

- The change stays within its declared U1 scope.
- No frozen evaluation or security boundary was relaxed to obtain a preferred result.
- Relevant focused checks, build, full tests, and CLI help have been run as applicable.
- New fixtures are synthetic and portable.
- No secrets, raw evidence, sealed content, signatures, or personal paths are present.
- Documentation distinguishes formal evidence, offline fixtures, sealed status, source publication, npm publication, and Skill-candidate release.
