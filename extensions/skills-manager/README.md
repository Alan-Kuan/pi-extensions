# Skills Manager

An extension for Pi that allows users to list, fuzzy-search, toggle, and insert installed **project-scoped** and **user-scoped** skills via the `/skills` slash command.

## Features

- **Relevance-Based Ordering**:
  - Search results are ordered by fuzzy-match similarity, with skill name used as the alphabetical tie-breaker.
- **Rich Skill Details**:
  - The bottom detail area always displays the full word-wrapped description of the currently selected skill, along with its scope (`Project-scoped`/`User-scoped`), location, status (`enabled`/`disabled`), and model invocation setting.
- **Fuzzy Search-as-You-Type**:
  - Type any characters to instantly filter skills by name or description using fuzzy matching.
- **Persistent Settings**:
  - Toggling a project-installed skill persists settings in `.pi/disabled-skills.json`; user-installed skills use `~/.pi/agent/disabled-skills.json`.

## Slash Commands

- `/skills [all|project|user]`: Open an interactive skills menu. (Default: `all`)

## Installed Skills Menu

| Key | Action |
| --- | --- |
| Any char (`a-z`, `0-9`, etc.) | **Fuzzy search as you type** (filters name, description, & scope) |
| `Backspace` / `Delete` | Remove character from search query |
| `↑` / `↓` | Navigate skills list |
| `Space` | **Toggle skill enable/disable status** (`[✓]` Enabled / `[ ]` Disabled, auto-saved) |
| `Enter` | Insert `/skill:<skill_name>` into the current editor output and close |
| `Esc` | Clear search query (if non-empty) or close the menu |
| `Ctrl+U` | Clear search query |
| `Ctrl+C` | Close the menu |
