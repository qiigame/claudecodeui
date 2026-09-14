# One release, separate deployment profiles

Use one fork commit and one dependency lockfile for the product/QA service and
the developer/analysis service. Keep deployment settings, credentials, identity
bindings, databases, provider state, installed skills and project checkouts
outside the release directory. Do not maintain a source branch per machine.

| Setting or behavior | Product/QA | Developer/analysis |
| --- | --- | --- |
| `CLOUDCLI_DEPLOYMENT_PROFILE` | `product-qa-readonly` | `developer` |
| DingTalk login | Required | Required for a shared team service |
| Identity registry and runtime bindings | Required | Required when DingTalk is configured |
| Code/file/Git writes and shell tools | Denied by server policy | Available to verified users subject to runtime/tool permissions |
| New conversation permission default | Always `default` | Optional `bypassPermissions` from startup configuration |
| Provider credentials and home | Dedicated read-only runtime state | Dedicated developer runtime state or the existing service account state |
| CC Switch synchronization | `COMIC_CC_SWITCH_SYNC=1` when used | `COMIC_CC_SWITCH_SYNC=1` when used |
| Browser/plugin startup approval | Preserve the deployment's existing approval | Enable only after that deployment's identity and tool approval |
| Analysis skills and outputs | Only within permitted read-only capabilities | Install separately; use the real writable project path |

Templates: [product/QA](../examples/deployment/product-qa.env.example) and
[developer/analysis](../examples/deployment/developer-analysis.env.example).
They contain placeholders, not a working credential bundle. Load the selected
profile through the service launcher; do not source both profiles. Authentication
and authorization remain server decisions. A frontend build variable or request
cannot select a more permissive deployment profile.

## Conversation defaults

`CLOUDCLI_DEFAULT_PERMISSION_MODE` accepts `default` (the default) or
`bypassPermissions`. The latter applies only to an explicitly selected
`developer` deployment whose effective capabilities allow provider execution,
file/repository/Git writes and shell execution. Restricted profiles and
restricted developer capability sets return `default`.

An explicit developer default is used when a new conversation starts. Existing
conversation state is not rewritten, and the ordinary default retains the
existing provider preference behavior. This setting does not grant a deployment
capability, bypass the identity registry, or approve Browser/plugin startup.

## Migration from older customized installations

1. Capture the running source, untracked source files and dependency lockfile;
   record their hashes. Preserve the original dirty checkout. Compare each
   customization against the fork's newer implementation before porting it.
2. Rename the old `COMIC_CC_SWITCH_ENABLED` launcher setting to
   `COMIC_CC_SWITCH_SYNC`. The current runtime bridge and model catalog both
   use `SYNC`; setting only the old name does not enable synchronization.
3. Set the deployment profile explicitly. `NODE_ENV=production` describes the
   application environment and does not select a developer permission profile.
4. Check DingTalk credentials, the identity registry and private runtime mapping
   together. Older installations could authenticate a DingTalk account without
   the newer registry. A credentials file alone is insufficient: a managed
   deployment with missing identity configuration blocks new OAuth completion
   and managed execution. Old actor rows may contain only an irreversible
   subject hash, without the stable subject and its provider scope. Prepare an
   authoritative roster covering this service's authorized users and the
   protected runtime-map location; have legacy users complete a real OAuth login
   again so the existing actor can receive a verified binding. Do not manually
   reconstruct stable subjects from names or hashes, or copy another service's
   allowlist. Managed provider execution also requires a registered personal or
   shared VCS identity: an arbitrary machine Git name/email is not proof of that
   assignment. Verify the identity status in `/api/collaboration/me` and an actual provider
   turn after login. See [identity registry](identity-registry.md).
5. Preserve the current provider credential source. If switching to an isolated
   `CODEX_HOME`, configure the optional token helper and its source directory
   explicitly. A helper's credential-source home and the provider's writable
   state home serve different purposes. Do not copy credentials into the release
   or expose them through command arguments. See [read-only deployment](deployment-readonly.md).
6. Preserve project real paths, skill installations, database paths and runtime
   state paths in each service's private launcher. A path alias is not proof that
   the provider sandbox permits the underlying writable project.

## Validate and release

In an isolated candidate checkout, install the locked dependencies using the
target Node major version, then run `npm run typecheck`, `npm run lint`,
`npm test`, `npm run test:client` and `npm run build`. Validate both deployment
profiles, including direct API/WebSocket denial paths and new-conversation
defaults. Keep `VITE_IS_PLATFORM=false` for both of these managed services;
`VITE_COMIC_RUNTIME_ONLY=true` can be shared by their frontend build.

Before switching a live launcher, save its current target, private configuration
and a consistent SQLite backup. Wait for active turns to finish. Deploy the
verified candidate into a separate release directory, keep the previous release
available, and point the launcher at the selected release while retaining that
service's private profile and state locations. Record the exact Git commit and
artifact hashes. Rollback must restore the matching code, launcher and database
backup if a migration changed the database; switching only the code is not
necessarily sufficient.

After restart, verify the actual process profile, health/version, DingTalk login,
verified identity, project/session access and one permitted provider turn. On the
product/QA service also verify denied writes and shell tools. On the analysis
service replay a frozen analysis snapshot and compare business outputs. These
live checks cannot be inferred from a green build or a health response.

The stock UI update action performs a Git pull and dependency installation in
the running checkout. It does not implement this fork release procedure. Use the
isolated release process above for these managed installations.
