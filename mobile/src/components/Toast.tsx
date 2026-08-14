import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Text, View } from 'react-native';
import { useTheme } from '../theme';

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

const VARIANT_TONE: Record<ToastVariant, 'slate' | 'emerald' | 'amber' | 'red'> = {
  info: 'slate',
  success: 'emerald',
  warning: 'amber',
  error: 'red',
};

const ToastContext = createContext<((message: string, options?: ToastOptions) => void) | null>(
  null,
);

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const theme = useTheme();
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
          const style = theme.tone[VARIANT_TONE[item.variant]];
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
              <Text style={{ color: style.text, fontSize: 13, textAlign: 'center' }}>{item.message}</Text>
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
