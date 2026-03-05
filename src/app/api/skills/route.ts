import { NextRequest, NextResponse } from "next/server";
import { runCliJson } from "@/lib/openclaw";
import { fetchConfig, patchConfig } from "@/lib/gateway-config";
import { readFile, readdir, stat } from "fs/promises";
import { join } from "path";
import { getOpenClawHome } from "@/lib/paths";

const OPENCLAW_HOME = getOpenClawHome();

export const dynamic = "force-dynamic";

/* ── Types ────────────────────────────────────────── */

type Skill = {
  name: string;
  description: string;
  emoji: string;
  eligible: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  source: string;
  bundled: boolean;
  homepage?: string;
  missing: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
};

type SkillsList = {
  workspaceDir: string;
  managedSkillsDir: string;
  skills: Skill[];
};

type SkillsCheck = {
  summary: {
    total: number;
    eligible: number;
    disabled: number;
    blocked: number;
    missingRequirements: number;
  };
  eligible: string[];
  disabled: string[];
  blocked: string[];
  missingRequirements: { name: string; missing: string[] }[];
};

type SkillDetail = {
  name: string;
  description: string;
  source: string;
  bundled: boolean;
  filePath: string;
  baseDir: string;
  skillKey: string;
  emoji?: string;
  homepage?: string;
  always: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  eligible: boolean;
  requirements: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  missing: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  configChecks: unknown[];
  install: { id: string; kind: string; label: string; bins?: string[] }[];
};

/* ── File-based skill discovery fallback ──────────── */

function parseSkillFrontMatter(raw: string): Record<string, unknown> {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const yaml = match[1];
  const result: Record<string, unknown> = {};
  // Simple YAML-like parser for flat fields (name, description, metadata)
  for (const line of yaml.split("\n")) {
    const kv = line.match(/^(\w+):\s*"?(.*?)"?\s*$/);
    if (kv) {
      result[kv[1]] = kv[2];
    }
  }
  // Extract emoji from metadata block
  const emojiMatch = raw.match(/"emoji":\s*"([^"]+)"/);
  if (emojiMatch) result.emoji = emojiMatch[1];
  return result;
}

