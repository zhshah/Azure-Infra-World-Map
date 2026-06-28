# Contributing to Azure Infra World Map

Thanks for your interest in improving **Azure Infra World Map**! Contributions of all
kinds are welcome — bug reports, feature ideas, documentation fixes, and pull requests.

## Ground rules

- **Be kind and constructive.** This is a community project maintained in spare time.
- **Read-only by design.** The app only ever performs read-only calls against Azure.
  Please do not add code that creates, modifies, or deletes Azure resources.
- **No secrets in commits.** Never commit `.env` files, access tokens, connection
  strings, subscription IDs, or anything under `.cache/`. These are git-ignored for a
  reason — keep it that way.

## Getting started

1. Fork and clone the repository.
2. Install dependencies:
   ```bash
   npm ci
   # On Windows/ARM, if native build steps fail, use:
   npm ci --ignore-scripts
   ```
3. Sign in to Azure: `az login`
4. Start the dev servers: `npm run dev` (API on `:8085`, web on `:8084`).
5. Open http://localhost:8084.

## Before you open a pull request

- Run the type checker and make sure it passes:
  ```bash
  npx tsc --noEmit -p tsconfig.json
  ```
- Keep changes focused. Small, well-described PRs are reviewed faster.
- Describe **what** changed and **why**, and include screenshots for UI changes.

## Reporting bugs

Open an issue with:

- What you expected to happen vs. what actually happened.
- Steps to reproduce (subscription size, range, lens, browser).
- Console/network errors if available (with any IDs or names redacted).

## Feature requests

Open an issue describing the scenario you want to solve. Because every data point in
this app comes from **real Azure APIs**, please note which Azure service/API would
provide the data.

---

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
