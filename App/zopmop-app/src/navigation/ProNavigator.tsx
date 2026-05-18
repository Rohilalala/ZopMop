// ProNavigator — 5-tab bottom-nav container for the pro side. Wrapped
// inside MainNavigator's role-gated branch; replaces direct routing to
// ProDashboardScreen for users with role === 'pro' / 'helper'.
//
// Each tab keeps its own state via the default bottom-tabs lazy-mount
// behavior. Stack pushes (ZoneApprovalRequest, LanguageToggle, etc.)
// live on the parent native stack so the tab bar stays mounted under
// them rather than being shoved off-screen.

import React from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Feather } from '@expo/vector-icons';

import ProDashboardScreen from '../screens/pro/ProDashboardScreen';
import CommitShiftScreen from '../screens/pro/CommitShiftScreen';
import JobsListScreen from '../screens/pro/JobsListScreen';
import ProMoneyScreen from '../screens/pro/ProMoneyScreen';
import ProProfileScreen from '../screens/pro/ProProfileScreen';
import { useColors } from '../context/ThemeContext';
import { FontFamily, FontSize } from '../theme';
import { t, useLocale } from '../i18n';

export type ProTabParamList = {
  ProHome: undefined;
  ProShift: undefined;
  ProJobs: undefined;
  ProMoneyTab: undefined;
  ProProfileTab: undefined;
};

const Tab = createBottomTabNavigator<ProTabParamList>();

type IconName = React.ComponentProps<typeof Feather>['name'];

const TAB_CONFIG: { name: keyof ProTabParamList; icon: IconName; key: string }[] = [
  { name: 'ProHome',        icon: 'home',      key: 'tabs.home' },
  { name: 'ProShift',       icon: 'calendar',  key: 'tabs.shift' },
  { name: 'ProJobs',        icon: 'briefcase', key: 'tabs.jobs' },
  { name: 'ProMoneyTab',    icon: 'dollar-sign', key: 'tabs.money' },
  { name: 'ProProfileTab',  icon: 'user',      key: 'tabs.profile' },
];

export default function ProNavigator() {
  const c = useColors();
  // Subscribing to locale here forces every tab label to recompute
  // when the user toggles language inside the Profile tab.
  useLocale();

  return (
    <Tab.Navigator
      screenOptions={({ route }) => {
        const cfg = TAB_CONFIG.find((x) => x.name === route.name)!;
        return {
          headerShown: false,
          lazy: true,
          freezeOnBlur: true,
          sceneStyle: { backgroundColor: c.background },
          tabBarActiveTintColor: c.accent,
          tabBarInactiveTintColor: c.textMuted,
          tabBarLabelStyle: {
            fontFamily: FontFamily.semibold,
            fontSize: FontSize.xs,
            marginTop: -2,
          },
          tabBarStyle: {
            backgroundColor: c.surface,
            borderTopColor: c.border,
            borderTopWidth: StyleSheet.hairlineWidth,
            ...(Platform.OS === 'ios' ? { height: 84 } : { height: 64, paddingBottom: 8 }),
          },
          tabBarIcon: ({ color, focused }) => (
            <View>
              <Feather name={cfg.icon} size={focused ? 22 : 20} color={color} />
            </View>
          ),
          tabBarLabel: t(cfg.key),
        };
      }}
    >
      <Tab.Screen name="ProHome" component={ProDashboardScreen} />
      <Tab.Screen name="ProShift" component={CommitShiftScreen} />
      <Tab.Screen name="ProJobs" component={JobsListScreen} />
      <Tab.Screen name="ProMoneyTab" component={ProMoneyScreen} />
      <Tab.Screen name="ProProfileTab" component={ProProfileScreen} />
    </Tab.Navigator>
  );
}
