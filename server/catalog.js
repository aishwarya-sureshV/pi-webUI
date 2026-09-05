/** Catalog of the Pi resources shown by the workbench, plus skill authoring. */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

const AGENT_ROOT = join(homedir(), ".pi", "agent");
const SKILLS_ROOT = join(AGENT_ROOT, "skills");
const EXTENSIONS_ROOT = join(AGENT_ROOT, "extensions");
const NPM_ROOT = join(AGENT_ROOT, "npm", "node_modules");
const GIT_ROOT = join(AGENT_ROOT, "git");
const SETTINGS_PATH = join(AGENT_ROOT, "settings.json");

async function jsonFile(path, fallback = {}) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

function frontmatter(source) {
  const block = source.match(/^---\s*\n([\s\S]*?)\n---/m)?.[1] ?? "";
  const value = (key) => {
    const raw =
      block.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim() ?? "";
    return raw.replace(/^(["'])([\s\S]*)\1$/, "$2");
  };
  return { name: value("name"), description: value("description") };
}

async function listSkills() {
  try {
    const entries = await readdir(SKILLS_ROOT, { withFileTypes: true });
    const skills = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const path = join(SKILLS_ROOT, entry.name);
          let metadata = { name: "", description: "" };
          try {
            metadata = frontmatter(
              await readFile(join(path, "SKILL.md"), "utf8"),
            );
          } catch {
            /* no readable manifest */
          }
          return {
            name: metadata.name || entry.name,
            description: metadata.description || "Local Pi skill",
            path,
          };
        }),
    );
    return skills.sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

function packagePath(spec) {
  if (spec.startsWith("npm:")) return join(NPM_ROOT, spec.slice(4));
  if (spec.startsWith("git:")) return join(GIT_ROOT, spec.slice(4));
  return "";
}

async function packageInfo(spec) {
  const path = packagePath(spec);
  const manifest = path ? await jsonFile(join(path, "package.json")) : {};
  return {
    name:
      typeof manifest.name === "string"
        ? manifest.name
        : spec
            .replace(/^(npm:|git:)/, "")
            .split("/")
            .at(-1),
    version: typeof manifest.version === "string" ? manifest.version : "",
    description:
      typeof manifest.description === "string"
        ? manifest.description
        : "Installed Pi package",
    source: spec.startsWith("git:")
      ? "Git"
      : spec.startsWith("npm:")
        ? "npm"
        : "Package",
    spec,
    path,
  };
}

async function listExtensions(settings) {
  const packages = Array.isArray(settings.packages)
    ? await Promise.all(
        settings.packages
          .filter((item) => typeof item === "string")
          .map(packageInfo),
      )
    : [];
  let local = [];
  try {
    const entries = await readdir(EXTENSIONS_ROOT, { withFileTypes: true });
    local = entries
      .filter(
        (entry) => entry.isFile() && /\.(ts|js|mjs|cjs)$/.test(entry.name),
      )
      .map((entry) => ({
        name: basename(
          entry.name,
          entry.name.slice(entry.name.lastIndexOf(".")),
        ),
        version: "",
        description: "Local Pi extension",
        source: "Local",
        spec: entry.name,
        path: join(EXTENSIONS_ROOT, entry.name),
      }));
  } catch {
    /* no extensions directory */
  }
  return [...local, ...packages].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

export async function loadCatalog() {
  try {
    const settings = await jsonFile(SETTINGS_PATH);
    const [skills, extensions, themes] = await Promise.all([
      listSkills(),
      listExtensions(settings),
      readdir(join(AGENT_ROOT, "themes")).catch(() => []),
    ]);
    return {
      ok: true,
      skills,
      extensions,
      settings: {
        defaultProvider:
          typeof settings.defaultProvider === "string"
            ? settings.defaultProvider
            : "",
        defaultModel:
          typeof settings.defaultModel === "string"
            ? settings.defaultModel
            : "",
        defaultThinkingLevel:
          typeof settings.defaultThinkingLevel === "string"
            ? settings.defaultThinkingLevel
            : "off",
        theme: typeof settings.theme === "string" ? settings.theme : "",
        quietStartup: settings.quietStartup === true,
        hideThinkingBlock: settings.hideThinkingBlock === true,
        themeCount: themes.filter((name) => name.endsWith(".json")).length,
        path: SETTINGS_PATH,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message ?? error),
      skills: [],
      extensions: [],
      settings: {},
    };
  }
}

/**
 * Skill authoring. Skills are just a directory with a SKILL.md inside, so
 * creating one is writing that file — but the name arrives from the browser,
 * so it is slugged and then re-checked against the skills root before any
 * write. A name like "../../.ssh" must not be able to escape.
 */

/** Directory-safe slug. Returns "" for anything that would not be a safe name. */
function skillSlug(name) {
  const slug = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug === "." || slug === ".." ? "" : slug;
}

/** Resolve a skill directory, refusing anything outside the skills root. */
function skillDir(slug) {
  if (!slug) throw new Error("A skill needs a name.");
  const dir = resolve(SKILLS_ROOT, slug);
  const rel = relative(SKILLS_ROOT, dir);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
    throw new Error("That skill name is not allowed.");
  return dir;
}

/** The SKILL.md source for one skill, for editing. */
export async function readSkill(name) {
  try {
    const dir = skillDir(skillSlug(name));
    const source = await readFile(join(dir, "SKILL.md"), "utf8");
    return { ok: true, name: basename(dir), source };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * Create or replace a skill. `name` sets the directory; the frontmatter is
 * rebuilt from name + description so the file always parses back into the
 * catalog listing.
 */
export async function writeSkill({ name, description, body }) {
  const slug = skillSlug(name);
  if (!slug)
    return { ok: false, error: "A skill needs a name with letters or digits." };
  try {
    const dir = skillDir(slug);
    await mkdir(dir, { recursive: true });
    const title = String(name ?? slug)
      .replace(/\n/g, " ")
      .trim();
    const summary = String(description ?? "")
      .replace(/\n/g, " ")
      .trim();
    const contents = `---\nname: ${title}\ndescription: ${summary}\n---\n\n${String(body ?? "").trimStart()}\n`;
    await writeFile(join(dir, "SKILL.md"), contents, "utf8");
    return { ok: true, name: slug, path: dir };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** Delete a skill directory. Confined to the skills root like the writes. */
export async function deleteSkill(name) {
  try {
    const dir = skillDir(skillSlug(name));
    await rm(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
