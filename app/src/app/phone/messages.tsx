import { Inbox } from '@/components/comms/Inbox';

/**
 * Phone → Messages. The same inbox as `/crm/inbox`, rendered inside the
 * phone's tab bar so switching to Keypad or Recents is one tap and never
 * leaves the section. The settings gear moves into the body because the
 * nested tabs have no header of their own.
 */
export default function PhoneMessagesScreen() {
  return <Inbox showSettingsLink />;
}
