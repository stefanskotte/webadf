"use client"

import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

/**
 * PINNED to "light", deliberately, and it is a bug fix rather than a preference.
 *
 * This used to read `useTheme()` from next-themes -- but no ThemeProvider is
 * mounted anywhere in this app, so it fell back to "system" and sonner
 * resolved that against prefers-color-scheme. On a dark-mode machine sonner
 * then stamped data-sonner-theme="dark" and applied this rule from its own
 * stylesheet:
 *
 *     [data-sonner-toaster][data-sonner-theme='dark'] [data-description] {
 *       color: hsl(0, 0%, 91%);   //  #e8e8e8
 *     }
 *
 * That colour is HARD-CODED, not read from a custom property, so none of the
 * --normal-* overrides below could reach it. The background, meanwhile, IS
 * tokenised -- and `.dark` is never applied to <html>, so --popover kept its
 * light value and the toast stayed white. Near-white description text on a
 * white toast: 1.23:1. The title was unaffected (it uses --normal-text, 15:1),
 * so every admin toast showed a readable headline above an invisible
 * explanation, and every one of them passes a `description`.
 *
 * The app has exactly one theme. Following the OS was the defect.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
          // Belt and braces over the pin above: sonner's description colour
          // is the one part of a toast its custom properties do not expose,
          // so state it here from this app's own contrast-checked grey ramp
          // rather than inheriting whichever literal sonner's stylesheet
          // happens to apply. --muted (#4c5966) is 7.4:1 on a white toast.
          description: "!text-[color:var(--muted)]",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
