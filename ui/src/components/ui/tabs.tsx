import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Tabs as TabsPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-[orientation=horizontal]:flex-col",
        className
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "group/tabs-list text-muted-foreground inline-flex items-center justify-start group-data-[orientation=vertical]/tabs:h-fit group-data-[orientation=vertical]/tabs:flex-col",
  {
    variants: {
      variant: {
        default: "gap-0 p-1 bg-muted rounded-md",
        line: "gap-0 bg-transparent border-b border-border",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        // Base: inline flex, centered, compact
        "relative inline-flex items-center justify-center gap-1.5",
        "px-2.5 py-1.5 text-xs font-medium whitespace-nowrap",
        // Colors: subtle transition
        "text-muted-foreground transition-colors duration-150",
        "hover:text-foreground/70",
        "data-[state=active]:text-foreground",
        // Focus ring
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        // Disabled
        "disabled:pointer-events-none disabled:opacity-50",
        // SVG icons
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        // Default variant: pill background on active
        "group-data-[variant=default]/tabs-list:rounded-sm",
        "group-data-[variant=default]/tabs-list:data-[state=active]:bg-background",
        "group-data-[variant=default]/tabs-list:data-[state=active]:shadow-sm",
        // Line variant: subtle bottom border indicator
        "group-data-[variant=line]/tabs-list:border-b-2",
        "group-data-[variant=line]/tabs-list:border-transparent",
        "group-data-[variant=line]/tabs-list:data-[state=active]:border-foreground",
        "group-data-[variant=line]/tabs-list:-mb-px",
        // Vertical orientation
        "group-data-[orientation=vertical]/tabs:w-full group-data-[orientation=vertical]/tabs:justify-start",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
