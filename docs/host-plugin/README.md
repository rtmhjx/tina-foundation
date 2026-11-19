# @tina/dsh-plugin-cortico

Mount Cortico Worlds on an **existing** native DSH session. No second DSH, no second Cordis, no second AgentLoop.

```text
existing DSH session
  └─ @tina/dsh-plugin-cortico
       ├─ host-chat World
       ├─ Cortico World tools/events
       ├─ prompt/history routing
       └─ optional Self-Mem Persona
```

## Requirements

- DSH `0.1.5-rc.2`
- Cordis `4.0.2`
- A loaded, idle target session
- Host services: `agentLoop`, `agents`, `sessions`, `sessionController`, `tools`, `llm`, `loader`, `settings`, `systemPrompt`, `agentDefaultModel`, `approval`, `credentialsController`, `sessionProjections`, `attachments`
- Versioned contracts: `hostRoutingVersion=1`, `requestDeliveryVersion=1`, `requestPlanningVersion=1`, `externalEventVersion=1`, `tools.hasContentFinalizer`

## Install

```bash
npm install ./tina-dsh-plugin-cortico-0.2.0-fusion.9.tgz
```

Load it through the host's normal plugin loader. `main` is `src/host-entry.mjs`.

## Configure

```json
{
  "sessionId": "<loaded session id>",
  "stateDir": "C:/Tina/plugin-state"
}
```

`stateDir` must be separate from the workspace. The plugin refuses unsafe or nested paths.

## Persona modes

- **Default**: creates a Self-Mem Persona; `host-chat` is the only enabled World; memory lives in `<stateDir>/self-mem`.
- **Custom**: pass a `botDefinition` to `mountHostPlugin`; Self-Mem is skipped and the host keeps its own memory.

## Scope

- Works: World tools/events, `host_chat_send`, prompt/history routing, host approvals.
- Does not: bundle DSH/Cordis, create a second AgentLoop, or provide the Fusion Web UI / World config panels.
- Status: **preview**; package build verified, real-host attachment not yet verified.

Full documentation: `docs/HOST_PLUGIN.md`.

## License

AGPL-3.0-or-later. Upstream Cortico/DSH/Cordis remain MIT; see `THIRD-PARTY-NOTICES.md`.
