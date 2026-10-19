/**
 * Bundle the settings UI into one module the harness client loader can evaluate.
 *
 * The output is CommonJS wrapped in `window.__ModuleLoader__.load` because the
 * client plugin host consumes modules, not ES modules; React stays external so
 * the page shares the host's copy.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const id = pkg.name
const marker = '/*__EXPERIENCE_STYLE__*/'
const result = await build({
  entryPoints: ['src/client/index.jsx'],
  outfile: 'lib/client.js',
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  legalComments: 'none',
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client', '@deepseek-ai/*'],
  loader: { '.css': 'css' },
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: `${marker} return module.exports; } });` },
})
const js = result.outputFiles.find(file => file.path.endsWith('.js'))
const css = result.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? ''
if (!js || !js.text.includes(marker)) throw new Error('client bundle footer missing')
const injectStyle = `var cssText=${JSON.stringify(css)};if(typeof document!=="undefined"&&!document.querySelector('style[data-plugin-css="${id}/client.css"]')){var s=document.createElement('style');s.dataset.plugin=${JSON.stringify(id)};s.dataset.pluginCss=${JSON.stringify(id + '/client.css')};s.textContent=cssText;document.head.appendChild(s);}`
mkdirSync('lib', { recursive: true })
writeFileSync('lib/client.js', js.text.replace(marker, injectStyle))
console.log(`built lib/client.js as module ${id}`)
