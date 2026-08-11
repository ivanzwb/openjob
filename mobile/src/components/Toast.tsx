import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Text, View } from 'react-native';
import { theme } from '../theme';

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

const variantStyle: Record<ToastVariant, { bg: string; border: string; color: string }> = {
  info: { bg: '#1f2937', border: theme.border, color: theme.text },
  success: { bg: '#052e16', border: '#065f46', color: '#a7f3d0' },
  warning: { bg: '#451a03', border: '#92400e', color: '#fcd34d' },
  error: { bg: '#450a0a', border: '#991b1b', color: '#fca5a5' },
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
    const duration = options?.duration ?? 2800;
    setToasts((prev) => [...prev, { id, message, variant }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((item) => item.id !== id));
    }, duration);
  }, []);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          bottom: 24,
          left: 16,
          right: 16,
          gap: 8,
          alignItems: 'center',
        }}
      >
        {toasts.map((item) => {
          const style = variantStyle[item.variant];
          return (
            <View
              key={item.id}
              style={{
                maxWidth: 360,
                width: '100%',
                borderWidth: 1,
                borderColor: style.border,
                backgroundColor: style.bg,
                borderRadius: 10,
                paddingHorizontal: 14,
                paddingVertical: 10,
              }}
            >
              <Text style={{ color: style.color, fontSize: 13, textAlign: 'center' }}>{item.message}</Text>
            </View>
          );
        })}
      </View>
    </ToastContext.Provider>
  );
}

export function useToast(): (message: string, options?: ToastOptions) => void {
  const toast = useContext(ToastContext);
  if (!toast) throw new Error('useToast 必须在 ToastProvider 内使用');
  return toast;
}
