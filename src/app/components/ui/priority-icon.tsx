import { ArrowFatDown, ArrowFatUp, Minus } from '@phosphor-icons/react';
import { cn } from '@/lib/utils/cn';
import { priorityColorVariants } from '../features/kanban-board/styles';

interface PriorityIconProps {
  priority: 'high' | 'medium' | 'low';
  size?: number;
  className?: string;
}

export function PriorityIcon({ priority, size = 14, className }: PriorityIconProps) {
  const colorClass = priorityColorVariants({ priority });

  switch (priority) {
    case 'high':
      return <ArrowFatUp size={size} weight="fill" className={cn(colorClass, className)} />;
    case 'medium':
      return <Minus size={size} weight="bold" className={cn(colorClass, className)} />;
    case 'low':
      return <ArrowFatDown size={size} weight="fill" className={cn(colorClass, className)} />;
  }
}
