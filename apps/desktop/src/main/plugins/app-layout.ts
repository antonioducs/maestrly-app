import path from 'node:path'
import { app } from 'electron'
import { type PluginLayout, pluginLayout } from './layout'

let override: PluginLayout | null = null

/** This host's plugin directories under `<userData>/plugins`. */
export function appPluginLayout(): PluginLayout {
  return override ?? pluginLayout(path.join(app.getPath('userData'), 'plugins'))
}

/** Tests point the plugin directories at a temporary folder. */
export function setAppPluginLayoutForTests(layout: PluginLayout | null): void {
  override = layout
}
