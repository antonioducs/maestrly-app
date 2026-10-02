import { ChatWindowEnvironment, useChatPortalContainer, useChatDocument } from '@/lib/chat-window-context'
import { useTranslation } from 'react-i18next'
import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { installHostedDialogModal } from '@/lib/hosted-dialog-modal'

const HostedDialog = React.createContext<{
  open: boolean
  setOpen: (open: boolean) => void
  modal: boolean
  contentId: string
  titleId: string
  descriptionId: string
} | null>(null)

function Dialog({
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  modal = true,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root>) {
  const contentId = React.useId()
  const titleId = React.useId()
  const descriptionId = React.useId()
  const environment = React.useContext(ChatWindowEnvironment)
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = React.useCallback(
    (next: boolean) => {
      if (controlledOpen === undefined) setUncontrolledOpen(next)
      onOpenChange?.(next)
    },
    [controlledOpen, onOpenChange]
  )
  return (
    <HostedDialog.Provider value={environment ? { open, setOpen, modal, contentId, titleId, descriptionId } : null}>
      <DialogPrimitive.Root {...props} open={open} onOpenChange={setOpen} modal={environment ? false : modal} />
    </HostedDialog.Provider>
  )
}
const DialogTrigger = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Trigger>
>((props, ref) => {
  const hosted = React.useContext(HostedDialog)
  return <DialogPrimitive.Trigger ref={ref} {...(hosted ? { 'aria-controls': hosted.contentId } : {})} {...props} />
})
DialogTrigger.displayName = DialogPrimitive.Trigger.displayName
function DialogPortal(props: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Portal>) {
  const container = useChatPortalContainer()
  return <DialogPrimitive.Portal container={container} {...props} />
}

let openDialogs = 0
function DialogSuppressViews() {
  const ownerDocument = useChatDocument()
  React.useEffect(() => {
    if (ownerDocument !== document) return
    openDialogs += 1
    if (openDialogs === 1) window.api.suppressDrawerViews(true)
    return () => {
      openDialogs -= 1
      if (openDialogs === 0) window.api.suppressDrawerViews(false)
    }
  }, [ownerDocument])
  return null
}

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

interface DialogContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  showClose?: boolean
  closeLabel?: string
  overlayClassName?: string
}

const DialogContent = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Content>, DialogContentProps>(
  ({ className, overlayClassName, children, showClose = true, closeLabel, ...props }, ref) => {
    const { t } = useTranslation('ui')
    const hosted = React.useContext(HostedDialog)
    const ownerDocument = useChatDocument()
    const [content, setContent] = React.useState<HTMLDivElement | null>(null)
    const initialized = React.useRef(false)
    const latest = React.useRef({ props, hosted })
    latest.current = { props, hosted }
    const contentRef = React.useCallback(
      (node: HTMLDivElement | null) => {
        setContent(node)
        if (typeof ref === 'function') ref(node)
        else if (ref) ref.current = node
      },
      [ref]
    )
    React.useLayoutEffect(() => {
      if (!hosted?.open || !content) return
      const cleanup = installHostedDialogModal(content, {
        autoFocus: !initialized.current,
        modal: hosted.modal,
        onPointerDownOutside: (event) => latest.current.props.onPointerDownOutside?.(event),
        onFocusOutside: (event) => latest.current.props.onFocusOutside?.(event),
        onInteractOutside: (event) => latest.current.props.onInteractOutside?.(event),
        onDismiss: () => latest.current.hosted?.setOpen(false),
        onOpenAutoFocus: (event) => latest.current.props.onOpenAutoFocus?.(event),
        onCloseAutoFocus: (event) => latest.current.props.onCloseAutoFocus?.(event),
        onEscape: (event) => {
          latest.current.props.onEscapeKeyDown?.(event)
          if (!event.defaultPrevented) {
            event.preventDefault()
            latest.current.hosted?.setOpen(false)
          }
        },
      })
      initialized.current = true
      return cleanup
    }, [content, hosted?.open, hosted?.modal, ownerDocument])
    React.useEffect(() => {
      if (!hosted?.open) initialized.current = false
    }, [hosted?.open])
    const Content = hosted ? HostedDialogContent : DialogPrimitive.Content
    return (
      <DialogPortal>
        {hosted ? (
          hosted.modal &&
          hosted.open && (
            <div
              data-hosted-dialog-overlay=""
              data-state="open"
              className={cn('fixed inset-0 z-50 bg-black/60', overlayClassName)}
            />
          )
        ) : (
          <DialogOverlay className={overlayClassName} />
        )}
        <Content
          ref={contentRef}
          className={cn(
            'fixed left-1/2 top-1/2 z-50 grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 border border-border bg-[#1E1E21] p-6 shadow-xl duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 sm:rounded-lg',
            className
          )}
          {...props}
        >
          <DialogSuppressViews />
          {children}
          {showClose && (
            <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none">
              <X className="size-4" />
              <span className="sr-only">{closeLabel ?? t('common.close')}</span>
            </DialogPrimitive.Close>
          )}
        </Content>
      </DialogPortal>
    )
  }
)
DialogContent.displayName = DialogPrimitive.Content.displayName

// A hosted surface must never register Radix's module-global focus/layer stacks.
// This component stays the same when its portal DOM is adopted by another document.
const HostedDialogContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(
  (
    {
      onOpenAutoFocus,
      onCloseAutoFocus,
      onEscapeKeyDown,
      onPointerDownOutside,
      onFocusOutside,
      onInteractOutside,
      forceMount,
      asChild,
      children,
      ...props
    },
    ref
  ) => {
    const hosted = React.useContext(HostedDialog)!
    const surfaceProps = {
      role: 'dialog',
      tabIndex: -1,
      id: hosted.contentId,
      'aria-labelledby': hosted.titleId,
      'aria-describedby': hosted.descriptionId,
      'aria-modal': hosted.modal || undefined,
      'data-state': hosted.open ? 'open' : 'closed',
      ...props,
      ref,
    }
    // Consume the Radix-only props; document-scoped effects handle these callbacks.
    void [
      onOpenAutoFocus,
      onCloseAutoFocus,
      onEscapeKeyDown,
      onPointerDownOutside,
      onFocusOutside,
      onInteractOutside,
      forceMount,
    ]
    if (asChild && React.isValidElement(children)) return React.cloneElement(children, surfaceProps)
    return <div {...surfaceProps}>{children}</div>
  }
)
HostedDialogContent.displayName = 'HostedDialogContent'

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1.5 text-left', className)} {...props} />
}

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...props} />
}

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => {
  const hosted = React.useContext(HostedDialog)
  return (
    <DialogPrimitive.Title
      ref={ref}
      {...(hosted ? { id: hosted.titleId } : {})}
      className={cn('text-lg font-semibold leading-none tracking-tight', className)}
      {...props}
    />
  )
})
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => {
  const hosted = React.useContext(HostedDialog)
  return (
    <DialogPrimitive.Description
      {...(hosted ? { id: hosted.descriptionId } : {})}
      ref={ref}
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  )
})
DialogDescription.displayName = DialogPrimitive.Description.displayName

export { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription }
