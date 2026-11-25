/**
 * pi-hermes-skills — let pi use a selected Hermes Agent profile's skills, with a visible token.
 *
 *   /hermes         pick the active profile from ~/.hermes/profiles (or clear)
 *   /hermes-skills  toggle the active profile's skills on/off (any nesting depth)
 *
 * A skill = a directory directly containing SKILL.md, addressed by its path
 * relative to <profile>/skills (e.g. "homelab-system", "media/gif-search").
 * Registration = symlinks, never copies: ~/.pi/agent/skills/hermes/<profile>/<skill>
 * points at the live hermes skill dir, so hermes updates appear after a pi /reload.
 *
 * State (this extension is the only writer; other extensions read it read-only):
 *   ~/.pi/agent/state/hermes.json  —  { "profile": "admin" | "", "skills": ["homelab-system", ...] }
 *   ~/.pi/agent/state/soul.json    —  { "key": "hermes-admin-soul" | "" } (pi-soul coupling)
 *
 * The visible token is rendered by pi-plan left of the PLAN/EXEC tag, via the
 * globalThis.__piHermesSkills registry this extension publishes to (no setWidget here).
 * The state file is per-current-session: fresh sessions (startup/new/fork) clear it.
 *
 * Read-only toward ~/.hermes — enforced by a path check on every write, not convention.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

const HERMES_DIR = join(homedir(), ".hermes");
const PROFILES_DIR = join(HERMES_DIR, "profiles");
const PREFS_FILE = join(HERMES_DIR, "ui-preferences.json");
const STATE_FILE = join(homedir(), ".pi", "agent", "state", "hermes.json");
const SOUL_STATE_FILE = join(homedir(), ".pi", "agent", "state", "soul.json");
const SKILLS_BASE = join(homedir(), ".pi", "agent", "skills", "hermes");
const FALLBACK_COLOR = "#3b82f6";
const CLEAR_OPTION = "clear (none)";
const DONE_OPTION = "done";

type State = { profile: string; skills: string[] };
let state: State = { profile: "", skills: [] };

// ── write guard ──────────────────────────────────────────────────────────────
// This extension never writes under ~/.hermes. Every fs mutation funnels here.
function assertWritable(p: string): void {
  const r = resolve(p);
  if (r === HERMES_DIR || r.startsWith(HERMES_DIR + sep)) {
    throw new Error(`pi-hermes-skills: refusing to write under ${HERMES_DIR}`);
  }
}

function fsRm(p: string): void {
  assertWritable(p);
  rmSync(p, { recursive: true, force: true });
}

// ── hermes (read-only) ───────────────────────────────────────────────────────

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function listProfiles(): string[] {
  let entries;
  try {
    entries = readdirSync(PROFILES_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => isDir(join(PROFILES_DIR, e.name)))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Skill dirs under dir — any directory directly containing SKILL.md, at any
 * depth (hermes groups skills in category dirs like media/gif-search).
 * Returns paths relative to dir, "/"-joined, sorted. Follows symlinked dirs.
 */
function findSkillLeaves(dir: string, prefix = ""): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) {
      isDir = statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
    }
    if (!isDir) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (statSync(join(p, "SKILL.md"), { throwIfNoEntry: false })?.isFile()) out.push(rel);
    out.push(...findSkillLeaves(p, rel));
  }
  return out.sort();
}

function discoverSkills(profile: string): string[] {
  return findSkillLeaves(join(PROFILES_DIR, profile, "skills"));
}

// Profile colors live in ~/.hermes/ui-preferences.json as a JSON string inside JSON.
function profileColors(): Record<string, string> {
  try {
    const prefs = JSON.parse(readFileSync(PREFS_FILE, "utf8")) as { values?: Record<string, unknown> };
    const raw = prefs?.values?.["hermes.desktop.profileColors"];
    if (typeof raw === "string") {
      const parsed: unknown = JSON.parse(raw); // second parse
      if (parsed && typeof parsed === "object") return parsed as Record<string, string>;
    }
  } catch {
    // missing/invalid prefs → fallback color below
  }
  return {};
}

// ── colors ───────────────────────────────────────────────────────────────────

/** Parse `hsl(210 68% 58%)` (or comma form) to `#rrggbb`. */
function hslToHex(value: string | undefined): string | undefined {
  const m = /^\s*hsl\(\s*([\d.]+)\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%\s*\)\s*$/.exec(value ?? "");
  if (!m) return undefined;
  const h = Number(m[1]);
  const s = Number(m[2]);
  const l = Number(m[3]);
  if (![h, s, l].every(Number.isFinite)) return undefined;
  const sn = s / 100;
  const ln = l / 100;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return ln - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return `#${[f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("")}`;
}

