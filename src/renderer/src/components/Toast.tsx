import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

type ToastVariant = 'info' | 'success' | 'warning' | 'error';

type ToastItem = {
  id: number;
  message: string;
  variant: ToastVariant;
};

type ToastOptions = {
  variant?: ToastVariant;
  duration?: number;
};

const variantClasses: Record<ToastVariant, string> = {
  info: 'border-[var(--color-border)] bg-[var(--color-surface)]/95 text-[var(--color-fg)]',
  success: 'border-emerald-800/60 bg-emerald-950/95 text-emerald-300',
  warning: 'border-amber-800/60 bg-amber-950/95 text-amber-300',
  error: 'border-red-800/60 bg-red-950/95 text-red-300',
};

const ToastContext = createContext<((message: string, options?: ToastOptions) => void) | null>(
  null,
);

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const toast = useCallback((message: string, options?: ToastOptions) => {
    const id = ++idRef.current;
    const variant = options?.variant ?? 'info';
    const duration = options?.duration ?? 3000;

    setToasts((prev) => [...prev, { id, message, variant }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id));
    }, duration);
  }, []);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed bottom-4 right-4 z-[200] flex max-w-sm flex-col gap-2">
          {toasts.map((item) => (
            <div
              key={item.id}
              className={`rounded-lg border px-3 py-2 text-sm shadow-lg backdrop-blur-sm ${variantClasses[item.variant]}`}
            >
              {item.message}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): (message: string, options?: ToastOptions) => void {
  const toast = useContext(ToastContext);
  if (!toast) throw new Error('useToast must be used within ToastProvider');
  return toast;
}
