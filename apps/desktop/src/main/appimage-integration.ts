import { execFile } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { app, dialog, type BrowserWindow } from 'electron'
import { getChannelInfo } from './channel'
import { tMain } from './i18n'
import { getAppSetting, setAppSetting } from './store'
import { isE2E } from './test-mode'

/** Saved consent: installed, declined, or absent when no prompt has been shown. */
const SETTING_KEY = 'linux.appImageIntegration'

interface IntegrationNames {
  appImagePath: string

  appId: string
  /** Match the desktop filename to the window identity so GNOME can find its launcher. */
  desktopId: string

  iconName: string
  productName: string
}

function names(): IntegrationNames {
  const info = getChannelInfo()
  const appId = info.userDataDirName
  return {
    appImagePath: path.join(os.homedir(), 'Applications', `${info.userDataDirName}.AppImage`),
    appId,
    desktopId: `${appId}.desktop`,
    iconName: info.userDataDirName,
    productName: info.productName,
  }
}

function applicationsDir(): string {
  return path.join(os.homedir(), '.local', 'share', 'applications')
}

function hicolorDir(): string {
  return path.join(os.homedir(), '.local', 'share', 'icons', 'hicolor')
}

export async function initAppImageIntegration(win: BrowserWindow): Promise<void> {
  if (process.platform !== 'linux' || !process.env.APPIMAGE || !app.isPackaged || isE2E()) return
  const current = process.env.APPIMAGE
  try {
    const state = getAppSetting(SETTING_KEY)
    if (state === 'declined') return
    if (state === 'installed') {
      await selfHeal(current)
      return
    }
    const t = tMain('main')
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      message: t('dialog.appImageInstallTitle', { name: names().productName }),
      detail: t('dialog.appImageInstallDetail'),
      buttons: [t('dialog.appImageInstallConfirm'), t('dialog.appImageInstallLater')],
      defaultId: 0,
      cancelId: 1,
    })
    if (response !== 0) {
      setAppSetting(SETTING_KEY, 'declined')
      return
    }
    await integrate(current)
    setAppSetting(SETTING_KEY, 'installed')
  } catch (e) {
    console.error('[appimage] integration failed:', e)
  }
}

async function selfHeal(current: string): Promise<void> {
  const { appImagePath } = names()
  if (path.resolve(current) === appImagePath) {
    await installIcons()
    await writeDesktopFile(appImagePath)
  } else if (!existsSync(appImagePath)) {
    await integrate(current)
  }
}

async function integrate(current: string): Promise<void> {
  const { appImagePath } = names()
  const resolved = path.resolve(current)
  if (resolved !== appImagePath) {
    await fs.mkdir(path.dirname(appImagePath), { recursive: true })
    try {
      await fs.rename(resolved, appImagePath)
    } catch {
      await fs.copyFile(resolved, appImagePath)
      await fs.unlink(resolved).catch(() => undefined)
    }
    await fs.chmod(appImagePath, 0o755)

    process.env.APPIMAGE = appImagePath
  }
  await installIcons()
  await writeDesktopFile(appImagePath)
  refreshDesktopCaches()
}

async function installIcons(): Promise<void> {
  const appDir = process.env.APPDIR
  if (!appDir) return
  const { iconName } = names()
  const srcRoot = path.join(appDir, 'usr', 'share', 'icons', 'hicolor')
  const sizes = await fs.readdir(srcRoot).catch(() => [] as string[])
  for (const size of sizes) {
    const appsDir = path.join(srcRoot, size, 'apps')
    const pngs = (await fs.readdir(appsDir).catch(() => [] as string[])).filter((f) => f.endsWith('.png'))
    if (pngs.length === 0) continue
    const destDir = path.join(hicolorDir(), size, 'apps')
    await fs.mkdir(destDir, { recursive: true })
    await fs.copyFile(path.join(appsDir, pngs[0]), path.join(destDir, `${iconName}.png`))
  }
}

async function writeDesktopFile(appImagePath: string): Promise<void> {
  const { appId, desktopId, iconName, productName } = names()
  const dir = applicationsDir()
  await fs.mkdir(dir, { recursive: true })
  const content = [
    '[Desktop Entry]',
    `Name=${productName}`,
    `Exec="${appImagePath}" --no-sandbox %U`,
    'Terminal=false',
    'Type=Application',
    `Icon=${iconName}`,
    `StartupWMClass=${appId}`,
    'Categories=Development;',
    `X-AppImage-Version=${app.getVersion()}`,
    '',
  ].join('\n')
  await fs.writeFile(path.join(dir, desktopId), content, { mode: 0o644 })
}

function refreshDesktopCaches(): void {
  execFile('update-desktop-database', [applicationsDir()], () => undefined)
  execFile('gtk-update-icon-cache', ['-f', hicolorDir()], () => undefined)
}