// ── token registry + color math ──────────────────────────────────────────────
// pi-plan renders the combined token; this extension only publishes state to a
// same-process registry pi-plan reads from. Lazy on both sides so load order is
// irrelevant.
type Rgb = { kind: "rgb"; r: number; g: number; b: number };
type HermesToken = {
  profile: string;
  skillCount: number;
  rgb: Rgb | null;
  soft: Rgb | null;
  listeners: Set<() => void>;
};

function tokenRegistry(): HermesToken {
  const g = globalThis as Record<string, unknown>;
  g.__piHermesSkills ??= { profile: "", skillCount: 0, rgb: null, soft: null, listeners: new Set<() => void>() };
  return g.__piHermesSkills as HermesToken;
}

/** Parse `#rrggbb` to Rgb, or null. */
function hexToRgb(value: string): Rgb | null {
  const m = /^#([0-9a-f]{6})$/i.exec(value);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { kind: "rgb", r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// #0a0a0a — hermes mono-theme sidebar background the profile buttons sit on.
const SOFT_BG: Rgb = { kind: "rgb", r: 10, g: 10, b: 10 };

/** Linear sRGB mix of fg over bg by weight p (0..1), matching CSS color-mix. */
function mix(fg: Rgb, bg: Rgb, p: number): Rgb {
  return {
    kind: "rgb",
    r: Math.round(p * fg.r + (1 - p) * bg.r),
    g: Math.round(p * fg.g + (1 - p) * bg.g),
    b: Math.round(p * fg.b + (1 - p) * bg.b),
  };
}

// Self-checks (run once at load): HSL math against the known hermes values, and
// the soft tint: profileColorSoft = color-mix(in srgb, color 30%, transparent)
// over the #0a0a0a sidebar → 30% profile + 70% sidebar.
if (hslToHex("hsl(210 68% 58%)") !== "#4b94dd" || hslToHex("hsl(0 68% 58%)") !== "#dd4b4b") {
  throw new Error("pi-hermes-skills: HSL self-check failed");
}
if (JSON.stringify(mix(hexToRgb("#4b94dd")!, SOFT_BG, 0.3)) !== JSON.stringify({ kind: "rgb", r: 30, g: 51, b: 73 })) {
  throw new Error("pi-hermes-skills: soft-tint self-check failed");
}

// ── state ────────────────────────────────────────────────────────────────────

function readState(): State {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<State>;
    return {
      profile: typeof raw.profile === "string" ? raw.profile : "",
      skills: Array.isArray(raw.skills) ? raw.skills.filter((s): s is string => typeof s === "string") : [],
    };
  } catch {
    return { profile: "", skills: [] };
  }
}

