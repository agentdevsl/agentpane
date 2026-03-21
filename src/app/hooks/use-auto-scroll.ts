import { useCallback, useEffect, useRef, useState } from 'react';

interface UseAutoScrollReturn {
  containerRef: React.RefObject<HTMLDivElement | null>;
  scrollToBottom: () => void;
  showScrollButton: boolean;
  handleScroll: () => void;
}

/**
 * Auto-scroll to bottom when content changes, with user-scroll detection.
 * When the user scrolls up, auto-scroll pauses and a "scroll to bottom" button appears.
 * Scrolling back to the bottom re-enables auto-scroll.
 */
export function useAutoScroll(): UseAutoScrollReturn {
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const userScrolledRef = useRef(false);
  const [showScrollButton, setShowScrollButton] = useState(false);

  // Auto-scroll on every render when pinned to bottom
  useEffect(() => {
    if (autoScrollRef.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  });

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;

    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;

    if (!isAtBottom && !userScrolledRef.current) {
      userScrolledRef.current = true;
      autoScrollRef.current = false;
      setShowScrollButton(true);
    }

    if (isAtBottom && userScrolledRef.current) {
      userScrolledRef.current = false;
      autoScrollRef.current = true;
      setShowScrollButton(false);
    }
  }, []);

  const scrollToBottom = useCallback(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
      autoScrollRef.current = true;
      userScrolledRef.current = false;
      setShowScrollButton(false);
    }
  }, []);

  return { containerRef, scrollToBottom, showScrollButton, handleScroll };
}
