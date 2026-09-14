import { forwardRef, type InputHTMLAttributes, type HTMLAttributes, type TextareaHTMLAttributes, type SelectHTMLAttributes } from 'react'
import { cn } from './utils'
export const Checkbox = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>>(({ className, ...props }, ref) =>
  <input ref={ref} type="checkbox" className={cn('m-checkbox', className)} {...props} />)
Checkbox.displayName = 'Checkbox'
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) =>
  <textarea ref={ref} className={cn('m-input', className)} {...props} />)
Textarea.displayName = 'Textarea'
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...props }, ref) =>
  <select ref={ref} className={cn('m-input', className)} {...props} />)
Select.displayName = 'Select'
export function Surface({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('m-surface', className)} {...props} />
}
// Extracted from the Maestrly App composer. Tailwind consumers retain its existing styling.
export const composerSurfaceClassName = 'm-composer chat-composer-shell relative mx-auto w-full max-w-3xl rounded-2xl border border-white/[0.08] bg-white/[0.03] px-3 pb-2 pt-2.5 transition-[border-color,background,box-shadow] duration-300 focus-within:border-white/[0.16]'

export function ComposerSurface({ as: Tag = 'div', className, ...props }: HTMLAttributes<HTMLElement> & { as?: 'div' | 'form' }) {
  return <Tag className={cn(composerSurfaceClassName, className)} {...props} />
}
