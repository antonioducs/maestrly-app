import { forwardRef } from 'react'
import { Button as SharedButton, type ButtonProps } from '@maestrly/ui'
export { ComposerSurface, Input, Checkbox, Textarea, Surface, composerSurfaceClassName } from '@maestrly/ui'
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, ...props }, ref) =>
  <SharedButton ref={ref} variant={variant ?? (className?.split(' ').includes('primary') ? 'default' : 'outline')} className={className} {...props} />)
Button.displayName = 'BotButton'
export { Choice as Select } from './Choice'
