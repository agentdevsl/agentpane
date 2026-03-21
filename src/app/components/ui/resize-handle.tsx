import { useCallback, useRef, useState } from 'react';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { cn } from '@/lib/utils/cn';

interface ResizeHandleProps {
  /** Called continuously during drag with the new width */
  onResize: (width: number) => void;
  /** Called once when drag ends (for persisting to storage) */
  onResizeEnd?: (width: number) => void;
  /** Minimum allowed width in px */
  minWidth?: number;
  /** Maximum allowed width in px */
  maxWidth?: number;
  /** Current panel width — used as the drag start reference */
  currentWidth: number;
}

export function ResizeHandle({
  onResize,
  onResizeEnd,
  minWidth = 160,
  maxWidth = 480,
  currentWidth,
}: ResizeHandleProps): React.JSX.Element {
  const [isDragging, setIsDragging] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startXRef.current = e.clientX;
      startWidthRef.current = currentWidth;
      setIsDragging(true);
    },
    [currentWidth]
  );

  useWatchEffect(() => {
    if (!isDragging) return;

    let latestWidth = startWidthRef.current;

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startXRef.current;
      const newWidth = Math.round(
        Math.min(maxWidth, Math.max(minWidth, startWidthRef.current + delta))
      );
      latestWidth = newWidth;
      onResize(newWidth);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      onResizeEnd?.(latestWidth);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    // Prevent text selection while dragging
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isDragging, minWidth, maxWidth, onResize, onResizeEnd]);

  return (
    // biome-ignore lint/a11y/useSemanticElements: resize handle is a drag target, not a semantic separator
    // biome-ignore lint/a11y/useAriaPropsForRole: visual-only drag handle
    // biome-ignore lint/a11y/useFocusableInteractive: mouse-only drag interaction
    // biome-ignore lint/a11y/noStaticElementInteractions: drag handle needs onMouseDown
    <div
      role="separator"
      aria-orientation="vertical"
      tabIndex={0}
      aria-valuenow={currentWidth}
      onMouseDown={handleMouseDown}
      className={cn(
        'absolute right-0 top-0 z-50 h-full w-[5px] cursor-col-resize',
        'transition-opacity duration-150',
        isDragging ? 'opacity-100' : 'opacity-0 hover:opacity-100',
        'after:absolute after:right-[2px] after:top-0 after:h-full after:w-px',
        isDragging ? 'after:bg-accent' : 'after:bg-border-subtle hover:after:bg-accent/60'
      )}
      data-testid="resize-handle"
    />
  );
}
