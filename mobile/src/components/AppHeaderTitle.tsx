import { Image, Text, View } from 'react-native';
import { useRemoteTask } from '../context/RemoteTaskContext';
import { theme } from '../theme';

const logo = require('../../assets/icon.png');

export function AppHeaderTitle({ title }: { title: string }): React.JSX.Element {
  const { active } = useRemoteTask();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Image source={logo} style={{ width: 22, height: 22, borderRadius: 6 }} />
      <Text style={{ color: theme.text, fontSize: 17, fontWeight: '600' }} numberOfLines={1}>
        {title}
        {active ? ` · ${active.label}` : ''}
      </Text>
    </View>
  );
}
