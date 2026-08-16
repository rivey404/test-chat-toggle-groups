# Toggle groups for SillyTavern

## Overview

Adds toggle groups for Chat Completion Presets that can target multiple entries at once.

## Features

- Toggle groups are stored inside their Chat Completion preset.
- Preset import and export include the complete group configuration.
- Four different possible behaviors for each target:
  1. Direct: Will copy the state of the main toggle
  2. Invert: Will copy the opposite of the main toggle
  3. Toggle: Will toggle states for each main toggle change
  4. Random: Will settle on a random state for each main toggle change

## Installation

Use SillyTavern's built-in extension installer:
`https://github.com/splitclover/chat-toggle-groups`

## Usage

Find it under Chat Completion Presets tab, just above the prompt list

Group definitions, target assignments, behavior, order, names, and on/off
states follow the selected preset's save behavior. Use SillyTavern's preset
**Update/Save** action to persist changes. If you switch presets, reload, or
reset a preset before saving, unsaved group changes are discarded along with
other unsaved preset changes.

Existing group data from older versions is migrated automatically into the
selected preset the first time it is loaded.

## Contributing

Contributions to improve this extension are welcome. Please fork the repository and submit a pull request with your changes.

---

Contact: splitclover@proton.me