function writeState(): void {
  assertWritable(STATE_FILE);
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * pi-soul coupling (pi-soul only reads): the active soul key follows the hermes
 * profile. Written on every profile select/clear; re-synced at session_start
 * only while a profile is active, so a cleared state never stomps a key some
 * other provider may have set.
 */
function writeSoulState(profile: string): void {
  assertWritable(SOUL_STATE_FILE);
  mkdirSync(dirname(SOUL_STATE_FILE), { recursive: true });
  writeFileSync(SOUL_STATE_FILE, `${JSON.stringify({ key: profile ? `hermes-${profile}-soul` : "" }, null, 2)}\n`);
}

/** Current soul key, or "" on missing/bad file. */
function readSoulKey(): string {
  try {
    const raw = JSON.parse(readFileSync(SOUL_STATE_FILE, "utf8")) as { key?: unknown };
    return typeof raw.key === "string" ? raw.key : "";
  } catch {
    return "";
  }
}

// ── symlink registration ─────────────────────────────────────────────────────

function setSkillLink(profile: string, rel: string, on: boolean): void {
  const link = join(SKILLS_BASE, profile, rel);
  if (on) {
    assertWritable(link);
    mkdirSync(dirname(link), { recursive: true });
    try {
      statSync(link); // exists (symlink or real dir) → leave it
    } catch {
      symlinkSync(join(PROFILES_DIR, profile, "skills", rel), link);
    }
  } else {
    fsRm(link);
  }
}

/**
 * Reconcile state + symlinks with what actually exists in hermes:
 * drop link dirs for inactive profiles, prune enabled skills that vanished,
 * remove stray links, re-create missing links. Returns true if anything changed.
 */
function repairRegistration(): boolean {
  let changed = false;
  let baseEntries: string[] = [];
  try {
    baseEntries = readdirSync(SKILLS_BASE);
  } catch {
    // skills base dir not created yet
  }
  for (const name of baseEntries) {
    if (name !== state.profile) {
      fsRm(join(SKILLS_BASE, name));
      changed = true;
    }
  }
  if (!state.profile) return changed;

  const live = new Set(discoverSkills(state.profile));
  const kept = state.skills.filter((s) => live.has(s));
  if (kept.length !== state.skills.length) {
    state.skills = kept;
    changed = true;
  }

  const linkDir = join(SKILLS_BASE, state.profile);
  const links = findSkillLeaves(linkDir);
  for (const name of links) {
    if (!kept.includes(name)) {
      fsRm(join(linkDir, name));
      changed = true;
    }
  }
  for (const s of kept) setSkillLink(state.profile, s, true);
  return changed;
}

// ── token registry publish ───────────────────────────────────────────────────
// Push current state to the registry pi-plan reads. No UI call here — pi-plan
// re-renders the combined token from this (and re-renders live via its listener).
function updateToken(fire = true): void {
  const reg = tokenRegistry();
  reg.profile = state.profile;
  reg.skillCount = state.skills.length;
  reg.rgb = state.profile ? hexToRgb(hslToHex(profileColors()[state.profile]) ?? FALLBACK_COLOR) : null;
  reg.soft = reg.rgb ? mix(reg.rgb, SOFT_BG, 0.3) : null;
  if (fire) for (const l of reg.listeners) l();
}

// ── commands ─────────────────────────────────────────────────────────────────

export default function piHermesExtension(pi: ExtensionAPI) {
  pi.on("session_start", (event, ctx) => {
    // Fresh sessions (startup/new/fork) start clean; resume/reload keep the
    // selection (reload is what /hermes-skills relies on to apply skills).
    const fresh = event.reason === "startup" || event.reason === "new" || event.reason === "fork";
    if (fresh) {
      state = { profile: "", skills: [] };
      writeState();
      // Don't leak the previous session's hermes soul into this one.
      if (readSoulKey().startsWith("hermes-")) writeSoulState("");
    } else {
      state = readState();
    }
    if (repairRegistration()) writeState();
    if (state.profile) writeSoulState(state.profile);
    // No listener fire here: every subscribed ctx is stale during a session replacement;
    // pi-plan-execute's own session_start re-renders the token with a fresh ctx.
    updateToken(false);
  });

  pi.registerCommand("hermes", {
    description: "Select (or clear) the active Hermes Agent profile",
    handler: async (_args, ctx) => {
      const profiles = listProfiles();
      if (profiles.length === 0) {
        ctx.ui.notify(`pi-hermes-skills: no profiles found in ${PROFILES_DIR}`, "warning");
        return;
      }
      const choice = await ctx.ui.select(
        "Hermes profile",
        [...profiles.map((p) => (p === state.profile ? `${p} (active)` : p)), CLEAR_OPTION],
      );
      if (!choice) return; // cancelled
      const picked = choice.replace(" (active)", "");
      // Selecting the active profile again, or "clear", deactivates it.
      const profile = choice === CLEAR_OPTION || picked === state.profile ? "" : picked;

      if (state.profile && state.profile !== profile) {
        fsRm(join(SKILLS_BASE, state.profile));
      }
      state = { profile, skills: [] }; // new profile starts with all skills off
      writeState();
      writeSoulState(profile);
      updateToken();
      ctx.ui.notify(profile ? `pi-hermes-skills: profile → ${profile}` : "pi-hermes-skills: no active profile", "info");
    },
  });

  pi.registerCommand("hermes-skills", {
    description: "Toggle skills of the active Hermes profile",
    handler: async (_args, ctx) => {
      if (!state.profile) {
        ctx.ui.notify("pi-hermes-skills: no active profile — run /hermes first", "warning");
        return;
      }
      const skills = discoverSkills(state.profile);
      if (skills.length === 0) {
        ctx.ui.notify(`pi-hermes-skills: no skills found for profile "${state.profile}"`, "warning");
        return;
      }

      let toggled = false;
      for (;;) {
        const choice = await ctx.ui.select(
          `Hermes skills — ${state.profile} (select to toggle)`,
          skills.map((s) => (state.skills.includes(s) ? `on   ${s}` : `off  ${s}`)).concat(DONE_OPTION),
        );
        if (!choice || choice === DONE_OPTION) break;
        const skill = choice.replace(/^(on|off)\s+/, "");
        const enable = !state.skills.includes(skill);
        state.skills = [...state.skills.filter((s) => s !== skill), ...(enable ? [skill] : [])].sort((a, b) =>
          a.localeCompare(b),
        );
        setSkillLink(state.profile, skill, enable);
        writeState();
        updateToken();
        toggled = true;
      }

      if (!toggled) return;
      ctx.ui.notify(`pi-hermes-skills: ${state.skills.length} skill(s) enabled for ${state.profile}`, "info");
      if (ctx.isIdle()) {
        // Skills are discovered at startup/reload, so apply them now.
        // Reload is terminal for this handler: do not run code after it.
        await ctx.reload();
        return;
      }
      ctx.ui.notify("pi-hermes-skills: run /reload to apply skill changes", "info");
    },
  });
}
