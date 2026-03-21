import { CaretDown, CaretUp, Diamond } from '@phosphor-icons/react';
import { cn } from '@/lib/utils/cn';
import { priorityColorVariants } from '../features/kanban-board/styles';

interface PriorityIconProps {
  priority: 'high' | 'medium' | 'low';
  size?: number;
  className?: string;
}

export function PriorityIcon({ priority, size = 16, className }: PriorityIconProps) {
  const colorClass = priorityColorVariants({ priority });

  switch (priority) {
    case 'high':
      return <CaretUp size={size} weight="fill" className={cn(colorClass, className)} />;
    case 'medium':
      return <Diamond size={size - 2} weight="fill" className={cn(colorClass, className)} />;
    case 'low':
      return <CaretDown size={size} weight="fill" className={cn(colorClass, className)} />;
  }
}
