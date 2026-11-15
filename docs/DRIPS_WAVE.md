# Contributing During a Drips Wave

Obsyd participates in the **Stellar Drips Wave** program. All Wave tasks are pre-scoped and labelled by maintainers; read [`CONTRIBUTING.md`](../CONTRIBUTING.md) first for local setup and test commands.

## 1. Claiming an Issue & Submitting a PR

- **Claim on Drips Wave + GitHub:** Apply for an open issue on the Drips Wave app and leave a brief comment on the GitHub issue stating you are taking it.
- **Design check for sensitive paths:** Any task touching `contracts/` (`__check_auth`, storage, factory) or the HTTP custody boundary (`lib/custody.ts`, `app/api/**`) requires an agreed design comment on the issue **before** writing code.
- **Reservation window & one PR per issue:** Active claims remain reserved during the Wave window as long as progress is visible; stale claims without activity or a draft PR may be reassigned. Open **one focused PR per issue** referencing `Closes #<number>`.
- **Contributors never open issues:** Issues are maintainer-filed only (`.github/workflows/issue-gate.yml` closes non-maintainer issues automatically; see [`CONTRIBUTING.md#issues-are-maintainer-filed`](../CONTRIBUTING.md#issues-are-maintainer-filed)). Raise non-security findings or follow-up ideas in your PR description or on the issue you are working on; report security vulnerabilities privately via [GitHub Security Advisories](https://github.com/ObsydHQ/obsyd/security/advisories/new).

## 2. Complexity Tiers & Points

| Label | Drips Wave Points | Scope |
| :--- | :--- | :--- |
| `complexity: trivial` | **100 points** | Small, clearly bounded fix, test, or documentation task |
| `complexity: medium` | **150 points** | Standard feature or hardening touching several modules |
| `complexity: high` | **200 points** | Complex engineering, on-chain integration, or architecture |

## 3. Review Checklist (What Counts as Done)

Before a PR is merged and points are awarded, reviewers check every item in the [PR template (`/.github/pull_request_template.md`)](../.github/pull_request_template.md):

1. All CI gates (`contracts`, `web`, `secret-scan`) pass cleanly.
2. Contract changes include negative/bypass unit tests and preserve persistent storage TTL extensions (`write_persistent`, `refresh_*_auth`).
3. Custody boundary invariants hold (`refuse()` on every POST route, zero keys crossing HTTP).
4. Relevant documentation (`SECURITY.md`, `ARCHITECTURE.md`, `docs/PASSKEY_CONTRACT.md`) is updated alongside code.

## 4. Labels-as-Code (`.github/labels.yml`)

All repository labels (`complexity: *`, `area: *`, `security`, `testing`, `performance`, `tooling`, `ux`, and GitHub defaults) are tracked in [`.github/labels.yml`](../.github/labels.yml) along with `gh label create --force` sync commands.
