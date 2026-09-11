import { useCallback, useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';
import { syncTextareaHeight } from '../lib/popoverLayout';

export function AutoResizeTextarea({
  value,
  onChange,
  minRows = 3,
  className = '',
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { minRows?: number }): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null);

  const resize = useCallback(() => {
    syncTextareaHeight(ref.current, minRows);
  }, [minRows]);

  useLayoutEffect(() => {
    resize();
  }, [value, resize]);

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => {
        onChange?.(e);
        requestAnimationFrame(resize);
      }}
      rows={minRows}
      style={{ resize: 'none' }}
      className={className}
      {...props}
    />
  );
}
