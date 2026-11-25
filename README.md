# pi-hermes-skills

Let pi use a selected Hermes Agent profile's skills, with a visible status-line token.

## Install

```bash
git clone https://github.com/trfar/pi-hermes-skills.git ~/.pi/agent/extensions/pi-hermes-skills
```

Auto-discovered via the `package.json` `pi.extensions` manifest - no `settings.json` edit needed.

## Usage

- `/hermes` - pick a profile from `~/.hermes/profiles/*` (or clear). Persists across restarts.
- `/hermes-skills` - toggle individual skills for the active profile (default: all off).
- The status line shows the active profile + skill count (e.g. `ADMIN · 3 PLAN`) when
  pi-plan-execute is installed; without it, no token is rendered.

Unofficial. Interoperates with Hermes Agent profiles; not affiliated with Nous Research.
