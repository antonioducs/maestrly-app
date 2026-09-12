import { expect, test } from '@playwright/test'

test('select supports keyboard, dismissal and viewport positioning', async ({page}, info) => {
  await page.route('**/api/auth/get-session', route => route.fulfill({json:null}))
  await page.goto('/')
  const trigger = page.getByRole('combobox')
  await trigger.focus()
  await trigger.press('Enter')
  await expect(page.getByRole('listbox')).toBeVisible()
  await trigger.press('Home')
  await trigger.press('ArrowDown')
  await trigger.press('Enter')
  await expect(trigger).toHaveText('Português (Brasil)')
  await expect(trigger).toBeFocused()
  await trigger.press('Space')
  await trigger.press('Home')
  await trigger.press('Escape')
  await expect(trigger).toHaveText('Português (Brasil)')
  await expect(page.getByRole('listbox')).not.toBeVisible()
  await trigger.press('e')
  await trigger.press('Enter')
  await expect(trigger).toHaveText('English')
  for (const width of [1440,390]) {
    await page.setViewportSize({width,height:900})
    for (const theme of ['light','dark']) {
      await page.evaluate(theme => {document.documentElement.dataset.theme=theme},theme)
      await trigger.click()
      const menu = page.getByRole('listbox')
      await expect(menu).toBeVisible()
      const box = (await menu.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x+box.width).toBeLessThanOrEqual(width)
      expect(box.y+box.height).toBeLessThanOrEqual(900)
      await page.screenshot({path:'/tmp/maestrly-select-'+info.project.name+'-'+width+'-'+theme+'.png'})
      await page.locator('h1').click()
      await expect(menu).not.toBeVisible()
    }
  }
})
