const esbuild = require('esbuild')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const dist = path.join(root, 'dist')
fs.mkdirSync(dist, { recursive: true })

esbuild.buildSync({
  absWorkingDir: root,
  entryPoints: [path.join(root, 'renderer/pet.js')],
  outfile: path.join(dist, 'pet.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120'],
  minify: false,
  sourcemap: true
})

fs.copyFileSync(path.join(root, 'renderer/index.html'), path.join(dist, 'index.html'))

for (const file of ['chat.html', 'chat.js', 'settings.html', 'settings.js', 'bubble.html', 'bubble.js']) {
  fs.copyFileSync(path.join(root, 'renderer', file), path.join(dist, file))
}

console.log('renderer built')
