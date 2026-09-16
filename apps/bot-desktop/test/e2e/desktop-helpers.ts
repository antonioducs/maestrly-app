import { expect, type Page } from '@playwright/test'

/** Reads a framebuffer pixel painted by noVNC from the RFB stream (fixture server). */
export const pixel = (page: Page, x: number, y: number) =>
  page.evaluate(([px, py]) => {
    const canvas = document.querySelector<HTMLCanvasElement>('.desktop-screen canvas')
    if (!canvas || canvas.width === 0) return null
    const data = canvas.getContext('2d')!.getImageData(px, py, 1, 1).data
    return [data[0], data[1], data[2]]
  }, [x, y] as const)
/** Opens the screen from the conversation and waits for a real framebuffer. */
export async function openScreen(page: Page) {
  await page.getByRole('button', { name: 'Ver tela', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Tela do bot', exact: true })
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('status').first()).toHaveText(/Somente observando/)
  await expect.poll(() => page.evaluate(() => document.querySelector<HTMLCanvasElement>('.desktop-screen canvas')?.width ?? 0)).toBe(1280)
  return panel
}
