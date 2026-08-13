import { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { theme } from '../theme';

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayLocal(): string {
  return toDateKey(new Date());
}

export function StudyPlanCalendar({
  viewMonth,
  onViewMonthChange,
  taskCountByDate,
  selectedDate,
  onSelectDate,
  interviewDate,
}: {
  viewMonth: Date;
  onViewMonthChange: (month: Date) => void;
  taskCountByDate: Record<string, number>;
  selectedDate: string | null;
  onSelectDate: (date: string | null) => void;
  interviewDate?: string;
}): React.JSX.Element {
  const today = todayLocal();
  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();

  const cells = useMemo(() => {
    const first = new Date(year, month, 1);
    const last = new Date(year, month + 1, 0);
    const startPad = (first.getDay() + 6) % 7;
    const daysInMonth = last.getDate();
    const result: { key: string; day: number; inMonth: boolean }[] = [];
    for (let i = 0; i < startPad; i++) {
      const d = new Date(year, month, -startPad + i + 1);
      result.push({ key: toDateKey(d), day: d.getDate(), inMonth: false });
    }
    for (let day = 1; day <= daysInMonth; day++) {
      result.push({ key: toDateKey(new Date(year, month, day)), day, inMonth: true });
    }
    while (result.length % 7 !== 0) {
      const next = result.length - startPad - daysInMonth + 1;
      result.push({ key: toDateKey(new Date(year, month + 1, next)), day: new Date(year, month + 1, next).getDate(), inMonth: false });
    }
    return result;
  }, [year, month]);

  return (
    <View style={{ borderWidth: 1, borderColor: theme.border, borderRadius: 8, padding: 8, backgroundColor: theme.bg, gap: 6 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Pressable onPress={() => onViewMonthChange(new Date(year, month - 1, 1))} style={{ padding: 4 }}>
          <Text style={{ color: theme.muted, fontSize: 16 }}>‹</Text>
        </Pressable>
        <Text style={{ color: theme.text, fontWeight: '600', fontSize: 13 }}>
          {year} 年 {month + 1} 月
        </Text>
        <Pressable onPress={() => onViewMonthChange(new Date(year, month + 1, 1))} style={{ padding: 4 }}>
          <Text style={{ color: theme.muted, fontSize: 16 }}>›</Text>
        </Pressable>
      </View>
      <View style={{ flexDirection: 'row' }}>
        {WEEKDAYS.map((w) => (
          <View key={w} style={{ flex: 1, alignItems: 'center' }}>
            <Text style={{ color: theme.muted, fontSize: 10 }}>{w}</Text>
          </View>
        ))}
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {cells.map((cell) => {
          const count = taskCountByDate[cell.key] ?? 0;
          const selected = cell.key === selectedDate;
          const isToday = cell.key === today;
          const isInterview = interviewDate === cell.key;
          return (
            <Pressable
              key={cell.key}
              disabled={!cell.inMonth}
              onPress={() => onSelectDate(selected ? null : cell.key)}
              style={{
                width: `${100 / 7}%`,
                aspectRatio: 1,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 6,
                backgroundColor: selected ? theme.accent : isToday ? `${theme.accent}22` : 'transparent',
                borderWidth: isInterview && !selected ? 1 : 0,
                borderColor: '#d97706',
                opacity: cell.inMonth ? 1 : 0.25,
              }}
            >
              <Text style={{ color: selected ? '#fff' : cell.inMonth ? theme.text : theme.muted, fontSize: 11 }}>
                {cell.day}
              </Text>
              {cell.inMonth && count > 0 && (
                <Text style={{ color: selected ? '#fff' : theme.accent, fontSize: 8 }}>{count}</Text>
              )}
            </Pressable>
          );
        })}
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Pressable onPress={() => onSelectDate(null)}>
          <Text style={{ color: selectedDate === null ? theme.accent : theme.muted, fontSize: 11 }}>全部考点</Text>
        </Pressable>
        <Pressable onPress={() => onSelectDate(today)}>
          <Text style={{ color: selectedDate === today ? theme.accent : theme.muted, fontSize: 11 }}>今天</Text>
        </Pressable>
      </View>
    </View>
  );
}
