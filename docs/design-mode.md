# Design mode

Design mode turns interface requests into executable, navigable frontend prototypes. It favors a useful browser preview, coherent visual direction, working interactions, and realistic mock data over production architecture.

## When to use it

Choose Design for flows such as dashboards, product screens, landing pages, mobile-responsive web interfaces, or interaction concepts that should run in a browser. The mode is not intended to produce only a design specification or static image.

Agent remains the default and is the right mode for general production development. Design has the same tool capabilities that Agent would have under the current conversation permissions, toggles, approvals, provider, and model, but applies a prototype-focused harness. It does not grant full access or enable disabled tools.

## Selecting and leaving Design

Open the Standard chat mode picker and select **Design**. The selection is stored only for that conversation. Switching conversations restores each conversation's own mode.

`Shift+Tab` cycles Agent → Design → Plan → Ask → Agent. Selecting a mode does not execute work, install dependencies, start a server, generate images, or change files. The selected behavior applies to the next admitted turn; an in-flight turn keeps the behavior captured when it started.

To continue from a prototype into ordinary production work, switch back to Agent and send a new request. Moving between Standard and Maestro preserves the stored Standard mode, including Design.

## Prototype boundaries

Design uses fictional, domain-appropriate data and local simulation for APIs, authentication, billing, persistence, and other services unless the user explicitly requests and authorizes real integration work. The delivered summary should distinguish working frontend behavior from mocks.

In an existing production repository, Design defaults to a separated target such as `prototypes/<name>/` unless the request explicitly identifies an existing interface to edit. This is an organizational convention, not an additional filesystem sandbox. The normal permission mode, sandbox, approvals, MCP configuration, tool toggles, and project instructions remain authoritative.

## Preview and optional capabilities

When Maestrly terminal and browser tools are enabled, Design can run the project's real frontend command, wait for an observed local URL, open it, exercise the primary flow, capture fresh evidence, and inspect browser errors. It reuses the existing terminal and browser mechanisms; there is no separate preview manager.

If app tools or browser/vision capabilities are disabled, Design still writes the prototype and performs the checks available to it, then reports that visual inspection was unavailable and explains how to open the result. It never enables tools silently or invents a live preview URL.

Image generation is optional and appears only when the conversation toggle and required connection are active. Existing assets, SVG, and CSS remain valid fallbacks. Frontend/design skills are also optional and are loaded only when enabled and advertised to the model.

Changing Design mode does not alter the selected model, provider, reasoning effort (including Ultra), Fast mode, permission mode, enabled tools, MCP servers, skills, subagents, or global preferences.
