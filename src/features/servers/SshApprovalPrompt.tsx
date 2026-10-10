import * as WebBrowser from 'expo-web-browser';
import { useEffect, useReducer, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Platform, ScrollView, View } from 'react-native';

import Native from '../../../modules/herdr-ssh/src/HerdrSshModule';
import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import { displaySshBanner, reduceSshApprovals, tailscaleApprovalUrl, type SshApprovalEvent } from '@/lib/sshApproval';
import { useTheme } from '@/theme/ThemeProvider';
import { radius, screenPadding, spacing } from '@/theme/tokens';

/** Mounted once above navigation: reconnects, host tests and saved hosts all
 * use the same approval flow. Only the SSH server can declare login complete. */
export function SshApprovalPrompt() {
  const [pending, dispatch] = useReducer(reduceSshApprovals, {});
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const listener = Native.addListener('onAuth', dispatch);
    return () => listener.remove();
  }, []);
  const approval = Object.values(pending).find((event) => event.phase === 'banner');
  if (!approval) return null;
  return <ApprovalDialog key={approval.attemptId} approval={approval} onCancel={async () => {
    await Native.cancelAuth(approval.connectionId, approval.attemptId);
    dispatch({ ...approval, phase: 'finished' });
  }} />;
}

export function ApprovalDialog({ approval, onCancel }: {
  approval: SshApprovalEvent;
  onCancel: () => Promise<void>;
}) {
  const { colors } = useTheme();
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const browserOpen = useRef(false);
  useEffect(() => () => {
    if (browserOpen.current) { WebBrowser.dismissBrowser(); browserOpen.current = false; }
  }, []);
  const url = tailscaleApprovalUrl(approval.message ?? '');
  const cancel = async () => {
    setCancelling(true);
    try { await onCancel(); }
    catch { setError('Could not cancel the connection. Try again.'); setCancelling(false); }
  };
  return (
    <Modal transparent animationType="fade" onRequestClose={() => void cancel()}>
      <View style={{ flex: 1, justifyContent: 'center', padding: screenPadding, backgroundColor: colors.systemBackground }}>
        <ScrollView contentContainerStyle={{ padding: spacing.lg, borderRadius: radius.lg, gap: spacing.md }}>
          <Text variant="title2" weight="600">Approve Tailscale SSH</Text>
          <Text variant="body">{approval.username}@{approval.host}</Text>
          <Text variant="footnote" color="secondary">
            Approve this connection in your browser, then return here. The host will finish signing you in.
          </Text>
          <Text variant="caption" selectable testID="ssh-auth-banner">
            {displaySshBanner(approval.message ?? '')}
          </Text>
          {url !== null && <Button title="Approve in browser" testID="ssh-auth-open" disabled={cancelling} onPress={() => {
            browserOpen.current = true;
            void WebBrowser.openBrowserAsync(url)
              .catch(() => setError('Could not open your browser. Try again.'))
              .finally(() => { browserOpen.current = false; });
          }} />}
          {url === null && <Text variant="footnote" color="secondary">The server did not provide a recognized Tailscale approval link.</Text>}
          <ActivityIndicator color={colors.tint} />
          <Text variant="caption" color="secondary">Waiting for the SSH server…</Text>
          {error !== null && <Text variant="footnote" color="attention">{error}</Text>}
          <Button title="Cancel sign-in" variant="plain" testID="ssh-auth-cancel" loading={cancelling} onPress={() => void cancel()} />
        </ScrollView>
      </View>
    </Modal>
  );
}
