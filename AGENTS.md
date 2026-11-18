# MarshGO-Server

This is the canonical source for MARSHGO backend/API behavior, authorization, database schema and migrations, Redis/cache, routing, realtime transport data, and provider integrations. Do not implement Web/iOS/Admin/Partner screens here; do not duplicate backend modules in the central `MarshGO` orchestrator.

Before editing, check `git status`, branch, remotes, and the current PR/base. Preserve dirty work. Use a short-lived `feature/*` or `fix/*` branch and PR; do not push to `main`, force-push, or merge without the repository review process.

With Node 24.21.0 and the committed lockfile, run:

```sh
npm ci
npm run typecheck
npm run lint
npm test
```

For database, Redis, migration, booking, routing, or realtime changes, also run the relevant `npm run test:integration:*` target or `npm run test:integration` with the required disposable PostGIS/PostgreSQL and Redis services configured. Never point tests at production data. Follow repository security and migration guidance before changing contracts or schema.

The central `MarshGO` repository pins this repository by full commit SHA for cross-repository builds and integration tests. Update API/OpenAPI/types here first or in a coordinated PR, then verify every consumer against the exact Server SHA. Partner tenant isolation and Admin authorization must be enforced here, regardless of frontend visibility.

## Handoff across Codex windows and tasks

Codex chats, cloud tasks, local worktrees and feature branches are **not** shared conversation memory. Before assuming work from another window is present, verify the checked-out repository, working tree, current branch and HEAD SHA, upstream/ref, and relevant open PRs. Fetch remote refs when access allows, without overwriting dirty files or automatically merging. An open PR or a successful build does **not** mean its changes are on `main` or deployed. If expected functionality exists only in another branch, name that branch/PR and exact commit; do not silently recreate it or replace a newer implementation with an older one.

For a task spanning Server, Site or iOS, identify the exact source commit of each dependent repository and reconcile it with the canonical release manifest before integrating or building; do not use a floating `main` branch as proof of which version is deployed. Verify actual deployment access and deployed SHA before making production claims. Never modify production, force-push, merge open PRs, or discard another task's work without explicit authorization.

At the end of each task, leave a concise handoff in the PR description when applicable and always in the final report: repository, branch, HEAD commit, PR URL/status, changed files, checks run and skipped, dependent branch/commit SHAs, unresolved blockers, and next action. The next Codex chat must verify these facts from Git rather than assuming it sees the preceding conversation.

Keep verification proportional to risk: run focused checks during development, reserve full suites, complete native/iOS builds and release packaging for meaningful checkpoints, PR gates or changes requiring them. Do not skip required CI or release checks; report omitted validation explicitly. Avoid repeatedly feeding large successful build logs into the model.
