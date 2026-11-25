// The one host package `lib/redteam/tools.js` needs, installed into a throwaway
// DSH_HOME.
//
// `tools.js` resolves `@deepseek-ai/dsh-tools` with `createRequire` from the
// installed profile and throws at module load when it cannot find it. That is
// deliberate: the preset must be able to tell "the host is missing" from "the
// plugin is broken". A CI runner has no DSH, so the test provides the single export
// the module uses. `defineTool` upstream is the identity function, so this stub is
// faithful rather than a stand-in that changes behaviour.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.env.DSH_HOME
if (!root) throw new Error('host-stub: DSH_HOME must be set before importing')

// `loadDefineTool` uses `DSH_HOME/package.json` as the `createRequire` anchor, and
// `createRequire` needs a file that exists — without this the stub is present but
// unreachable, and the module still throws.
writeFileSync(
  join(root, 'package.json'),
  JSON.stringify({ name: 'dsh-home-stub', private: true }, null, 2),
)

const dir = join(root, 'node_modules', '@deepseek-ai', 'dsh-tools')
mkdirSync(dir, { recursive: true })

writeFileSync(
  join(dir, 'package.json'),
  JSON.stringify({
    name: '@deepseek-ai/dsh-tools',
    version: '0.0.0',
    type: 'module',
    main: 'index.js',
    exports: { '.': './index.js' },
  }, null, 2),
)

writeFileSync(join(dir, 'index.js'), 'export const defineTool = (spec) => spec\n')
