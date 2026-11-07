/** Manifest and packaging self-check: run with `npm run check:manifest` before installing the bundle. */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const problems = []

const require = (condition, message) => {
  if (!condition) problems.push(message)
}

require(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch must point at ./cordis.patch.yml')
require(pkg.dsh?.client?.platform === 'web', 'dsh.client.platform must be "web"')
require(Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0, 'dsh.client.inject must list the Client packages')
require(pkg.exports?.['.'] === './index.js', 'exports["."] must be ./index.js')
require(pkg.exports?.['./client'] === './client.js', 'exports["./client"] must be ./client.js')
require(pkg.exports?.['./role'] === './role.js', 'exports["./role"] must be ./role.js')
require(pkg.exports?.['./cordis.patch.yml'] === './cordis.patch.yml', 'the patch must be an exported resource')
require(pkg.exports?.['./locale/*.json'] === './locale/*.json', 'locale resources must be exported')
require(pkg.exports?.['./icon'] === './icon.svg', 'the icon must be exported as ./icon')

for (const file of ['index.js', 'role.js', 'client.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'LICENSE']) {
  require(existsSync(join(root, file)), `missing required file: ${file}`)
}
for (const role of ['manager', 'designer', 'developer', 'tester', 'reviewer', 'researcher']) {
  require(existsSync(join(root, 'roles', `${role}.md`)), `missing role specification: roles/${role}.md`)
}
// A bundle patch is an overlay parsed as plain YAML: the cordis `!!js` tag only works in a profile
// patch, and using one here makes `install_bundle` reject the package and roll the profile back.
const patchText = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
require(
  !patchText.includes('!!js'),
  'cordis.patch.yml must not contain a `!!js` tag: bundle overlays are parsed as plain YAML, so the install would be rejected',
)
const searchRows = (patchText.match(/@deepseek-ai\/dsh-tool-fs-search/g) ?? []).length
const searchOptions = (patchText.match(/sampleOverCapGlobResults/g) ?? []).length
require(
  searchOptions >= searchRows,
  `every dsh-tool-fs-search row needs the required sampleOverCapGlobResults option: ${searchRows} rows, ${searchOptions} options`,
)
for (const locale of ['en', 'zh']) {
  const path = join(root, 'locale', `${locale}.json`)
  if (!existsSync(path)) {
    problems.push(`missing locale file: locale/${locale}.json`)
    continue
  }
  const data = JSON.parse(readFileSync(path, 'utf8'))
  require(typeof data.meta?.title === 'string' && data.meta.title.length > 0, `locale/${locale}.json needs meta.title`)
  require(typeof data.meta?.description === 'string' && data.meta.description.length > 0, `locale/${locale}.json needs meta.description`)
}

const client = readFileSync(join(root, 'client.js'), 'utf8')
require(client.includes('window.__ModuleLoader__.load'), 'client.js must register a lazy Client factory')
require(client.includes("id: '@viz/dsh-team-mode'"), 'the Client factory id must equal the package name')
require(!/^\s*import\s/m.test(client), 'client.js must not use ESM imports (the browser module table provides react)')
require(client.includes('slots.register('), 'client.js must register slots')

const host = readFileSync(join(root, 'index.js'), 'utf8')
require(!client.includes('document.body.append'), 'client.js must not append a second application to the page')
require(!host.includes('@deepseek-ai/schemastery'), 'the Host half must not depend on schemastery at runtime')


// The shipped patch and the documented workflow must not drift apart: what a user installs has to be
// the stage machine the README describes.
{
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const patchStages = [...patch.matchAll(/\{\s*id:\s*(\w+),\s*role:\s*(\w+),\s*requires:/g)].map((m) => [m[1], m[2]])
  if (patchStages.length !== 4) problems.push(`cordis.patch.yml declares ${patchStages.length} workflow stages, expected 4`)
  for (const [stage, role] of patchStages) {
    const documented = new RegExp(`${stage}\\s*(/|→|->)\\s*${role}|${role}\\s*(/|→|->)\\s*${stage}`).test(readme)
    if (!documented) problems.push(`README does not document the stage mapping ${stage} -> ${role} that the shipped patch installs`)
  }
  if (!/kanbanSync:\s*true/.test(patch)) problems.push('cordis.patch.yml should enable kanbanSync so an installed bundle projects onto the Kanban board by default')
  if (!/humanGate:\s*true/.test(patch)) problems.push('cordis.patch.yml must keep humanGate: true: no stage may be Done without a human decision')
}

if (problems.length) {
  console.error('manifest check failed:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`@viz/dsh-team-mode ${pkg.version}: manifest, resources and role files are complete.`)
