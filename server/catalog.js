/** Read-only catalog of the Pi resources shown by the workbench sidebar. */
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const AGENT_ROOT = join(homedir(), '.pi', 'agent')
const SKILLS_ROOT = join(AGENT_ROOT, 'skills')
const EXTENSIONS_ROOT = join(AGENT_ROOT, 'extensions')
const NPM_ROOT = join(AGENT_ROOT, 'npm', 'node_modules')
const GIT_ROOT = join(AGENT_ROOT, 'git')
const SETTINGS_PATH = join(AGENT_ROOT, 'settings.json')

async function jsonFile(path, fallback = {}) {
  try { return JSON.parse(await readFile(path, 'utf8')) } catch { return fallback }
}

function frontmatter(source) {
  const block = source.match(/^---\s*\n([\s\S]*?)\n---/m)?.[1] ?? ''
  const value = (key) => {
    const raw = block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? ''
    return raw.replace(/^(["'])([\s\S]*)\1$/, '$2')
  }
  return { name: value('name'), description: value('description') }
}

async function listSkills() {
  try {
    const entries = await readdir(SKILLS_ROOT, { withFileTypes: true })
    const skills = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const path = join(SKILLS_ROOT, entry.name)
      let metadata = { name: '', description: '' }
      try { metadata = frontmatter(await readFile(join(path, 'SKILL.md'), 'utf8')) } catch { /* no readable manifest */ }
      return {
        name: metadata.name || entry.name,
        description: metadata.description || 'Local Pi skill',
        path,
      }
    }))
    return skills.sort((left, right) => left.name.localeCompare(right.name))
  } catch {
    return []
  }
}

function packagePath(spec) {
  if (spec.startsWith('npm:')) return join(NPM_ROOT, spec.slice(4))
  if (spec.startsWith('git:')) return join(GIT_ROOT, spec.slice(4))
  return ''
}

async function packageInfo(spec) {
  const path = packagePath(spec)
  const manifest = path ? await jsonFile(join(path, 'package.json')) : {}
  return {
    name: typeof manifest.name === 'string' ? manifest.name : spec.replace(/^(npm:|git:)/, '').split('/').at(-1),
    version: typeof manifest.version === 'string' ? manifest.version : '',
    description: typeof manifest.description === 'string' ? manifest.description : 'Installed Pi package',
    source: spec.startsWith('git:') ? 'Git' : spec.startsWith('npm:') ? 'npm' : 'Package',
    spec,
    path,
  }
}

async function listExtensions(settings) {
  const packages = Array.isArray(settings.packages)
    ? await Promise.all(settings.packages.filter((item) => typeof item === 'string').map(packageInfo))
    : []
  let local = []
  try {
    const entries = await readdir(EXTENSIONS_ROOT, { withFileTypes: true })
    local = entries
      .filter((entry) => entry.isFile() && /\.(ts|js|mjs|cjs)$/.test(entry.name))
      .map((entry) => ({
        name: basename(entry.name, entry.name.slice(entry.name.lastIndexOf('.'))),
        version: '',
        description: 'Local Pi extension',
        source: 'Local',
        spec: entry.name,
        path: join(EXTENSIONS_ROOT, entry.name),
      }))
  } catch { /* no extensions directory */ }
  return [...local, ...packages].sort((left, right) => left.name.localeCompare(right.name))
}

export async function loadCatalog() {
  try {
    const settings = await jsonFile(SETTINGS_PATH)
    const [skills, extensions, themes] = await Promise.all([
      listSkills(),
      listExtensions(settings),
      readdir(join(AGENT_ROOT, 'themes')).catch(() => []),
    ])
    return {
      ok: true,
      skills,
      extensions,
      settings: {
        defaultProvider: typeof settings.defaultProvider === 'string' ? settings.defaultProvider : '',
        defaultModel: typeof settings.defaultModel === 'string' ? settings.defaultModel : '',
        defaultThinkingLevel: typeof settings.defaultThinkingLevel === 'string' ? settings.defaultThinkingLevel : 'off',
        theme: typeof settings.theme === 'string' ? settings.theme : '',
        quietStartup: settings.quietStartup === true,
        hideThinkingBlock: settings.hideThinkingBlock === true,
        themeCount: themes.filter((name) => name.endsWith('.json')).length,
        path: SETTINGS_PATH,
      },
    }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), skills: [], extensions: [], settings: {} }
  }
}
