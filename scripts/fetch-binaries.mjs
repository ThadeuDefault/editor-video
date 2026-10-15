// Coloca ffmpeg/ffprobe em resources/bin (usados pelo .exe empacotado).
// Baixa o build "essentials" do gyan.dev (menor que o "full" e com tudo que o app usa);
// se o download falhar, copia o ffmpeg instalado no PATH.
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { basename, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const binDir = join(root, 'resources', 'bin')
mkdirSync(binDir, { recursive: true })

const targets = ['ffmpeg.exe', 'ffprobe.exe']
if (targets.every((t) => existsSync(join(binDir, t)))) {
  console.log('ffmpeg já presente em resources/bin')
  process.exit(0)
}

function which(cmd) {
  try {
    const out = execSync(`where ${cmd}`, { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
    return out[0] || null
  } catch {
    return null
  }
}

function download() {
  const tmp = join(root, '.tmp-ffmpeg')
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  const zip = join(tmp, 'ffmpeg.zip')
  console.log('Baixando ffmpeg (gyan.dev essentials)...')
  execSync(`curl -L --fail -o "${zip}" https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip`, { stdio: 'inherit' })
  execSync(`powershell -NoProfile -Command "Expand-Archive -Force '${zip}' '${tmp}'"`, { stdio: 'inherit' })
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]))
  for (const f of walk(tmp)) {
    for (const t of targets) if (basename(f) === t) copyFileSync(f, join(binDir, t))
  }
  rmSync(tmp, { recursive: true, force: true })
}

try {
  download()
} catch (e) {
  console.warn('Download falhou, usando o ffmpeg do PATH:', e.message)
  const ff = which('ffmpeg')
  const fp = which('ffprobe')
  if (!ff || !fp) throw new Error('ffmpeg não encontrado')
  copyFileSync(ff, join(binDir, 'ffmpeg.exe'))
  copyFileSync(fp, join(binDir, 'ffprobe.exe'))
}
console.log('ffmpeg pronto em', binDir)
