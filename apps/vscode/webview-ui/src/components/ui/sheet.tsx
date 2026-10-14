import * as DialogPrimitive from "@radix-ui/react-dialog"
import * as React from "react"

import { cn } from "@/lib/utils"

// Bottom sheet: slides up from the bottom edge of the sidebar webview. Built on
// the same Radix dialog primitives as dialog.tsx for the focus trap, Esc and
// backdrop-click close, but anchored to the bottom instead of centered.

const Sheet = DialogPrimitive.Root

const SheetClose = DialogPrimitive.Close

const SheetContent = React.forwardRef<
	React.ElementRef<typeof DialogPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
	<DialogPrimitive.Portal>
		<DialogPrimitive.Overlay
			className="fixed inset-0 z-50 bg-shadow data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 motion-reduce:animate-none [.vscode-reduce-motion_&]:animate-none"
			data-testid="sheet-backdrop"
		/>
		<DialogPrimitive.Content
			className={cn(
				"fixed inset-x-0 bottom-0 z-50 flex max-h-[85vh] flex-col overflow-y-auto rounded-t-lg border-t border-editor-widget-border bg-sidebar-background p-3.5 text-foreground shadow-[0_-8px_24px_var(--vscode-widget-shadow)] focus:outline-none",
				"duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:slide-in-from-bottom-full data-[state=closed]:slide-out-to-bottom-full motion-reduce:animate-none [.vscode-reduce-motion_&]:animate-none",
				className,
			)}
			data-testid="sheet"
			ref={ref}
			{...props}>
			{children}
		</DialogPrimitive.Content>
	</DialogPrimitive.Portal>
))
SheetContent.displayName = "SheetContent"

const SheetTitle = React.forwardRef<
	React.ElementRef<typeof DialogPrimitive.Title>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
	<DialogPrimitive.Title className={cn("m-0 text-sm font-semibold", className)} ref={ref} {...props} />
))
SheetTitle.displayName = DialogPrimitive.Title.displayName

const SheetDescription = React.forwardRef<
	React.ElementRef<typeof DialogPrimitive.Description>,
	React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
	<DialogPrimitive.Description className={cn("m-0 text-xs text-description", className)} ref={ref} {...props} />
))
SheetDescription.displayName = DialogPrimitive.Description.displayName

export { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle }
