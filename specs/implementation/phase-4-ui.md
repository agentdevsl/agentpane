# Phase 4: UI Layer

**Duration:** Weeks 6-8
**Components:** 10 primitive + 19 feature components
**Pages:** 7 routes
**Dependencies:** Phase 3 (API Layer)

---

## Overview

Phase 4 implements the UI layer using Radix UI primitives, Tailwind CSS, and TanStack Router. The UI follows a component-driven architecture with primitives, feature components, and page routes.

---

## 4.1 Design Tokens

### Tailwind Configuration (`tailwind.config.ts`)

```typescript
import type { Config } from 'tailwindcss';

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        // Status colors
        status: {
          idle: 'hsl(var(--status-idle))',
          running: 'hsl(var(--status-running))',
          paused: 'hsl(var(--status-paused))',
          error: 'hsl(var(--status-error))',
          completed: 'hsl(var(--status-completed))',
        },
        // Column colors
        column: {
          backlog: 'hsl(var(--column-backlog))',
          'in-progress': 'hsl(var(--column-in-progress))',
          'waiting-approval': 'hsl(var(--column-waiting-approval))',
          verified: 'hsl(var(--column-verified))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        'pulse-dot': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        shimmer: 'shimmer 2s infinite',
        'pulse-dot': 'pulse-dot 1.5s ease-in-out infinite',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
} satisfies Config;
```

### CSS Variables (`app/styles/globals.css`)

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 222.2 84% 4.9%;
    --card: 0 0% 100%;
    --card-foreground: 222.2 84% 4.9%;
    --primary: 222.2 47.4% 11.2%;
    --primary-foreground: 210 40% 98%;
    --secondary: 210 40% 96.1%;
    --secondary-foreground: 222.2 47.4% 11.2%;
    --muted: 210 40% 96.1%;
    --muted-foreground: 215.4 16.3% 46.9%;
    --accent: 210 40% 96.1%;
    --accent-foreground: 222.2 47.4% 11.2%;
    --destructive: 0 84.2% 60.2%;
    --destructive-foreground: 210 40% 98%;
    --border: 214.3 31.8% 91.4%;
    --input: 214.3 31.8% 91.4%;
    --ring: 222.2 84% 4.9%;
    --radius: 0.5rem;

    /* Status colors */
    --status-idle: 215 16% 47%;
    --status-running: 142 71% 45%;
    --status-paused: 38 92% 50%;
    --status-error: 0 84% 60%;
    --status-completed: 142 71% 45%;

    /* Column colors */
    --column-backlog: 215 16% 47%;
    --column-in-progress: 217 91% 60%;
    --column-waiting-approval: 38 92% 50%;
    --column-verified: 142 71% 45%;
  }

  .dark {
    --background: 222.2 84% 4.9%;
    --foreground: 210 40% 98%;
    --card: 222.2 84% 4.9%;
    --card-foreground: 210 40% 98%;
    --primary: 210 40% 98%;
    --primary-foreground: 222.2 47.4% 11.2%;
    --secondary: 217.2 32.6% 17.5%;
    --secondary-foreground: 210 40% 98%;
    --muted: 217.2 32.6% 17.5%;
    --muted-foreground: 215 20.2% 65.1%;
    --accent: 217.2 32.6% 17.5%;
    --accent-foreground: 210 40% 98%;
    --destructive: 0 62.8% 30.6%;
    --destructive-foreground: 210 40% 98%;
    --border: 217.2 32.6% 17.5%;
    --input: 217.2 32.6% 17.5%;
    --ring: 212.7 26.8% 83.9%;
  }
}
```

---

## 4.2 Primitive Components

### Button (`components/ui/button.tsx`)

```typescript
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef } from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline: 'border border-input bg-background hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 rounded-md px-3',
        lg: 'h-11 rounded-md px-8',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
```

### Dialog (`components/ui/dialog.tsx`)

```typescript
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { forwardRef } from 'react';
import { cn } from '@/lib/utils';

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%] sm:rounded-lg',
        className
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col space-y-1.5 text-center sm:text-left', className)} {...props} />
);

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)} {...props} />
);

const DialogTitle = forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold leading-none tracking-tight', className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
```

### Tabs (`components/ui/tabs.tsx`)

```typescript
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { forwardRef } from 'react';
import { cn } from '@/lib/utils';

const Tabs = TabsPrimitive.Root;

const TabsList = forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      'inline-flex h-10 items-center justify-center rounded-md bg-muted p-1 text-muted-foreground',
      className
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      'inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm',
      className
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      'mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
      className
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
```

### Additional Primitives

```
components/ui/
├── button.tsx          # Button with variants
├── dialog.tsx          # Modal dialog
├── tabs.tsx            # Tab navigation
├── dropdown-menu.tsx   # Context menus
├── tooltip.tsx         # Hover tooltips
├── checkbox.tsx        # Checkbox input
├── select.tsx          # Select dropdown
├── text-input.tsx      # Text input field
├── textarea.tsx        # Multiline input
├── skeleton.tsx        # Loading placeholder
└── toast.tsx           # Toast notifications
```

---

## 4.3 Skeleton Component (`components/ui/skeleton.tsx`)

```typescript
import { cn } from '@/lib/utils';

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-md bg-muted',
        'before:absolute before:inset-0 before:-translate-x-full before:animate-shimmer before:bg-gradient-to-r before:from-transparent before:via-white/20 before:to-transparent',
        className
      )}
      {...props}
    />
  );
}

export { Skeleton };
```

---

## 4.4 Feature Components

### KanbanBoard (`components/features/kanban-board.tsx`)

```typescript
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { useState } from 'react';
import { KanbanColumn } from './kanban-column';
import { KanbanCard } from './kanban-card';
import type { Task, TaskColumn } from '@/db/schema';

interface KanbanBoardProps {
  tasks: Task[];
  onTaskMove: (taskId: string, column: TaskColumn, position: number) => void;
  onTaskClick: (task: Task) => void;
  isLoading?: boolean;
}

const COLUMNS: { id: TaskColumn; title: string }[] = [
  { id: 'backlog', title: 'Backlog' },
  { id: 'in_progress', title: 'In Progress' },
  { id: 'waiting_approval', title: 'Waiting Approval' },
  { id: 'verified', title: 'Verified' },
];

export function KanbanBoard({ tasks, onTaskMove, onTaskClick, isLoading }: KanbanBoardProps) {
  const [activeTask, setActiveTask] = useState<Task | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    const task = tasks.find((t) => t.id === event.active.id);
    if (task) setActiveTask(task);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveTask(null);

    if (!over) return;

    const taskId = active.id as string;
    const overId = over.id as string;

    // Determine target column
    let targetColumn: TaskColumn;
    let position = 0;

    if (COLUMNS.some((c) => c.id === overId)) {
      // Dropped on column
      targetColumn = overId as TaskColumn;
      position = tasks.filter((t) => t.column === targetColumn).length;
    } else {
      // Dropped on another task
      const overTask = tasks.find((t) => t.id === overId);
      if (!overTask) return;
      targetColumn = overTask.column;
      position = overTask.position;
    }

    onTaskMove(taskId, targetColumn, position);
  };

  const getTasksByColumn = (column: TaskColumn) =>
    tasks.filter((t) => t.column === column).sort((a, b) => a.position - b.position);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex h-full gap-4 overflow-x-auto p-4">
        {COLUMNS.map((column) => (
          <KanbanColumn
            key={column.id}
            id={column.id}
            title={column.title}
            tasks={getTasksByColumn(column.id)}
            onTaskClick={onTaskClick}
            isLoading={isLoading}
          />
        ))}
      </div>

      <DragOverlay>
        {activeTask ? <KanbanCard task={activeTask} isDragging /> : null}
      </DragOverlay>
    </DndContext>
  );
}
```

### KanbanColumn (`components/features/kanban-column.tsx`)

```typescript
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { cn } from '@/lib/utils';
import { KanbanCard } from './kanban-card';
import { Skeleton } from '@/components/ui/skeleton';
import type { Task, TaskColumn } from '@/db/schema';

interface KanbanColumnProps {
  id: TaskColumn;
  title: string;
  tasks: Task[];
  onTaskClick: (task: Task) => void;
  isLoading?: boolean;
}

export function KanbanColumn({ id, title, tasks, onTaskClick, isLoading }: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id });

  const columnColorClass = {
    backlog: 'border-t-column-backlog',
    in_progress: 'border-t-column-in-progress',
    waiting_approval: 'border-t-column-waiting-approval',
    verified: 'border-t-column-verified',
  }[id];

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'flex w-80 flex-shrink-0 flex-col rounded-lg border border-t-4 bg-muted/50',
        columnColorClass,
        isOver && 'ring-2 ring-ring'
      )}
    >
      <div className="flex items-center justify-between border-b p-3">
        <h3 className="font-semibold">{title}</h3>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {tasks.length}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        ) : (
          <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
            <div className="space-y-2">
              {tasks.map((task) => (
                <KanbanCard key={task.id} task={task} onClick={() => onTaskClick(task)} />
              ))}
            </div>
          </SortableContext>
        )}
      </div>
    </div>
  );
}
```

### KanbanCard (`components/features/kanban-card.tsx`)

```typescript
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { cva } from 'class-variance-authority';
import { GripVertical, User } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Task } from '@/db/schema';

const cardVariants = cva(
  'group relative rounded-md border bg-card p-3 shadow-sm transition-shadow hover:shadow-md',
  {
    variants: {
      isDragging: {
        true: 'opacity-50 shadow-lg',
        false: '',
      },
      hasAgent: {
        true: 'border-l-4 border-l-status-running',
        false: '',
      },
    },
    defaultVariants: {
      isDragging: false,
      hasAgent: false,
    },
  }
);

interface KanbanCardProps {
  task: Task;
  onClick?: () => void;
  isDragging?: boolean;
}

export function KanbanCard({ task, onClick, isDragging: isDraggingProp }: KanbanCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(cardVariants({ isDragging: isDraggingProp ?? isDragging, hasAgent: !!task.agentId }))}
      onClick={onClick}
      {...attributes}
    >
      <div className="flex items-start gap-2">
        <button
          className="mt-1 cursor-grab opacity-0 transition-opacity group-hover:opacity-100"
          {...listeners}
        >
          <GripVertical className="h-4 w-4 text-muted-foreground" />
        </button>

        <div className="flex-1 space-y-2">
          <p className="font-medium leading-tight">{task.title}</p>

          {task.description && (
            <p className="line-clamp-2 text-sm text-muted-foreground">{task.description}</p>
          )}

          <div className="flex items-center justify-between">
            <div className="flex gap-1">
              {task.labels?.map((label) => (
                <span
                  key={label}
                  className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                >
                  {label}
                </span>
              ))}
            </div>

            {task.agentId && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <User className="h-3 w-3" />
                <span>Agent</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
```

### ApprovalDialog (`components/features/approval-dialog.tsx`)

```typescript
import { useState } from 'react';
import { Check, X, GitBranch, FileText, AlertCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import type { Task, DiffSummary } from '@/db/schema';

interface ApprovalDialogProps {
  task: Task;
  diff: DiffSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApprove: (commitMessage?: string) => void;
  onReject: (reason: string) => void;
}

export function ApprovalDialog({
  task,
  diff,
  open,
  onOpenChange,
  onApprove,
  onReject,
}: ApprovalDialogProps) {
  const [tab, setTab] = useState<'summary' | 'files' | 'diff'>('summary');
  const [rejectReason, setRejectReason] = useState('');
  const [commitMessage, setCommitMessage] = useState('');
  const [showRejectForm, setShowRejectForm] = useState(false);

  const handleApprove = () => {
    onApprove(commitMessage || undefined);
    onOpenChange(false);
  };

  const handleReject = () => {
    if (!rejectReason.trim()) return;
    onReject(rejectReason);
    onOpenChange(false);
    setRejectReason('');
    setShowRejectForm(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-5 w-5" />
            Review Changes: {task.title}
          </DialogTitle>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="flex-1">
          <TabsList>
            <TabsTrigger value="summary">Summary</TabsTrigger>
            <TabsTrigger value="files">Files ({diff?.filesChanged ?? 0})</TabsTrigger>
            <TabsTrigger value="diff">Diff</TabsTrigger>
          </TabsList>

          <TabsContent value="summary" className="space-y-4">
            <div className="rounded-lg border p-4">
              <h4 className="font-medium mb-2">Change Summary</h4>
              <div className="grid grid-cols-3 gap-4 text-center">
                <div>
                  <p className="text-2xl font-bold text-green-500">+{diff?.insertions ?? 0}</p>
                  <p className="text-sm text-muted-foreground">Insertions</p>
                </div>
                <div>
                  <p className="text-2xl font-bold text-red-500">-{diff?.deletions ?? 0}</p>
                  <p className="text-sm text-muted-foreground">Deletions</p>
                </div>
                <div>
                  <p className="text-2xl font-bold">{diff?.filesChanged ?? 0}</p>
                  <p className="text-sm text-muted-foreground">Files</p>
                </div>
              </div>
            </div>

            {task.rejectionCount > 0 && (
              <div className="rounded-lg border border-yellow-500/50 bg-yellow-500/10 p-4">
                <div className="flex items-center gap-2 text-yellow-600">
                  <AlertCircle className="h-4 w-4" />
                  <span className="font-medium">
                    Previously rejected {task.rejectionCount} time(s)
                  </span>
                </div>
                {task.rejectionReason && (
                  <p className="mt-2 text-sm text-muted-foreground">{task.rejectionReason}</p>
                )}
              </div>
            )}

            <div>
              <label className="text-sm font-medium">Commit Message (optional)</label>
              <Textarea
                placeholder="Custom commit message..."
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                className="mt-1"
              />
            </div>
          </TabsContent>

          <TabsContent value="files" className="overflow-auto max-h-96">
            <div className="space-y-1">
              {diff?.files?.map((file) => (
                <div key={file.path} className="flex items-center gap-2 p-2 rounded hover:bg-muted">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <span className="flex-1 font-mono text-sm">{file.path}</span>
                  <span className="text-green-500 text-sm">+{file.insertions}</span>
                  <span className="text-red-500 text-sm">-{file.deletions}</span>
                </div>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="diff" className="overflow-auto max-h-96">
            <pre className="p-4 bg-muted rounded-lg font-mono text-sm whitespace-pre-wrap">
              {diff?.patch ?? 'No diff available'}
            </pre>
          </TabsContent>
        </Tabs>

        {showRejectForm ? (
          <div className="space-y-2">
            <label className="text-sm font-medium">Rejection Reason</label>
            <Textarea
              placeholder="Explain why this needs more work..."
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
          </div>
        ) : null}

        <DialogFooter>
          {showRejectForm ? (
            <>
              <Button variant="outline" onClick={() => setShowRejectForm(false)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={handleReject} disabled={!rejectReason.trim()}>
                <X className="h-4 w-4 mr-2" />
                Confirm Reject
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setShowRejectForm(true)}>
                <X className="h-4 w-4 mr-2" />
                Reject
              </Button>
              <Button onClick={handleApprove}>
                <Check className="h-4 w-4 mr-2" />
                Approve & Merge
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

### AgentSessionView (`components/features/agent-session-view.tsx`)

```typescript
import { useEffect, useRef, useState } from 'react';
import { Terminal, Code, User, Pause, Play, Square } from 'lucide-react';
import { useSession } from '@/hooks/use-session';
import { useAgentStream } from '@/hooks/use-agent-stream';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import type { AgentStatus } from '@/db/schema';

interface AgentSessionViewProps {
  sessionId: string;
  agentId: string;
  userId: string;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

export function AgentSessionView({
  sessionId,
  agentId,
  userId,
  onPause,
  onResume,
  onStop,
}: AgentSessionViewProps) {
  const { chunks, toolCalls, terminal, agentState, presence } = useSession(sessionId, userId);
  const streamRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [chunks, autoScroll]);

  const statusBadgeClass = {
    idle: 'bg-status-idle',
    starting: 'bg-status-running animate-pulse',
    running: 'bg-status-running',
    paused: 'bg-status-paused',
    error: 'bg-status-error',
    completed: 'bg-status-completed',
  }[agentState?.status ?? 'idle'];

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b p-4">
        <div className="flex items-center gap-3">
          <div className={cn('h-3 w-3 rounded-full', statusBadgeClass)} />
          <span className="font-medium capitalize">{agentState?.status ?? 'Idle'}</span>
          {agentState?.turn && (
            <span className="text-sm text-muted-foreground">Turn {agentState.turn}</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Presence indicators */}
          <div className="flex -space-x-2">
            {presence.map((user) => (
              <div
                key={user.userId}
                className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-background bg-muted"
                title={user.name}
              >
                <User className="h-4 w-4" />
              </div>
            ))}
          </div>

          {/* Controls */}
          {agentState?.status === 'running' && (
            <Button size="sm" variant="outline" onClick={onPause}>
              <Pause className="h-4 w-4" />
            </Button>
          )}
          {agentState?.status === 'paused' && (
            <Button size="sm" variant="outline" onClick={onResume}>
              <Play className="h-4 w-4" />
            </Button>
          )}
          {['running', 'paused'].includes(agentState?.status ?? '') && (
            <Button size="sm" variant="destructive" onClick={onStop}>
              <Square className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Content */}
      <Tabs defaultValue="stream" className="flex-1 flex flex-col">
        <TabsList className="mx-4 mt-4">
          <TabsTrigger value="stream">Stream</TabsTrigger>
          <TabsTrigger value="tools">Tools ({toolCalls.length})</TabsTrigger>
          <TabsTrigger value="terminal">Terminal</TabsTrigger>
        </TabsList>

        <TabsContent value="stream" className="flex-1 overflow-hidden px-4 pb-4">
          <div
            ref={streamRef}
            className="h-full overflow-y-auto rounded-lg border bg-muted/50 p-4 font-mono text-sm"
            onScroll={(e) => {
              const el = e.currentTarget;
              setAutoScroll(el.scrollHeight - el.scrollTop <= el.clientHeight + 50);
            }}
          >
            {chunks.map((chunk, i) => (
              <span key={i}>{chunk.text}</span>
            ))}
            {agentState?.status === 'running' && (
              <span className="inline-block h-4 w-2 animate-pulse bg-foreground" />
            )}
          </div>
        </TabsContent>

        <TabsContent value="tools" className="flex-1 overflow-auto px-4 pb-4">
          <div className="space-y-2">
            {toolCalls.map((call) => (
              <div key={call.id} className="rounded-lg border p-3">
                <div className="flex items-center gap-2">
                  <Code className="h-4 w-4" />
                  <span className="font-medium">{call.tool}</span>
                  <span
                    className={cn(
                      'ml-auto rounded-full px-2 py-0.5 text-xs',
                      call.status === 'complete' && 'bg-green-500/20 text-green-600',
                      call.status === 'running' && 'bg-blue-500/20 text-blue-600',
                      call.status === 'error' && 'bg-red-500/20 text-red-600'
                    )}
                  >
                    {call.status}
                  </span>
                </div>
                {call.output && (
                  <pre className="mt-2 rounded bg-muted p-2 text-xs overflow-auto max-h-40">
                    {JSON.stringify(call.output, null, 2)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="terminal" className="flex-1 overflow-hidden px-4 pb-4">
          <div className="h-full overflow-y-auto rounded-lg bg-black p-4 font-mono text-sm text-green-400">
            {terminal.map((line, i) => (
              <div key={i} className={line.type === 'stderr' ? 'text-red-400' : ''}>
                {line.data}
              </div>
            ))}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
```

### TaskDetailDialog (`components/features/task-detail-dialog.tsx`)

```typescript
import { useState } from 'react';
import { Save, Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { TextInput } from '@/components/ui/text-input';
import { Textarea } from '@/components/ui/textarea';
import type { Task } from '@/db/schema';

interface TaskDetailDialogProps {
  task: Task | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (task: Partial<Task>) => void;
  onDelete: (taskId: string) => void;
}

export function TaskDetailDialog({
  task,
  open,
  onOpenChange,
  onSave,
  onDelete,
}: TaskDetailDialogProps) {
  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [labels, setLabels] = useState(task?.labels?.join(', ') ?? '');

  const handleSave = () => {
    onSave({
      title,
      description,
      labels: labels
        .split(',')
        .map((l) => l.trim())
        .filter(Boolean),
    });
    onOpenChange(false);
  };

  const handleDelete = () => {
    if (task && confirm('Are you sure you want to delete this task?')) {
      onDelete(task.id);
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{task ? 'Edit Task' : 'New Task'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">Title</label>
            <TextInput
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Task title..."
              className="mt-1"
            />
          </div>

          <div>
            <label className="text-sm font-medium">Description</label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Task description..."
              className="mt-1"
              rows={4}
            />
          </div>

          <div>
            <label className="text-sm font-medium">Labels</label>
            <TextInput
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              placeholder="bug, feature, urgent"
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">Comma-separated labels</p>
          </div>
        </div>

        <DialogFooter>
          {task && (
            <Button variant="destructive" onClick={handleDelete} className="mr-auto">
              <Trash2 className="h-4 w-4 mr-2" />
              Delete
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!title.trim()}>
            <Save className="h-4 w-4 mr-2" />
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

### NewProjectDialog (`components/features/new-project-dialog.tsx`)

```typescript
import { useState } from 'react';
import { FolderOpen, Check, AlertCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { TextInput } from '@/components/ui/text-input';
import { Textarea } from '@/components/ui/textarea';

interface NewProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: { name: string; path: string; description?: string }) => void;
}

export function NewProjectDialog({ open, onOpenChange, onSubmit }: NewProjectDialogProps) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [description, setDescription] = useState('');
  const [pathStatus, setPathStatus] = useState<'idle' | 'valid' | 'invalid'>('idle');
  const [pathError, setPathError] = useState('');

  const validatePath = async (p: string) => {
    if (!p) {
      setPathStatus('idle');
      return;
    }

    try {
      const res = await fetch(`/api/projects/validate-path?path=${encodeURIComponent(p)}`);
      const data = await res.json();

      if (data.ok && data.data.valid) {
        setPathStatus('valid');
        setPathError('');
        if (!name && data.data.suggestedName) {
          setName(data.data.suggestedName);
        }
      } else {
        setPathStatus('invalid');
        setPathError(data.data?.reason ?? 'Invalid path');
      }
    } catch {
      setPathStatus('invalid');
      setPathError('Failed to validate path');
    }
  };

  const handleSubmit = () => {
    onSubmit({ name, path, description: description || undefined });
    onOpenChange(false);
    setName('');
    setPath('');
    setDescription('');
    setPathStatus('idle');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Project</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">Project Path</label>
            <div className="relative mt-1">
              <TextInput
                value={path}
                onChange={(e) => {
                  setPath(e.target.value);
                  setPathStatus('idle');
                }}
                onBlur={() => validatePath(path)}
                placeholder="/path/to/project"
                className="pr-10"
              />
              <div className="absolute right-3 top-1/2 -translate-y-1/2">
                {pathStatus === 'valid' && <Check className="h-4 w-4 text-green-500" />}
                {pathStatus === 'invalid' && <AlertCircle className="h-4 w-4 text-red-500" />}
              </div>
            </div>
            {pathStatus === 'invalid' && (
              <p className="text-xs text-red-500 mt-1">{pathError}</p>
            )}
          </div>

          <div>
            <label className="text-sm font-medium">Project Name</label>
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Project"
              className="mt-1"
            />
          </div>

          <div>
            <label className="text-sm font-medium">Description (optional)</label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Project description..."
              className="mt-1"
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!name.trim() || pathStatus !== 'valid'}>
            <FolderOpen className="h-4 w-4 mr-2" />
            Create Project
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

### ProjectPicker (`components/features/project-picker.tsx`)

```typescript
import { useState } from 'react';
import { Check, ChevronsUpDown, Plus, FolderKanban } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { Project } from '@/db/schema';

interface ProjectPickerProps {
  projects: Project[];
  selectedProject: Project | null;
  onSelect: (project: Project) => void;
  onNewProject: () => void;
}

export function ProjectPicker({
  projects,
  selectedProject,
  onSelect,
  onNewProject,
}: ProjectPickerProps) {
  const [open, setOpen] = useState(false);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="w-64 justify-between">
          <div className="flex items-center gap-2">
            <FolderKanban className="h-4 w-4" />
            <span className="truncate">{selectedProject?.name ?? 'Select project'}</span>
          </div>
          <ChevronsUpDown className="h-4 w-4 opacity-50" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent className="w-64">
        {projects.map((project) => (
          <DropdownMenuItem
            key={project.id}
            onClick={() => {
              onSelect(project);
              setOpen(false);
            }}
          >
            <Check
              className={cn(
                'mr-2 h-4 w-4',
                selectedProject?.id === project.id ? 'opacity-100' : 'opacity-0'
              )}
            />
            <span className="truncate">{project.name}</span>
          </DropdownMenuItem>
        ))}

        {projects.length > 0 && <DropdownMenuSeparator />}

        <DropdownMenuItem onClick={onNewProject}>
          <Plus className="mr-2 h-4 w-4" />
          New Project
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

### AgentConfigDialog (`components/features/agent-config-dialog.tsx`)

```typescript
import { useState } from 'react';
import { Settings, Save } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { TextInput } from '@/components/ui/text-input';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { Agent, AgentConfig } from '@/db/schema';

interface AgentConfigDialogProps {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (config: AgentConfig) => void;
}

const TOOL_CATEGORIES = {
  'File Operations': ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
  'System': ['Bash'],
  'Web': ['WebFetch', 'WebSearch'],
  'Agent': ['Task'],
};

export function AgentConfigDialog({ agent, open, onOpenChange, onSave }: AgentConfigDialogProps) {
  const [config, setConfig] = useState<AgentConfig>(agent.config ?? {});
  const [tab, setTab] = useState<'execution' | 'tools' | 'prompts'>('execution');

  const handleSave = () => {
    onSave(config);
    onOpenChange(false);
  };

  const toggleTool = (tool: string) => {
    const currentTools = config.allowedTools ?? [];
    const newTools = currentTools.includes(tool)
      ? currentTools.filter((t) => t !== tool)
      : [...currentTools, tool];
    setConfig({ ...config, allowedTools: newTools });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            Configure {agent.name}
          </DialogTitle>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList>
            <TabsTrigger value="execution">Execution</TabsTrigger>
            <TabsTrigger value="tools">Tools</TabsTrigger>
            <TabsTrigger value="prompts">Prompts</TabsTrigger>
          </TabsList>

          <TabsContent value="execution" className="space-y-4">
            <div>
              <label className="text-sm font-medium">Max Turns</label>
              <div className="flex items-center gap-4 mt-2">
                <input
                  type="range"
                  min={10}
                  max={500}
                  value={config.maxTurns ?? 50}
                  onChange={(e) => setConfig({ ...config, maxTurns: Number(e.target.value) })}
                  className="flex-1"
                />
                <span className="w-12 text-right font-mono">{config.maxTurns ?? 50}</span>
              </div>
            </div>

            <div>
              <label className="text-sm font-medium">Model</label>
              <select
                value={config.model ?? 'claude-sonnet-4-6'}
                onChange={(e) => setConfig({ ...config, model: e.target.value })}
                className="mt-1 w-full rounded-md border bg-background px-3 py-2"
              >
                <option value="claude-sonnet-4-6">Claude Sonnet 4</option>
                <option value="claude-opus-4-20250514">Claude Opus 4</option>
                <option value="claude-haiku-3-5-20240307">Claude Haiku 3.5</option>
              </select>
            </div>

            <div>
              <label className="text-sm font-medium">Temperature</label>
              <div className="flex items-center gap-4 mt-2">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={(config.temperature ?? 0) * 100}
                  onChange={(e) => setConfig({ ...config, temperature: Number(e.target.value) / 100 })}
                  className="flex-1"
                />
                <span className="w-12 text-right font-mono">{(config.temperature ?? 0).toFixed(2)}</span>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="tools" className="space-y-4">
            {Object.entries(TOOL_CATEGORIES).map(([category, tools]) => (
              <div key={category}>
                <h4 className="text-sm font-medium mb-2">{category}</h4>
                <div className="grid grid-cols-3 gap-2">
                  {tools.map((tool) => (
                    <label key={tool} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={config.allowedTools?.includes(tool) ?? false}
                        onCheckedChange={() => toggleTool(tool)}
                      />
                      {tool}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </TabsContent>

          <TabsContent value="prompts" className="space-y-4">
            <div>
              <label className="text-sm font-medium">System Prompt</label>
              <Textarea
                value={config.systemPrompt ?? ''}
                onChange={(e) => setConfig({ ...config, systemPrompt: e.target.value })}
                placeholder="Custom system prompt..."
                className="mt-1"
                rows={8}
              />
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave}>
            <Save className="h-4 w-4 mr-2" />
            Save Configuration
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

### ThemeToggle (`components/features/theme-toggle.tsx`)

```typescript
import { useEffect, useState } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import { cn } from '@/lib/utils';

type Theme = 'light' | 'dark' | 'system';

interface ThemeToggleProps {
  className?: string;
}

export function ThemeToggle({ className }: ThemeToggleProps) {
  const [theme, setTheme] = useState<Theme>('system');

  useEffect(() => {
    const stored = localStorage.getItem('theme') as Theme | null;
    if (stored) setTheme(stored);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    localStorage.setItem('theme', theme);

    if (theme === 'system') {
      const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.setAttribute('data-theme', systemDark ? 'dark' : 'light');
    } else {
      root.setAttribute('data-theme', theme);
    }
  }, [theme]);

  const options: { value: Theme; icon: typeof Sun; label: string }[] = [
    { value: 'light', icon: Sun, label: 'Light' },
    { value: 'dark', icon: Moon, label: 'Dark' },
    { value: 'system', icon: Monitor, label: 'System' },
  ];

  return (
    <div className={cn('inline-flex rounded-lg border bg-muted p-1', className)}>
      {options.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          onClick={() => setTheme(value)}
          className={cn(
            'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors',
            theme === value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
          aria-label={`Set ${label} theme`}
        >
          <Icon className="h-4 w-4" />
          <span className="hidden sm:inline">{label}</span>
        </button>
      ))}
    </div>
  );
}

// Provider for theme context
import { createContext, useContext, type ReactNode } from 'react';

const ThemeContext = createContext<{
  theme: Theme;
  setTheme: (theme: Theme) => void;
}>({ theme: 'system', setTheme: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>('system');

  useEffect(() => {
    const stored = localStorage.getItem('theme') as Theme | null;
    if (stored) setTheme(stored);
  }, []);

  useEffect(() => {
    localStorage.setItem('theme', theme);
    const root = document.documentElement;

    if (theme === 'system') {
      const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.setAttribute('data-theme', systemDark ? 'dark' : 'light');
    } else {
      root.setAttribute('data-theme', theme);
    }
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
```

### EmptyState (`components/features/empty-state.tsx`)

```typescript
import { cva, type VariantProps } from 'class-variance-authority';
import {
  FolderOpen, ListTodo, Bot, MessageSquare, Search, AlertTriangle, WifiOff, Rocket,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const emptyStateVariants = cva(
  'flex flex-col items-center justify-center text-center p-8',
  {
    variants: {
      size: {
        sm: 'gap-3 py-6',
        md: 'gap-4 py-8',
        lg: 'gap-6 py-12',
      },
    },
    defaultVariants: {
      size: 'md',
    },
  }
);

type EmptyStatePreset =
  | 'first-run'
  | 'no-projects'
  | 'no-tasks'
  | 'no-agents'
  | 'empty-session'
  | 'no-results'
  | 'error'
  | 'offline';

interface EmptyStateProps extends VariantProps<typeof emptyStateVariants> {
  preset?: EmptyStatePreset;
  icon?: React.ComponentType<{ className?: string }>;
  title?: string;
  subtitle?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
  className?: string;
}

const PRESETS: Record<EmptyStatePreset, {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
}> = {
  'first-run': {
    icon: Rocket,
    title: 'Welcome to AgentPane',
    subtitle: 'Get started by creating your first project',
  },
  'no-projects': {
    icon: FolderOpen,
    title: 'No projects yet',
    subtitle: 'Create a project to start managing tasks',
  },
  'no-tasks': {
    icon: ListTodo,
    title: 'No tasks in this column',
    subtitle: 'Create a task or drag one here',
  },
  'no-agents': {
    icon: Bot,
    title: 'No agents configured',
    subtitle: 'Add an agent to start automating tasks',
  },
  'empty-session': {
    icon: MessageSquare,
    title: 'No session activity',
    subtitle: 'Agent output will appear here',
  },
  'no-results': {
    icon: Search,
    title: 'No results found',
    subtitle: 'Try adjusting your search or filters',
  },
  'error': {
    icon: AlertTriangle,
    title: 'Something went wrong',
    subtitle: 'Please try again or contact support',
  },
  'offline': {
    icon: WifiOff,
    title: 'You\'re offline',
    subtitle: 'Check your connection and try again',
  },
};

export function EmptyState({
  preset,
  icon,
  title,
  subtitle,
  action,
  size,
  className,
}: EmptyStateProps) {
  const presetConfig = preset ? PRESETS[preset] : null;
  const Icon = icon ?? presetConfig?.icon ?? FolderOpen;
  const displayTitle = title ?? presetConfig?.title ?? 'Nothing here';
  const displaySubtitle = subtitle ?? presetConfig?.subtitle ?? '';

  return (
    <div className={cn(emptyStateVariants({ size }), className)}>
      <div className="rounded-full bg-muted p-4">
        <Icon className="h-8 w-8 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <h3 className="text-lg font-semibold">{displayTitle}</h3>
        <p className="text-sm text-muted-foreground max-w-sm">{displaySubtitle}</p>
      </div>
      {action && (
        <Button onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
```

### ProjectSettings (`components/features/project-settings.tsx`)

```typescript
import { useState } from 'react';
import { Settings, Save, Trash2 } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { TextInput } from '@/components/ui/text-input';
import { Textarea } from '@/components/ui/textarea';
import type { Project, ProjectConfig } from '@/db/schema';

interface ProjectSettingsProps {
  project: Project;
  onSave: (project: Partial<Project>) => void;
  onDelete: () => void;
}

export function ProjectSettings({ project, onSave, onDelete }: ProjectSettingsProps) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [maxConcurrent, setMaxConcurrent] = useState(project.maxConcurrentAgents ?? 3);
  const [config, setConfig] = useState<ProjectConfig>(project.config ?? {});
  const [tab, setTab] = useState<'project' | 'agents' | 'config'>('project');

  const handleSave = () => {
    onSave({
      name,
      description: description || undefined,
      maxConcurrentAgents: maxConcurrent,
      config,
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <Settings className="h-5 w-5" />
          Project Settings
        </h2>
        <div className="flex gap-2">
          <Button variant="destructive" onClick={onDelete}>
            <Trash2 className="h-4 w-4 mr-2" />
            Delete Project
          </Button>
          <Button onClick={handleSave}>
            <Save className="h-4 w-4 mr-2" />
            Save Changes
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="project">Project</TabsTrigger>
          <TabsTrigger value="agents">Agents</TabsTrigger>
          <TabsTrigger value="config">Configuration</TabsTrigger>
        </TabsList>

        <TabsContent value="project" className="space-y-4">
          <div>
            <label className="text-sm font-medium">Project Name</label>
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Description</label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="mt-1"
              rows={3}
            />
          </div>
          <div>
            <label className="text-sm font-medium">Project Path</label>
            <TextInput value={project.path} disabled className="mt-1 bg-muted" />
            <p className="text-xs text-muted-foreground mt-1">Path cannot be changed</p>
          </div>
        </TabsContent>

        <TabsContent value="agents" className="space-y-4">
          <div>
            <label className="text-sm font-medium">Max Concurrent Agents</label>
            <div className="flex items-center gap-4 mt-2">
              <input
                type="range"
                min={1}
                max={10}
                value={maxConcurrent}
                onChange={(e) => setMaxConcurrent(Number(e.target.value))}
                className="flex-1"
              />
              <span className="w-8 text-right font-mono">{maxConcurrent}</span>
            </div>
          </div>
          <div>
            <label className="text-sm font-medium">Default Max Turns</label>
            <div className="flex items-center gap-4 mt-2">
              <input
                type="range"
                min={10}
                max={500}
                value={config.maxTurns ?? 50}
                onChange={(e) => setConfig({ ...config, maxTurns: Number(e.target.value) })}
                className="flex-1"
              />
              <span className="w-12 text-right font-mono">{config.maxTurns ?? 50}</span>
            </div>
          </div>
        </TabsContent>

        <TabsContent value="config" className="space-y-4">
          <div>
            <label className="text-sm font-medium">Worktree Root</label>
            <TextInput
              value={config.worktreeRoot ?? '.worktrees'}
              onChange={(e) => setConfig({ ...config, worktreeRoot: e.target.value })}
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Default Branch</label>
            <TextInput
              value={config.defaultBranch ?? 'main'}
              onChange={(e) => setConfig({ ...config, defaultBranch: e.target.value })}
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-sm font-medium">Init Script (optional)</label>
            <TextInput
              value={config.initScript ?? ''}
              onChange={(e) => setConfig({ ...config, initScript: e.target.value })}
              placeholder="bun install"
              className="mt-1"
            />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
```

### SessionHistory (`components/features/session-history.tsx`)

```typescript
import { useState } from 'react';
import { Clock, Filter, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TextInput } from '@/components/ui/text-input';
import { cn } from '@/lib/utils';
import type { Session } from '@/db/schema';

interface SessionHistoryProps {
  sessions: Session[];
  onSessionSelect: (session: Session) => void;
  onExport?: (format: 'json' | 'csv') => void;
}

const STATUS_STYLES: Record<string, { dot: string; badge: string }> = {
  idle: { dot: 'bg-slate-500', badge: 'bg-slate-500/15 text-slate-400' },
  initializing: { dot: 'bg-blue-500', badge: 'bg-blue-500/15 text-blue-400' },
  active: { dot: 'bg-green-500 animate-pulse', badge: 'bg-green-500/15 text-green-400' },
  paused: { dot: 'bg-amber-500', badge: 'bg-amber-500/15 text-amber-400' },
  closed: { dot: 'bg-purple-500', badge: 'bg-purple-500/15 text-purple-400' },
  error: { dot: 'bg-red-500', badge: 'bg-red-500/15 text-red-400' },
};

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return tokens.toString();
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export function SessionHistory({ sessions, onSessionSelect, onExport }: SessionHistoryProps) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string[]>([]);

  const filteredSessions = sessions.filter((session) => {
    if (search && !session.title?.toLowerCase().includes(search.toLowerCase())) return false;
    if (statusFilter.length > 0 && !statusFilter.includes(session.status)) return false;
    return true;
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <Clock className="h-5 w-5" />
          Session History
        </h2>
        {onExport && (
          <Button variant="outline" size="sm" onClick={() => onExport('json')}>
            <Download className="h-4 w-4 mr-2" />
            Export
          </Button>
        )}
      </div>

      <div className="flex gap-2">
        <TextInput
          placeholder="Search sessions..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1"
        />
        <Button variant="outline" size="icon">
          <Filter className="h-4 w-4" />
        </Button>
      </div>

      <div className="space-y-2">
        {filteredSessions.map((session) => {
          const styles = STATUS_STYLES[session.status] ?? STATUS_STYLES.idle;
          return (
            <button
              key={session.id}
              onClick={() => onSessionSelect(session)}
              className="w-full rounded-lg border p-4 text-left hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <div className={cn('h-3 w-3 rounded-full', styles.dot)} />
                  <span className="font-mono text-sm text-muted-foreground">
                    #{session.id.slice(-6)}
                  </span>
                </div>
                <span className="text-sm text-muted-foreground">
                  {new Date(session.createdAt).toLocaleDateString()}
                </span>
              </div>
              <p className="font-medium mt-1">{session.title ?? 'Untitled Session'}</p>
              <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground">
                <span className={cn('rounded-full px-2 py-0.5 text-xs', styles.badge)}>
                  {session.status}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
```

### WorktreeManagement (`components/features/worktree-management.tsx`)

```typescript
import { useState } from 'react';
import { GitBranch, Plus, Merge, Trash2, FolderOpen, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { Worktree, WorktreeStatus } from '@/db/schema';

interface WorktreeManagementProps {
  worktrees: Worktree[];
  onOpen: (worktree: Worktree) => void;
  onMerge: (worktree: Worktree, options: MergeOptions) => void;
  onRemove: (worktree: Worktree, force?: boolean) => void;
  onCreate: () => void;
}

interface MergeOptions {
  targetBranch: string;
  deleteAfterMerge: boolean;
  squash: boolean;
  commitMessage?: string;
}

const STATUS_CONFIG: Record<WorktreeStatus, { icon: string; color: string; actions: string[] }> = {
  creating: { icon: '⏳', color: 'text-blue-500', actions: ['cancel'] },
  initializing: { icon: '⏳', color: 'text-blue-500', actions: ['cancel'] },
  active: { icon: '🌿', color: 'text-green-500', actions: ['open', 'merge', 'remove'] },
  dirty: { icon: '🟠', color: 'text-orange-500', actions: ['open', 'commit', 'remove'] },
  committing: { icon: '⏳', color: 'text-blue-500', actions: [] },
  merging: { icon: '⏳', color: 'text-purple-500', actions: ['cancel'] },
  conflict: { icon: '⚠', color: 'text-red-500', actions: ['open', 'resolve', 'abort'] },
  removing: { icon: '⏳', color: 'text-gray-500', actions: [] },
  removed: { icon: '✓', color: 'text-gray-400', actions: [] },
  error: { icon: '✗', color: 'text-red-500', actions: ['retry', 'force-remove'] },
};

export function WorktreeManagement({
  worktrees,
  onOpen,
  onMerge,
  onRemove,
  onCreate,
}: WorktreeManagementProps) {
  const [mergeWorktree, setMergeWorktree] = useState<Worktree | null>(null);
  const [mergeOptions, setMergeOptions] = useState<MergeOptions>({
    targetBranch: 'main',
    deleteAfterMerge: true,
    squash: false,
  });

  const activeWorktrees = worktrees.filter((w) => !['removed', 'removing'].includes(w.status));
  const staleWorktrees = worktrees.filter((w) => {
    const age = Date.now() - new Date(w.updatedAt).getTime();
    return age > 7 * 24 * 60 * 60 * 1000 && w.status === 'active';
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <GitBranch className="h-5 w-5" />
          Worktrees
        </h2>
        <Button onClick={onCreate}>
          <Plus className="h-4 w-4 mr-2" />
          Create
        </Button>
      </div>

      <div className="space-y-4">
        <div className="rounded-lg border">
          <div className="border-b px-4 py-2 bg-muted/50">
            <h3 className="font-medium">Active Worktrees ({activeWorktrees.length})</h3>
          </div>
          <div className="divide-y">
            {activeWorktrees.map((worktree) => {
              const config = STATUS_CONFIG[worktree.status];
              return (
                <div key={worktree.id} className="p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <span className={config.color}>{config.icon}</span>
                      <span className="font-mono text-sm text-blue-500">{worktree.branch}</span>
                    </div>
                    <span className={cn('rounded-full px-2 py-0.5 text-xs',
                      worktree.status === 'active' && 'bg-green-500/15 text-green-400',
                      worktree.status === 'dirty' && 'bg-orange-500/15 text-orange-400',
                      worktree.status === 'conflict' && 'bg-red-500/15 text-red-400'
                    )}>
                      {worktree.status}
                    </span>
                  </div>
                  <div className="mt-2 flex gap-2">
                    {config.actions.includes('open') && (
                      <Button size="sm" variant="outline" onClick={() => onOpen(worktree)}>
                        <FolderOpen className="h-3 w-3 mr-1" />
                        Open
                      </Button>
                    )}
                    {config.actions.includes('merge') && (
                      <Button size="sm" variant="outline" onClick={() => setMergeWorktree(worktree)}>
                        <Merge className="h-3 w-3 mr-1" />
                        Merge
                      </Button>
                    )}
                    {config.actions.includes('remove') && (
                      <Button size="sm" variant="ghost" onClick={() => onRemove(worktree)}>
                        <Trash2 className="h-3 w-3 mr-1" />
                        Remove
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {staleWorktrees.length > 0 && (
          <div className="rounded-lg border border-amber-500/50">
            <div className="border-b px-4 py-2 bg-amber-500/10 flex items-center justify-between">
              <h3 className="font-medium flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                Stale Worktrees ({staleWorktrees.length})
              </h3>
              <Button size="sm" variant="outline">Prune All</Button>
            </div>
          </div>
        )}
      </div>

      <Dialog open={!!mergeWorktree} onOpenChange={(open) => !open && setMergeWorktree(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Merge Worktree</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Branch</label>
              <p className="font-mono text-sm text-blue-500 mt-1">{mergeWorktree?.branch}</p>
            </div>
            <div>
              <label className="text-sm font-medium">Target Branch</label>
              <select
                value={mergeOptions.targetBranch}
                onChange={(e) => setMergeOptions({ ...mergeOptions, targetBranch: e.target.value })}
                className="mt-1 w-full rounded-md border bg-background px-3 py-2"
              >
                <option value="main">main</option>
                <option value="develop">develop</option>
              </select>
            </div>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={mergeOptions.deleteAfterMerge}
                  onCheckedChange={(c) => setMergeOptions({ ...mergeOptions, deleteAfterMerge: !!c })}
                />
                Delete worktree after merge
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={mergeOptions.squash}
                  onCheckedChange={(c) => setMergeOptions({ ...mergeOptions, squash: !!c })}
                />
                Squash commits
              </label>
            </div>
            {mergeOptions.squash && (
              <div>
                <label className="text-sm font-medium">Commit Message</label>
                <Textarea
                  value={mergeOptions.commitMessage ?? ''}
                  onChange={(e) => setMergeOptions({ ...mergeOptions, commitMessage: e.target.value })}
                  className="mt-1"
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMergeWorktree(null)}>Cancel</Button>
            <Button onClick={() => {
              if (mergeWorktree) onMerge(mergeWorktree, mergeOptions);
              setMergeWorktree(null);
            }}>
              Merge to {mergeOptions.targetBranch}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
```

### QueueWaitingState (`components/features/queue-waiting-state.tsx`)

```typescript
import { Clock, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface RunningAgentInfo {
  id: string;
  name: string;
  taskTitle: string;
  progress: number;
  currentTurn: number;
  maxTurns: number;
}

interface QueueWaitingStateProps {
  position: number;
  queueLength: number;
  task: { id: string; title: string };
  runningAgents: RunningAgentInfo[];
  maxConcurrent: number;
  onCancel?: () => void;
  estimatedWait?: number;
}

function formatEstimatedWait(ms: number): string {
  const minutes = Math.ceil(ms / 60000);
  if (minutes < 1) return 'Less than a minute';
  if (minutes === 1) return 'About 1 minute';
  if (minutes < 60) return `About ${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  return `About ${hours} hour${hours > 1 ? 's' : ''}`;
}

function getProgressColor(progress: number): string {
  if (progress >= 90) return 'bg-purple-500';
  if (progress >= 75) return 'bg-amber-500';
  if (progress >= 25) return 'bg-green-500';
  return 'bg-blue-500';
}

export function QueueWaitingState({
  position,
  queueLength,
  task,
  runningAgents,
  maxConcurrent,
  onCancel,
  estimatedWait,
}: QueueWaitingStateProps) {
  return (
    <div className="flex flex-col items-center justify-center p-8 text-center">
      {/* Position Badge */}
      <div className="w-32 h-32 rounded-2xl border-2 border-dashed border-slate-600 bg-slate-800 flex flex-col items-center justify-center mb-6 animate-bounce-gentle">
        <Clock className="h-8 w-8 text-muted-foreground mb-2" />
        <span className="text-4xl font-bold">#{position}</span>
        <span className="text-sm text-muted-foreground">in queue</span>
      </div>

      <h2 className="text-xl font-semibold mb-2">Waiting for an available agent</h2>
      <p className="text-muted-foreground mb-6">
        Your task "{task.title}" is queued
      </p>

      {estimatedWait && (
        <p className="text-sm text-muted-foreground mb-6">
          Estimated wait: {formatEstimatedWait(estimatedWait)}
        </p>
      )}

      {/* Running Agents */}
      <div className="w-full max-w-xl rounded-lg border">
        <div className="border-b px-4 py-2 bg-muted/50">
          <h3 className="font-medium">Currently Running ({runningAgents.length}/{maxConcurrent})</h3>
        </div>
        <div className="divide-y">
          {runningAgents.map((agent) => (
            <div key={agent.id} className="p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                  <span className="font-medium">{agent.name}</span>
                </div>
                <span className="text-sm text-muted-foreground">
                  Turn {agent.currentTurn}/{agent.maxTurns}
                </span>
              </div>
              <p className="text-sm text-muted-foreground mb-2 truncate">"{agent.taskTitle}"</p>
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1 rounded-full bg-muted overflow-hidden">
                  <div
                    className={cn('h-full rounded-full transition-all', getProgressColor(agent.progress))}
                    style={{ width: `${agent.progress}%` }}
                  />
                </div>
                <span className="text-xs text-muted-foreground w-10 text-right">
                  {agent.progress}%
                </span>
                {agent.progress >= 90 && (
                  <span className="text-xs text-purple-400">Finishing soon</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {onCancel && (
        <Button variant="outline" onClick={onCancel} className="mt-6">
          <X className="h-4 w-4 mr-2" />
          Cancel Queue
        </Button>
      )}
    </div>
  );
}
```

### GitHubAppSetup (`components/features/github-app-setup.tsx`)

```typescript
import { useState } from 'react';
import { Github, Check, RefreshCw, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type ConnectionState = 'disconnected' | 'connecting' | 'selecting' | 'connected';

interface GitHubInstallation {
  id: string;
  installationId: number;
  accountLogin: string;
  accountType: 'User' | 'Organization';
  avatarUrl?: string;
  repositoryCount: number;
}

interface GitHubAppSetupProps {
  connectionState: ConnectionState;
  installations?: GitHubInstallation[];
  selectedInstallation?: GitHubInstallation;
  lastSyncedAt?: Date;
  onConnect: () => void;
  onSelectInstallation: (id: string) => void;
  onSyncNow: () => void;
  onDisconnect: () => void;
}

export function GitHubAppSetup({
  connectionState,
  installations = [],
  selectedInstallation,
  lastSyncedAt,
  onConnect,
  onSelectInstallation,
  onSyncNow,
  onDisconnect,
}: GitHubAppSetupProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (connectionState === 'disconnected') {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center">
        <div className="w-24 h-24 rounded-full border-2 border-dashed border-slate-600 flex items-center justify-center mb-6">
          <Github className="h-12 w-12 text-muted-foreground" />
        </div>
        <h2 className="text-xl font-semibold mb-2">Connect to GitHub</h2>
        <p className="text-muted-foreground mb-6 max-w-md">
          Install the AgentPane GitHub App to enable configuration sync, automatic pull requests, and repository management.
        </p>
        <Button onClick={onConnect} size="lg">
          <Github className="h-5 w-5 mr-2" />
          Connect with GitHub
        </Button>

        <div className="grid grid-cols-3 gap-4 mt-8 max-w-lg">
          {[
            { icon: '🔄', title: 'Config Sync', desc: 'Automatically sync agent configuration from your repository' },
            { icon: '🔀', title: 'Pull Requests', desc: 'Create PRs automatically when agents complete tasks' },
            { icon: '📄', title: 'Webhooks', desc: 'Receive push events to auto-update configurations' },
          ].map((feature) => (
            <div key={feature.title} className="rounded-lg border p-4 text-left">
              <div className="text-2xl mb-2">{feature.icon}</div>
              <h3 className="font-medium text-sm">{feature.title}</h3>
              <p className="text-xs text-muted-foreground mt-1">{feature.desc}</p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (connectionState === 'connecting') {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center">
        <div className="flex items-center gap-4 mb-6">
          <div className="flex items-center justify-center w-12 h-12 rounded-full bg-green-500/20 text-green-500">
            <Check className="h-6 w-6" />
          </div>
          <div className="h-0.5 w-16 bg-muted" />
          <div className="flex items-center justify-center w-12 h-12 rounded-full border-2 border-blue-500 animate-spin">
            <RefreshCw className="h-6 w-6 text-blue-500" />
          </div>
          <div className="h-0.5 w-16 bg-muted" />
          <div className="flex items-center justify-center w-12 h-12 rounded-full bg-muted text-muted-foreground">
            <span>3</span>
          </div>
        </div>
        <h2 className="text-xl font-semibold mb-2">Complete Installation on GitHub</h2>
        <p className="text-muted-foreground mb-6">
          Select the account/organization and repositories in the GitHub window.
        </p>
        <Button variant="outline" onClick={() => {}}>Cancel</Button>
      </div>
    );
  }

  if (connectionState === 'selecting') {
    return (
      <div className="p-6 max-w-lg mx-auto">
        <h2 className="text-xl font-semibold mb-4">Select Installation</h2>
        <p className="text-muted-foreground mb-6">
          Choose which GitHub account or organization to connect:
        </p>
        <div className="space-y-2">
          {installations.map((installation) => (
            <button
              key={installation.id}
              onClick={() => setSelectedId(installation.id)}
              className={cn(
                'w-full rounded-lg border p-4 text-left transition-colors',
                selectedId === installation.id ? 'border-blue-500 bg-blue-500/10' : 'hover:bg-muted/50'
              )}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                    {installation.accountType === 'User' ? '👤' : '🏢'}
                  </div>
                  <div>
                    <p className="font-medium">{installation.accountLogin}</p>
                    <p className="text-sm text-muted-foreground">
                      {installation.repositoryCount} repositories accessible
                    </p>
                  </div>
                </div>
                <span className="text-xs bg-muted px-2 py-1 rounded">
                  {installation.accountType}
                </span>
              </div>
            </button>
          ))}
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <Button variant="outline" onClick={() => {}}>Cancel</Button>
          <Button
            onClick={() => selectedId && onSelectInstallation(selectedId)}
            disabled={!selectedId}
          >
            Continue
          </Button>
        </div>
      </div>
    );
  }

  // Connected state
  return (
    <div className="space-y-6 p-6">
      <div className="rounded-lg border border-green-500/50 bg-green-500/10 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Check className="h-5 w-5 text-green-500" />
            <span className="font-medium">GitHub Connected</span>
          </div>
          <Button size="sm" variant="outline" onClick={onSyncNow}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Sync Now
          </Button>
        </div>
        {lastSyncedAt && (
          <p className="text-sm text-muted-foreground mt-2">
            Last synced {new Date(lastSyncedAt).toLocaleString()}
          </p>
        )}
      </div>

      {selectedInstallation && (
        <div className="rounded-lg border p-4">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
              {selectedInstallation.accountType === 'User' ? '👤' : '🏢'}
            </div>
            <div>
              <p className="font-medium">{selectedInstallation.accountLogin}</p>
              <p className="text-sm text-muted-foreground">
                {selectedInstallation.repositoryCount} repositories
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-red-500/50">
        <div className="p-4">
          <h3 className="font-medium text-red-500">Danger Zone</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Disconnect GitHub and revoke all access tokens
          </p>
          <Button variant="destructive" size="sm" onClick={onDisconnect} className="mt-3">
            <LogOut className="h-4 w-4 mr-2" />
            Disconnect
          </Button>
        </div>
      </div>
    </div>
  );
}
```

### ErrorState (`components/features/error-state.tsx`)

```typescript
import { useState } from 'react';
import { AlertTriangle, Copy, RefreshCw, SkipForward, X, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { AgentRun, Task } from '@/db/schema';

interface AgentError {
  code: string;
  type: string;
  message: string;
  location?: { file: string; line: number; column?: number };
  stackTrace?: string;
  timestamp: Date;
}

interface ActivityLogEntry {
  id: string;
  timestamp: Date;
  type: 'read' | 'edit' | 'bash' | 'result' | 'stdout' | 'stderr' | 'error';
  message: string;
}

interface RetryOptions {
  feedback?: string;
  fromCheckpoint: boolean;
  increaseTurns: boolean;
  useStrongerModel: boolean;
}

interface ErrorStateProps {
  agentRun: AgentRun;
  task: Task;
  error: AgentError;
  activityLog: ActivityLogEntry[];
  onRetry?: (options: RetryOptions) => void;
  onSkip?: () => void;
  onAbort?: () => void;
  onViewLogs?: () => void;
}

const LOG_TYPE_STYLES: Record<string, { color: string; icon: string }> = {
  read: { color: 'text-blue-400', icon: '📖' },
  edit: { color: 'text-purple-400', icon: '✏️' },
  bash: { color: 'text-green-400', icon: '⌨️' },
  result: { color: 'text-green-400', icon: '✓' },
  stdout: { color: 'text-gray-400', icon: '→' },
  stderr: { color: 'text-amber-400', icon: '⚠' },
  error: { color: 'text-red-400', icon: '✗' },
};

export function ErrorState({
  agentRun,
  task,
  error,
  activityLog,
  onRetry,
  onSkip,
  onAbort,
  onViewLogs,
}: ErrorStateProps) {
  const [feedback, setFeedback] = useState('');
  const [fromCheckpoint, setFromCheckpoint] = useState(true);
  const [increaseTurns, setIncreaseTurns] = useState(false);
  const [useStrongerModel, setUseStrongerModel] = useState(false);

  const copyStackTrace = () => {
    if (error.stackTrace) {
      navigator.clipboard.writeText(error.stackTrace);
    }
  };

  const handleRetry = () => {
    onRetry?.({
      feedback: feedback || undefined,
      fromCheckpoint,
      increaseTurns,
      useStrongerModel,
    });
  };

  const duration = agentRun.completedAt
    ? Math.floor((new Date(agentRun.completedAt).getTime() - new Date(agentRun.startedAt).getTime()) / 1000)
    : 0;

  return (
    <div className="h-full flex flex-col" role="alert">
      {/* Error Banner */}
      <div className="bg-gradient-to-r from-red-600 to-red-900 border-b border-red-500 p-6">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-red-900 flex items-center justify-center">
            <X className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Agent Failed</h1>
            <p className="text-red-200">
              #{task.id.slice(-6)} "{task.title}"
            </p>
            <p className="text-sm text-red-300">
              Failed at Turn {agentRun.turnsUsed} · Duration: {Math.floor(duration / 60)}m {duration % 60}s
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        <div className="grid grid-cols-3 gap-6">
          {/* Left: Error Details and Stack Trace */}
          <div className="col-span-2 space-y-4">
            {/* Error Details */}
            <div className="rounded-lg border p-4">
              <h3 className="font-medium mb-3">Error Details</h3>
              <div className="inline-flex items-center gap-2 rounded-full bg-red-500/15 px-3 py-1 text-red-400 text-sm font-mono mb-3">
                <span>⬡</span>
                {error.type}
              </div>
              <div className="bg-slate-900 border-l-4 border-red-500 p-4 rounded">
                <p className="font-medium">{error.message}</p>
              </div>
              {error.location && (
                <p className="text-sm text-muted-foreground mt-2">
                  📄 {error.location.file}:{error.location.line}
                </p>
              )}
            </div>

            {/* Stack Trace */}
            {error.stackTrace && (
              <div className="rounded-lg border">
                <div className="flex items-center justify-between border-b px-4 py-2">
                  <h3 className="font-medium">Stack Trace</h3>
                  <Button size="sm" variant="ghost" onClick={copyStackTrace}>
                    <Copy className="h-4 w-4 mr-1" />
                    Copy
                  </Button>
                </div>
                <pre className="p-4 text-sm font-mono overflow-auto max-h-48 whitespace-pre-wrap">
                  {error.stackTrace.split('\n').map((line, i) => (
                    <div key={i} className={cn(
                      i === 0 && 'text-red-400',
                      line.includes('at ') && 'text-muted-foreground',
                      line.match(/\(.*:\d+\)/) && 'text-blue-400'
                    )}>
                      {line}
                    </div>
                  ))}
                </pre>
              </div>
            )}

            {/* Activity Log */}
            <div className="rounded-lg border">
              <div className="border-b px-4 py-2">
                <h3 className="font-medium">Activity Log Before Failure</h3>
              </div>
              <div className="divide-y max-h-64 overflow-auto">
                {activityLog.slice(-10).map((entry) => {
                  const style = LOG_TYPE_STYLES[entry.type] ?? LOG_TYPE_STYLES.result;
                  return (
                    <div key={entry.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                      <span className="text-muted-foreground font-mono w-16">
                        {new Date(entry.timestamp).toLocaleTimeString()}
                      </span>
                      <span className={cn('w-16 text-center', style.color)}>
                        {style.icon} {entry.type}
                      </span>
                      <span className="flex-1 truncate">{entry.message}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Right: Retry Options and Actions */}
          <div className="space-y-4">
            <div className="rounded-lg border p-4">
              <h3 className="font-medium mb-3">Retry Options</h3>
              <div className="space-y-3">
                <div>
                  <label className="text-sm font-medium">Feedback</label>
                  <Textarea
                    value={feedback}
                    onChange={(e) => setFeedback(e.target.value)}
                    placeholder="Provide additional context for retry..."
                    className="mt-1"
                    rows={3}
                  />
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={fromCheckpoint} onCheckedChange={(c) => setFromCheckpoint(!!c)} />
                  From checkpoint
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={increaseTurns} onCheckedChange={(c) => setIncreaseTurns(!!c)} />
                  Increase turns
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox checked={useStrongerModel} onCheckedChange={(c) => setUseStrongerModel(!!c)} />
                  Use opus
                </label>
                <Button className="w-full" onClick={handleRetry}>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Retry Task
                </Button>
              </div>
            </div>

            <div className="rounded-lg border p-4">
              <h3 className="font-medium mb-3">Actions</h3>
              <div className="space-y-2">
                <Button variant="outline" className="w-full justify-start" onClick={onSkip}>
                  <SkipForward className="h-4 w-4 mr-2" />
                  Skip Task
                </Button>
                <Button variant="destructive" className="w-full justify-start" onClick={onAbort}>
                  <X className="h-4 w-4 mr-2" />
                  Abort & Return to Queue
                </Button>
                <Button variant="link" className="w-full justify-start" onClick={onViewLogs}>
                  <FileText className="h-4 w-4 mr-2" />
                  View Full Logs
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
```

---

## 4.5 Real-Time Hooks

### useSession (`hooks/use-session.ts`)

```typescript
import { useEffect, useState, useCallback } from 'react';
import { getSessionService } from '@/services/session.service';
import type { SessionEvent } from '@/services/session.service';

interface SessionState {
  chunks: { text: string; timestamp: number }[];
  toolCalls: { id: string; tool: string; input: unknown; output?: unknown; status: string }[];
  terminal: { type: 'stdout' | 'stderr'; data: string; timestamp: number }[];
  presence: { userId: string; name: string; lastSeen: number }[];
  agentState: { status: string; turn: number; progress: number } | null;
}

export function useSession(sessionId: string, userId: string) {
  const [state, setState] = useState<SessionState>({
    chunks: [],
    toolCalls: [],
    terminal: [],
    presence: [],
    agentState: null,
  });

  useEffect(() => {
    const sessionService = getSessionService();

    // Join session
    sessionService.join(sessionId, userId);

    // Subscribe to events
    const eventSource = new EventSource(`/api/sessions/${sessionId}/stream`);

    eventSource.onmessage = (event) => {
      const data: SessionEvent = JSON.parse(event.data);

      setState((prev) => {
        switch (data.type) {
          case 'chunk':
            return { ...prev, chunks: [...prev.chunks, data.payload] };
          case 'tool_start':
            return {
              ...prev,
              toolCalls: [...prev.toolCalls, { ...data.payload, status: 'running' }],
            };
          case 'tool_complete':
            return {
              ...prev,
              toolCalls: prev.toolCalls.map((tc) =>
                tc.id === data.payload.id
                  ? { ...tc, output: data.payload.output, status: 'complete' }
                  : tc
              ),
            };
          case 'tool_error':
            return {
              ...prev,
              toolCalls: prev.toolCalls.map((tc) =>
                tc.id === data.payload.id ? { ...tc, status: 'error' } : tc
              ),
            };
          case 'terminal':
            return { ...prev, terminal: [...prev.terminal, data.payload] };
          case 'presence':
            return { ...prev, presence: data.payload };
          case 'agent_state':
            return { ...prev, agentState: data.payload };
          default:
            return prev;
        }
      });
    };

    eventSource.onerror = () => {
      eventSource.close();
    };

    return () => {
      eventSource.close();
      sessionService.leave(sessionId, userId);
    };
  }, [sessionId, userId]);

  return state;
}
```

### useAgentStream (`hooks/use-agent-stream.ts`)

```typescript
import { useEffect, useRef, useState } from 'react';

interface StreamChunk {
  text: string;
  timestamp: number;
}

export function useAgentStream(sessionId: string) {
  const [chunks, setChunks] = useState<StreamChunk[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current = new AbortController();
    setIsStreaming(true);

    const eventSource = new EventSource(`/api/sessions/${sessionId}/stream`);

    eventSource.addEventListener('chunk', (event) => {
      const data = JSON.parse(event.data);
      setChunks((prev) => [...prev, { text: data.text, timestamp: Date.now() }]);
    });

    eventSource.addEventListener('complete', () => {
      setIsStreaming(false);
      eventSource.close();
    });

    eventSource.onerror = () => {
      setIsStreaming(false);
      eventSource.close();
    };

    return () => {
      eventSource.close();
      abortRef.current?.abort();
    };
  }, [sessionId]);

  const fullText = chunks.map((c) => c.text).join('');

  return { chunks, fullText, isStreaming };
}
```

### usePresence (`hooks/use-presence.ts`)

```typescript
import { useEffect, useState, useCallback } from 'react';

interface PresenceUser {
  userId: string;
  name: string;
  cursor?: { line: number; column: number };
  lastSeen: number;
}

export function usePresence(sessionId: string, userId: string, userName: string) {
  const [users, setUsers] = useState<PresenceUser[]>([]);

  // Heartbeat to keep presence alive
  useEffect(() => {
    const heartbeat = async () => {
      await fetch(`/api/sessions/${sessionId}/presence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, name: userName }),
      });
    };

    heartbeat();
    const interval = setInterval(heartbeat, 30000);

    return () => clearInterval(interval);
  }, [sessionId, userId, userName]);

  // Subscribe to presence updates
  useEffect(() => {
    const eventSource = new EventSource(`/api/sessions/${sessionId}/stream`);

    eventSource.addEventListener('presence', (event) => {
      const data = JSON.parse(event.data);
      setUsers(data);
    });

    return () => eventSource.close();
  }, [sessionId]);

  const updateCursor = useCallback(
    async (cursor: { line: number; column: number }) => {
      await fetch(`/api/sessions/${sessionId}/presence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, name: userName, cursor }),
      });
    },
    [sessionId, userId, userName]
  );

  return { users, updateCursor };
}
```

---

## 4.6 Page Routes

### Route Structure

```
routes/
├── __root.tsx              # Root layout
├── index.tsx               # Dashboard
├── projects/
│   ├── index.tsx           # Projects list
│   └── $projectId/
│       ├── index.tsx       # Project kanban board
│       └── tasks/
│           └── $taskId.tsx # Task detail
├── agents/
│   ├── index.tsx           # Agents list
│   └── $agentId.tsx        # Agent detail
└── sessions/
    └── $sessionId.tsx      # Session view
```

### Root Layout (`routes/__root.tsx`)

```typescript
import { Outlet, createRootRoute } from '@tanstack/react-router';
import { BootstrapProvider } from '@/providers/bootstrap-provider';
import { Toaster } from '@/components/ui/toast';

export const Route = createRootRoute({
  component: () => (
    <BootstrapProvider>
      <div className="min-h-screen bg-background">
        <Outlet />
        <Toaster />
      </div>
    </BootstrapProvider>
  ),
});
```

### Dashboard (`routes/index.tsx`)

```typescript
import { createFileRoute, Link } from '@tanstack/react-router';
import { FolderKanban, Bot, Clock } from 'lucide-react';
import { getProjectService } from '@/services/project.service';
import { getAgentService } from '@/services/agent.service';
import { Button } from '@/components/ui/button';
import { ProjectPicker } from '@/components/features/project-picker';

export const Route = createFileRoute('/')({
  loader: async () => {
    const projectService = getProjectService();
    const agentService = getAgentService();

    const [projects, runningAgents] = await Promise.all([
      projectService.list({ limit: 10 }),
      // Get running agents across all projects
    ]);

    return {
      projects: projects.ok ? projects.value.items : [],
      runningAgents: [],
    };
  },
  component: Dashboard,
});

function Dashboard() {
  const { projects, runningAgents } = Route.useLoaderData();

  return (
    <div className="container mx-auto py-8">
      <h1 className="text-3xl font-bold mb-8">Dashboard</h1>

      <div className="grid grid-cols-3 gap-6 mb-8">
        <div className="rounded-lg border p-6">
          <div className="flex items-center gap-2 text-muted-foreground mb-2">
            <FolderKanban className="h-5 w-5" />
            <span>Projects</span>
          </div>
          <p className="text-3xl font-bold">{projects.length}</p>
        </div>

        <div className="rounded-lg border p-6">
          <div className="flex items-center gap-2 text-muted-foreground mb-2">
            <Bot className="h-5 w-5" />
            <span>Running Agents</span>
          </div>
          <p className="text-3xl font-bold">{runningAgents.length}</p>
        </div>

        <div className="rounded-lg border p-6">
          <div className="flex items-center gap-2 text-muted-foreground mb-2">
            <Clock className="h-5 w-5" />
            <span>Recent Activity</span>
          </div>
          <p className="text-sm text-muted-foreground">View recent tasks</p>
        </div>
      </div>

      <div className="space-y-4">
        <h2 className="text-xl font-semibold">Recent Projects</h2>
        <div className="grid grid-cols-2 gap-4">
          {projects.map((project) => (
            <Link
              key={project.id}
              to="/projects/$projectId"
              params={{ projectId: project.id }}
              className="rounded-lg border p-4 hover:bg-muted/50 transition-colors"
            >
              <h3 className="font-medium">{project.name}</h3>
              <p className="text-sm text-muted-foreground truncate">{project.path}</p>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
```

### Project Kanban (`routes/projects/$projectId/index.tsx`)

```typescript
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { getProjectService } from '@/services/project.service';
import { getTaskService } from '@/services/task.service';
import { getAgentService } from '@/services/agent.service';
import { KanbanBoard } from '@/components/features/kanban-board';
import { TaskDetailDialog } from '@/components/features/task-detail-dialog';
import { ApprovalDialog } from '@/components/features/approval-dialog';
import { Button } from '@/components/ui/button';
import type { Task } from '@/db/schema';

export const Route = createFileRoute('/projects/$projectId/')({
  loader: async ({ params }) => {
    const projectService = getProjectService();
    const taskService = getTaskService();
    const agentService = getAgentService();

    const [project, tasks, agents] = await Promise.all([
      projectService.getById(params.projectId),
      taskService.list(params.projectId),
      agentService.list(params.projectId),
    ]);

    if (!project.ok) throw new Error('Project not found');

    return {
      project: project.value,
      tasks: tasks.ok ? tasks.value.items : [],
      agents: agents.value,
    };
  },
  component: ProjectKanban,
});

function ProjectKanban() {
  const { project, tasks, agents } = Route.useLoaderData();
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [showNewTask, setShowNewTask] = useState(false);
  const [approvalTask, setApprovalTask] = useState<Task | null>(null);

  const handleTaskMove = async (taskId: string, column: TaskColumn, position: number) => {
    const taskService = getTaskService();
    await taskService.moveColumn(taskId, column, position);
  };

  const handleTaskClick = (task: Task) => {
    if (task.column === 'waiting_approval') {
      setApprovalTask(task);
    } else {
      setSelectedTask(task);
    }
  };

  const handleApprove = async (commitMessage?: string) => {
    if (!approvalTask) return;
    const taskService = getTaskService();
    await taskService.approve(approvalTask.id, { commitMessage });
  };

  const handleReject = async (reason: string) => {
    if (!approvalTask) return;
    const taskService = getTaskService();
    await taskService.reject(approvalTask.id, { reason });
  };

  return (
    <div className="h-screen flex flex-col">
      <header className="border-b p-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">{project.name}</h1>
        <Button onClick={() => setShowNewTask(true)}>
          <Plus className="h-4 w-4 mr-2" />
          New Task
        </Button>
      </header>

      <main className="flex-1 overflow-hidden">
        <KanbanBoard
          tasks={tasks}
          onTaskMove={handleTaskMove}
          onTaskClick={handleTaskClick}
        />
      </main>

      <TaskDetailDialog
        task={selectedTask}
        open={!!selectedTask || showNewTask}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedTask(null);
            setShowNewTask(false);
          }
        }}
        onSave={async (data) => {
          const taskService = getTaskService();
          if (selectedTask) {
            await taskService.update(selectedTask.id, data);
          } else {
            await taskService.create({ projectId: project.id, ...data } as any);
          }
        }}
        onDelete={async (id) => {
          const taskService = getTaskService();
          await taskService.delete(id);
        }}
      />

      {approvalTask && (
        <ApprovalDialog
          task={approvalTask}
          diff={approvalTask.diffSummary}
          open={!!approvalTask}
          onOpenChange={(open) => !open && setApprovalTask(null)}
          onApprove={handleApprove}
          onReject={handleReject}
        />
      )}
    </div>
  );
}
```

### Session View (`routes/sessions/$sessionId.tsx`)

```typescript
import { createFileRoute } from '@tanstack/react-router';
import { getSessionService } from '@/services/session.service';
import { getAgentService } from '@/services/agent.service';
import { AgentSessionView } from '@/components/features/agent-session-view';

export const Route = createFileRoute('/sessions/$sessionId')({
  loader: async ({ params }) => {
    const sessionService = getSessionService();
    const session = await sessionService.getById(params.sessionId);

    if (!session.ok) throw new Error('Session not found');

    return { session: session.value };
  },
  component: SessionPage,
});

function SessionPage() {
  const { session } = Route.useLoaderData();
  const userId = 'current-user'; // From auth context

  const handlePause = async () => {
    if (!session.agentId) return;
    const agentService = getAgentService();
    await agentService.pause(session.agentId);
  };

  const handleResume = async () => {
    if (!session.agentId) return;
    const agentService = getAgentService();
    await agentService.resume(session.agentId);
  };

  const handleStop = async () => {
    if (!session.agentId) return;
    const agentService = getAgentService();
    await agentService.stop(session.agentId);
  };

  return (
    <div className="h-screen">
      <AgentSessionView
        sessionId={session.id}
        agentId={session.agentId ?? ''}
        userId={userId}
        onPause={handlePause}
        onResume={handleResume}
        onStop={handleStop}
      />
    </div>
  );
}
```

---

## 4.7 Feature Component Summary

| Component | File | Purpose |
|-----------|------|---------|
| KanbanBoard | `components/features/kanban-board.tsx` | Drag-drop task board |
| KanbanColumn | `components/features/kanban-column.tsx` | Task column container |
| KanbanCard | `components/features/kanban-card.tsx` | Draggable task card |
| ApprovalDialog | `components/features/approval-dialog.tsx` | Code review modal |
| AgentSessionView | `components/features/agent-session-view.tsx` | Real-time agent output |
| TaskDetailDialog | `components/features/task-detail-dialog.tsx` | Task editor modal |
| NewProjectDialog | `components/features/new-project-dialog.tsx` | Project creation wizard |
| ProjectPicker | `components/features/project-picker.tsx` | Project selector dropdown |
| ToastNotifications | `components/features/toast.tsx` | Toast system |
| Breadcrumbs | `components/features/breadcrumbs.tsx` | Navigation breadcrumbs |
| AgentConfigDialog | `components/features/agent-config-dialog.tsx` | Agent execution settings |
| ThemeToggle | `components/features/theme-toggle.tsx` | Light/dark/system theme |
| EmptyState | `components/features/empty-state.tsx` | Empty state presets |
| ProjectSettings | `components/features/project-settings.tsx` | Project configuration |
| SessionHistory | `components/features/session-history.tsx` | Session list with filters |
| WorktreeManagement | `components/features/worktree-management.tsx` | Git worktree management |
| QueueWaitingState | `components/features/queue-waiting-state.tsx` | Queue position display |
| GitHubAppSetup | `components/features/github-app-setup.tsx` | GitHub OAuth integration |
| ErrorState | `components/features/error-state.tsx` | Error visualization |

---

## 4.8 Tests

### Component Test Categories

| Category | Test Count |
|----------|------------|
| Primitive components | 12 |
| KanbanBoard | 8 |
| ApprovalDialog | 6 |
| AgentSessionView | 5 |
| Hooks | 8 |
| Page routes | 10 |

### Example Test (`tests/components/kanban-board.test.tsx`)

```typescript
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { KanbanBoard } from '@/components/features/kanban-board';
import { createTestTask } from '../factories';

describe('KanbanBoard', () => {
  const mockTasks = [
    createTestTask('project-1', { column: 'backlog', position: 0 }),
    createTestTask('project-1', { column: 'backlog', position: 1 }),
    createTestTask('project-1', { column: 'in_progress', position: 0 }),
  ];

  it('renders all columns', () => {
    render(
      <KanbanBoard
        tasks={mockTasks}
        onTaskMove={vi.fn()}
        onTaskClick={vi.fn()}
      />
    );

    expect(screen.getByText('Backlog')).toBeInTheDocument();
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.getByText('Waiting Approval')).toBeInTheDocument();
    expect(screen.getByText('Verified')).toBeInTheDocument();
  });

  it('displays task count per column', () => {
    render(
      <KanbanBoard
        tasks={mockTasks}
        onTaskMove={vi.fn()}
        onTaskClick={vi.fn()}
      />
    );

    expect(screen.getByText('2')).toBeInTheDocument(); // backlog
    expect(screen.getByText('1')).toBeInTheDocument(); // in_progress
  });

  it('calls onTaskClick when card clicked', async () => {
    const onTaskClick = vi.fn();
    render(
      <KanbanBoard
        tasks={mockTasks}
        onTaskMove={vi.fn()}
        onTaskClick={onTaskClick}
      />
    );

    fireEvent.click(screen.getByText(mockTasks[0].title));
    expect(onTaskClick).toHaveBeenCalledWith(mockTasks[0]);
  });
});
```

---

## Spec References

- Component Patterns: `/specs/application/implementation/component-patterns.md`
- Animation System: `/specs/application/implementation/animation-system.md`
- Components: `/specs/application/components/*.md`
- Routes: `/specs/application/routing/routes.md`
- Wireframes: `/specs/application/wireframes/*.html`
