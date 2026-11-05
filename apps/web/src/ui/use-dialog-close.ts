import { useEffect, useRef, type RefObject } from 'react';
import { takeEscape } from './escape';

export function useDialogClose(onClose: () => void): RefObject<HTMLDivElement | null> {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (!takeEscape(event)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return box;
}