async function discoverSkillsFromFilesystem(): Promise<SkillsList> {
  const skillsDir = join(OPENCLAW_HOME, "skills");
  const skills: Skill[] = [];

  // Read skill enable/disable state from config
  let disabledSkills = new Set<string>();
  try {
    const configRaw = await readFile(join(OPENCLAW_HOME, "openclaw.json"), "utf-8");
    const config = JSON.parse(configRaw);
    const entries = config?.skills?.entries || {};
    for (const [name, entry] of Object.entries(entries)) {
      if (typeof entry === "object" && entry !== null && (entry as Record<string, unknown>).enabled === false) {
        disabledSkills.add(name);
      }
    }
  } catch { /* config not readable */ }

  // Scan workspace/custom skills
  try {
    const dirs = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of dirs) {
      if (!entry.isDirectory()) continue;
      const skillMdPath = join(skillsDir, entry.name, "SKILL.md");
      try {
        const raw = await readFile(skillMdPath, "utf-8");
        const meta = parseSkillFrontMatter(raw);
        const name = (meta.name as string) || entry.name;
        const disabled = disabledSkills.has(name);
        skills.push({
          name,
          description: (meta.description as string) || "",
          emoji: (meta.emoji as string) || "🔧",
          eligible: !disabled,
          disabled,
          blockedByAllowlist: false,
          source: skillMdPath,
          bundled: false,
          missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
        });
      } catch { /* no SKILL.md */ }
    }
  } catch { /* skills dir doesn't exist */ }

  // Also scan system skills if accessible (e.g. via shared volume)
  const systemDirs = [
    "/app/skills",  // inside gateway container (if mounted)
    join(OPENCLAW_HOME, "..", ".local", "lib", "node_modules", "openclaw", "skills"),
  ];
  for (const sysDir of systemDirs) {
    try {
      const s = await stat(sysDir);
      if (!s.isDirectory()) continue;
      const dirs = await readdir(sysDir, { withFileTypes: true });
      for (const entry of dirs) {
        if (!entry.isDirectory()) continue;
        if (skills.some((sk) => sk.name === entry.name)) continue;
        const skillMdPath = join(sysDir, entry.name, "SKILL.md");
        try {
          const raw = await readFile(skillMdPath, "utf-8");
          const meta = parseSkillFrontMatter(raw);
          const name = (meta.name as string) || entry.name;
          if (skills.some((sk) => sk.name === name)) continue;
          const disabled = disabledSkills.has(name);
          skills.push({
            name,
            description: (meta.description as string) || "",
            emoji: (meta.emoji as string) || "📦",
            eligible: !disabled,
            disabled,
            blockedByAllowlist: false,
            source: skillMdPath,
            bundled: true,
            missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
          });
        } catch { /* no SKILL.md */ }
      }
    } catch { /* dir not accessible */ }
  }

  return {
    workspaceDir: skillsDir,
    managedSkillsDir: skillsDir,
    skills: skills.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/* ── GET ──────────────────────────────────────────── */

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action") || "list";

  try {
    if (action === "check") {
      const data = await runCliJson<SkillsCheck>(["skills", "check"]);
      return NextResponse.json(data);
    }

    if (action === "info") {
      const name = searchParams.get("name");
      if (!name)
        return NextResponse.json({ error: "name required" }, { status: 400 });

      let data: SkillDetail;
      let skillMd: string | null = null;

      try {
        data = await runCliJson<SkillDetail>(["skills", "info", name]);
      } catch {
        // CLI not available — build detail from filesystem
        const skillMdPath = join(OPENCLAW_HOME, "skills", name, "SKILL.md");
        let raw = "";
        try {
          raw = await readFile(skillMdPath, "utf-8");
        } catch { /* not found */ }
        const meta = raw ? parseSkillFrontMatter(raw) : {};
        data = {
          name,
          description: (meta.description as string) || "",
          source: skillMdPath,
          bundled: false,
          filePath: skillMdPath,
          baseDir: join(OPENCLAW_HOME, "skills", name),
          skillKey: name,
          emoji: (meta.emoji as string) || "🔧",
          always: false,
          disabled: false,
          blockedByAllowlist: false,
          eligible: true,
          requirements: { bins: [], anyBins: [], env: [], config: [], os: [] },
          missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
          configChecks: [],
          install: [],
        };
      }

      // Try to read the SKILL.md content for display
      if (data.filePath) {
        try {
          const raw = await readFile(data.filePath, "utf-8");
          skillMd = raw.length > 10000 ? raw.slice(0, 10000) + "\n\n...(truncated)" : raw;
        } catch {
          // file may not be readable
        }
      }

      // Check the config for skill-specific settings
      let skillConfig: Record<string, unknown> | null = null;
      try {
        const configData = await fetchConfig(8000);
        const tools = (configData.resolved.tools || {}) as Record<string, unknown>;
        if (tools[data.skillKey || data.name]) {
          skillConfig = tools[data.skillKey || data.name] as Record<string, unknown>;
        }
      } catch {
        // config not available
      }

      return NextResponse.json({ ...data, skillMd, skillConfig });
    }

    if (action === "config") {
      // Get the full config to see skills/tools section
      try {
        const configData = await fetchConfig(8000);

        return NextResponse.json({
          tools: {
            resolved: configData.resolved.tools || {},
            parsed: configData.parsed.tools || {},
          },
          skills: {
            resolved: configData.resolved.skills || {},
            parsed: configData.parsed.skills || {},
          },
          hash: configData.hash,
        });
      } catch (err) {
        return NextResponse.json({
          tools: { resolved: {}, parsed: {} },
          skills: { resolved: {}, parsed: {} },
          hash: null,
          warning: String(err),
          degraded: true,
        });
      }
    }

    // Default: list all skills
    let data: SkillsList;
    try {
      data = await runCliJson<SkillsList>(["skills", "list"]);
    } catch {
      // CLI/exec not available — fall back to filesystem discovery
      data = await discoverSkillsFromFilesystem();
    }
    return NextResponse.json(data);
  } catch (err) {
    console.error("Skills API error:", err);
    if (action === "check") {
      return NextResponse.json({
        summary: {
          total: 0,
          eligible: 0,
          disabled: 0,
          blocked: 0,
          missingRequirements: 0,
        },
        eligible: [],
        disabled: [],
        blocked: [],
        missingRequirements: [],
        warning: String(err),
        degraded: true,
      });
    }
    if (action === "list") {
      // Last resort — try filesystem even if outer try failed
      try {
        const fsData = await discoverSkillsFromFilesystem();
        return NextResponse.json(fsData);
      } catch {
        return NextResponse.json({
          workspaceDir: "",
          managedSkillsDir: "",
          skills: [],
          warning: String(err),
          degraded: true,
        });
      }
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/* ── POST: install / enable / disable / config ──── */

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const action = body.action as string;

    switch (action) {
      case "install-brew": {
        // Install a binary dependency via brew
        const pkg = body.package as string;
        if (!pkg)
          return NextResponse.json(
            { error: "package required" },
            { status: 400 }
          );
        // Run brew install
        const { execFile } = await import("child_process");
        const { promisify } = await import("util");
        const exec = promisify(execFile);
        try {
          const { stdout, stderr } = await exec("brew", ["install", pkg], {
            timeout: 120000,
          });
          return NextResponse.json({
            ok: true,
            action,
            package: pkg,
            output: stdout + stderr,
          });
        } catch (err: unknown) {
          const e = err as { stderr?: string; message?: string };
          return NextResponse.json(
            {
              error: `brew install failed: ${e.stderr || e.message || String(err)}`,
            },
            { status: 500 }
          );
        }
      }

      case "enable-skill":
      case "disable-skill": {
        // Toggle skill via skills.entries.<name>.enabled
        const name = body.name as string;
        if (!name)
          return NextResponse.json(
            { error: "name required" },
            { status: 400 }
          );

        const enabling = action === "enable-skill";

        try {
          await patchConfig({
            skills: {
              entries: {
                [name]: { enabled: enabling },
              },
            },
          }, { restartDelayMs: 2000 });
          return NextResponse.json({ ok: true, action, name });
        } catch (err) {
          return NextResponse.json({ error: String(err) }, { status: 500 });
        }
      }

      case "update-tool-config": {
        // Patch tools.<skillKey> config
        const skillKey = body.skillKey as string;
        const config = body.config as Record<string, unknown>;
        if (!skillKey || !config)
          return NextResponse.json(
            { error: "skillKey and config required" },
            { status: 400 }
          );

        try {
          await patchConfig({ tools: { [skillKey]: config } });
          return NextResponse.json({ ok: true, action, skillKey });
        } catch (err) {
          return NextResponse.json({ error: String(err) }, { status: 500 });
        }
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 }
        );
    }
  } catch (err) {
    console.error("Skills POST error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
