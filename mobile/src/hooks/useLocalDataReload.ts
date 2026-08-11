import { useCallback, useEffect } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useApp } from '../context/AppContext';

/** 同步完成或切回该 Tab 时重新读取本地 SQLite */
export function useLocalDataReload(reload: () => void): void {
  const { dataVersion } = useApp();

  useEffect(() => {
    reload();
  }, [dataVersion, reload]);

  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload]),
  );
}
