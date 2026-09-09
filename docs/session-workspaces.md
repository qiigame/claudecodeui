# Isolated session workspaces

CloudCLI can give each new conversation its own Git worktrees while keeping the
visible project and shared user-level Agent configuration unchanged. The
feature is disabled unless the server process sets
`CLOUDCLI_SESSION_WORKSPACE_CONFIG` to a local JSON file.

This feature is for writable `developer`/`self-hosted` deployments. The
`product-qa-readonly` profile deliberately skips workspace planning and
provisioning even when the config file exists; a QA conversation is bound to
the registered source snapshot and relies on the deployment policy plus the
OS-level read-only mount instead of receiving a writable worktree.

Do not enable this feature as part of the 0.78 QA rollout. In a managed
`product-qa-readonly` process, `CLOUDCLI_SESSION_WORKSPACE_CONFIG` is ignored for
session planning/provisioning, so adding the file cannot grant a QA user a
writable branch. The session still has writable metadata/transcript state under
the service state directory; that state write is separate from the registered
source snapshot and must not be confused with project-code write access.

The JSON file is deployment configuration. Keep it outside the source checkout
and do not commit credentials, tokens, webhook URLs, or personal login state.

```json
{
  "version": 1,
  "workspaceRoot": "/srv/cloudcli/session-workspaces",
  "projects": [
    {
      "sourceProjectPath": "/srv/projects/product-suite",
      "defaultRepositoryKeys": [],
      "repositories": [
        {
          "key": "coordination",
          "displayName": "Coordination",
          "relativePath": "coordination",
          "remoteName": "origin",
          "baseBranch": "main",
          "expectedRemote": "github.com/example/coordination",
          "writable": true
        },
        {
          "key": "mirror",
          "displayName": "Read-only mirror",
          "relativePath": "mirror",
          "remoteName": "origin",
          "baseBranch": "main",
          "expectedRemote": "git.example.com/team/mirror",
          "writable": false,
          "unavailableReason": "Changes must be made in the source repositories"
        }
      ]
    }
  ]
}
```

For a multi-repository project the first send asks the user which writable
repositories the conversation needs. CloudCLI then, for every selection:

1. validates the configured source path and remote identity;
2. fetches the configured remote branch without checking it out or merging it;
3. resolves the exact fetched commit SHA;
4. creates and locks `cloudcli/session/<session-id>` in the session directory;
5. stores the runtime path, branch, base branch, and base SHA in SQLite.

The source checkout can be behind, ahead, or dirty; provisioning does not pull,
switch, stash, reset, or clean it. A partially-created workspace is removed
before the session is exposed. Configured source checkouts are read-only in the
Git UI, while commits and pushes remain available inside session worktrees.

The remote fetch in the numbered flow is performed only by a writable local
deployment while provisioning a selected repository. It is not a 0.78 update
mechanism: the read-only deployment must receive a new immutable source snapshot
through its release process, and QA sessions must not fetch, merge, or follow a
moving main branch.

In a writable local `developer` deployment, user-level memories, skills, and MCP
configuration can remain shared because conversations run under the same local
service identity. Repository-local rules and configuration come from the
selected fetched revision. The outer `AGENTS.md` and `PROJECT_GUIDE.md`, when
present, are copied into the generated session root.

Do not infer the same runtime behavior for `product-qa-readonly`: that profile
does not provision these worktrees, and its provider child processes use the
deployment's isolated read-only HOME/config paths. Existing Skill/MCP catalogs
may be visible when explicitly exposed, but project/user hooks, MCP commands and
plugins are not automatically loaded or executed. DeepSeek Harness is not a
session-workspace dependency; any Dataverse token helper is an optional
operator-side runtime choice described in
[deployment-readonly.md](./deployment-readonly.md).

Git worktrees isolate files and indexes; they are not an operating-system
security boundary. Processes still share the service account, credentials,
ports, caches, and machine resources.

For the local `developer` profile, use a separate session workspace root outside
the source checkout and keep the configured `writable` flags limited to the
repositories that the session is allowed to change. For 0.78, enforce the stronger
OS boundary described in [deployment-readonly.md](./deployment-readonly.md): a
dedicated non-admin account/container, immutable read-only code mounts, and a
separate writable state directory. This document alone does not prove that the
currently running 0.78 host has been deployed or restarted with those controls.
