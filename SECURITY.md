# Security Policy

## Supported surface

Security fixes are accepted for the current SkillFoo CLI 1.x source line and the implemented parts of SkillFoo V3.2 U1. U1 permits only `SKILL.md` mutation; `reference-v1` exposes a hash-bound, read-only, zero-network runtime context outside the candidate root. Generated candidates are not independently supported software releases.

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue, discussion, test fixture, or model transcript.

When this repository enables GitHub private vulnerability reporting, use that channel. Until then, contact the repository owner privately through the channel supplied with the source distribution. Include:

- the affected command or module;
- a minimal reproduction using synthetic data;
- the expected and observed security boundary;
- whether secrets, confirmation records, or sealed data may have been exposed.

Do not attach API keys, raw Provider responses, real confirmation records, private live-run evidence, or sealed holdout content. Replace sensitive values with deterministic placeholders.

## Sensitive material that must remain local

The following must not be committed, pasted into issues, or attached to pull requests:

- `.env` files, API keys, bearer tokens, cookies, or authorization headers;
- raw model responses, JSONL traces, run logs, and private live-run evidence directories;
- human-confirmation records, operator identities, and signatures;
- sealed holdout files, requests, judging rules, and expected outcomes;
- local absolute paths, usernames, internal attachment locations, and business questionnaires.

If any such material is exposed, revoke the affected credential where applicable, preserve a private audit copy, and remove the exposed material from every public surface before continuing.

## U1 trust boundaries

- U1 may optimize only `SKILL.md`. `reference-v1` may read hash-bound, read-only references/attachments or exact-request deterministic replay results by logical id; those dependencies remain outside the candidate root and immutable.
- `reference-v1` accepts no path, URL or command arguments, performs no network access, and rejects record mode. `script-v1` and `plugin-v1` remain non-executable contracts.
- Arbitrary scripts, local commands, plugins, web access, databases and full-package mutation remain outside U1.
- A formal live run requires two separate real-human confirmations. A fixture, model, calibration result, or automated agent cannot satisfy either confirmation.
- Missing confirmation must stop before Provider calls and output writes.
- `test-fixture` evidence is zero-network, temporary, and never formal evidence.
- Sealed evaluation is conditional and one-way: denied paths read no sealed body, and sealed results must not feed mutation or repair.
- GitHub source publication is distinct from npm publication and from releasing any generated Skill candidate.

Model output is untrusted input. Prompt wording is not a security boundary; deterministic schemas, hashes, capability gates, budgets, and evidence-mode checks enforce the boundary.
