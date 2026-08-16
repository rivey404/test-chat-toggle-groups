# Toggle Groups for SillyTavern

## Overview

Adds toggle groups for Chat Completion Presets that can target multiple
prompt entries at once. There are two kinds of groups:

- **Toggle groups** — one switch that drives several prompts at once.
- **Setup groups** — snapshots of which prompts are currently enabled,
  which you can restore later.

## Features

- Groups are stored inside their Chat Completion preset. Preset export and
  import carry the complete group configuration, including setup snapshots.
- Four behaviors for each target in a toggle group:
  1. Direct: copies the state of the group's switch
  2. Invert: copies the opposite of the group's switch
  3. Toggle: flips its state on each switch change
  4. Random: settles on a random state on each switch change
- Setup groups: **Update** captures which prompts are currently enabled
  (all of them), **Apply** restores that snapshot as an exact match —
  snapshot prompts enabled, everything else disabled. Setups have no
  on/off state, the Update button stays visible but dimmed once a snapshot
  exists, and they are ignored by `/toggle-group`.
- After applying a setup, toggle groups show a grey warning triangle:
  their switch state may no longer match the prompt list. It persists
  across reloads and clears when the group's switch is next used (click or
  `/toggle-group`). Setup groups never show it.
- Long group names wrap to the next line instead of overflowing the row.
- Slash command: `/toggle-group <group name> [state=on|off|toggle]`
  (alias `/tg`; default state is `toggle`).

## Installation

Use SillyTavern's built-in extension installer:
`https://github.com/rivey404/test-chat-toggle-groups`

(Original: https://github.com/splitclover/chat-toggle-groups)

> **Note:** This fork runs under the name `test-chat-toggle-groups` and uses
> its own settings keys — it does not share data with the original
> `chat-toggle-groups` extension. Both register the `/toggle-group` slash
> command (alias `/tg`), so enable only one of them at a time.

## Usage

Find it under the Chat Completion Presets tab, just above the prompt list.
**+ Group** adds a toggle group, **+ Setup** adds a setup group. Setup
rows carry **Apply** / **Update** buttons instead of a switch.

Group configuration — definitions, targets, behaviors, order, names,
on/off states, and setup snapshots — is saved to SillyTavern's settings
automatically as you edit.

Flipping a group applies the state to its targeted prompts immediately,
but the resulting prompt enablement follows the selected preset's save
behavior: use SillyTavern's preset **Update/Save** action to persist which
prompts end up enabled. If you switch presets, reload, or reset a preset
before saving, those prompt states are discarded (the group configuration
itself is not).

Existing group data from older versions is migrated automatically into the
selected preset the first time it is loaded.

## Contributing

Contributions to improve this extension are welcome. Please fork the
repository and submit a pull request with your changes.

---

Contact: splitclover@proton.me
