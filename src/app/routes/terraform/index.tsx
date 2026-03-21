import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useRef, useState } from 'react';
import { TerraformChatPanel } from '@/app/components/features/terraform/terraform-chat-panel';
import { TerraformRightPanel } from '@/app/components/features/terraform/terraform-right-panel';
import { useMountEffect } from '@/app/hooks/use-mount-effect';

export const Route = createFileRoute('/terraform/')({
  component: TerraformComposeView,
});

function TerraformComposeView(): React.JSX.Element {
  const [rightWidth, setRightWidth] = useState(640);
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const cleanupRef = useRef<(() => void) | null>(null);

  useMountEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  });

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;

    const onMouseMove = (ev: MouseEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const newRight = rect.right - ev.clientX;
      setRightWidth(Math.max(300, Math.min(newRight, rect.width - 400)));
    };

    const cleanup = () => {
      draggingRef.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', cleanup);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      cleanupRef.current = null;
    };

    cleanupRef.current = cleanup;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', cleanup);
  }, []);

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-r border-border">
        <TerraformChatPanel />
      </div>
      {/* Resize handle */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: resize handle uses mouse events intentionally */}
      <div
        onMouseDown={handleMouseDown}
        className="w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-accent/30"
      />
      <div className="flex flex-col overflow-hidden" style={{ width: rightWidth }}>
        <TerraformRightPanel />
      </div>
    </div>
  );
}
