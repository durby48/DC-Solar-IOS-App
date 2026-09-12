import type Ionicons from '@expo/vector-icons/Ionicons';

import type { MailFolder, MailLabel } from '@/lib/gmail';

/**
 * Small pure helpers shared by the inbox, the thread reader, the composer
 * and the CRM's Email pane. No React in here.
 */

export type IconName = keyof typeof Ionicons.glyphMap;

/** "now", "12m", "3h", "2d", then a date. Same ladder as the Comms inbox. */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 90) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(then).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function attachmentIcon(mimeType: string): IconName {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.includes('pdf')) return 'document-text';
  if (mimeType.includes('zip') || mimeType.includes('compressed')) return 'file-tray-full';
  if (mimeType.includes('sheet') || mimeType.includes('excel') || mimeType.includes('csv')) {
    return 'grid';
  }
  return 'document';
}

/** The fixed folders, in Gmail's sidebar order. Custom labels follow them. */
export const SYSTEM_FOLDERS: { key: MailFolder; label: string; icon: IconName; labelId: string | null }[] = [
  { key: 'inbox', label: 'Inbox', icon: 'mail', labelId: 'INBOX' },
  { key: 'starred', label: 'Starred', icon: 'star', labelId: 'STARRED' },
  { key: 'sent', label: 'Sent', icon: 'paper-plane', labelId: 'SENT' },
  { key: 'drafts', label: 'Drafts', icon: 'document-text', labelId: 'DRAFT' },
  { key: 'archive', label: 'All mail', icon: 'archive', labelId: null },
  { key: 'trash', label: 'Trash', icon: 'trash', labelId: 'TRASH' },
  { key: 'spam', label: 'Spam', icon: 'alert-circle', labelId: 'SPAM' },
];

export function folderTitle(folder: MailFolder, labels: MailLabel[]): string {
  const fixed = SYSTEM_FOLDERS.find((f) => f.key === folder);
  if (fixed) return fixed.label;
  if (folder === 'unread') return 'Unread';
  if (folder === 'all') return 'All mail';
  if (folder.startsWith('label:')) {
    const id = folder.slice('label:'.length);
    return labels.find((l) => l.id === id)?.name ?? 'Label';
  }
  return 'Mail';
}

/** Gmail nests labels with "/" — show the leaf, keep the path for a tooltip. */
export function labelLeaf(name: string): string {
  const parts = name.split('/');
  return parts[parts.length - 1] || name;
}

/** The sentence under an empty folder. */
export function emptyFolderCopy(folder: MailFolder): { title: string; body: string; icon: IconName } {
  switch (folder) {
    case 'inbox':
      return { title: 'Inbox is empty', body: 'Nothing new. Anything archived is under All mail.', icon: 'mail-outline' };
    case 'unread':
      return { title: 'Nothing unread', body: 'Inbox zero. Enjoy it.', icon: 'checkmark-done' };
    case 'starred':
      return { title: 'Nothing starred', body: 'Tap the star on a conversation to keep it here.', icon: 'star-outline' };
    case 'sent':
      return { title: 'Nothing sent yet', body: 'Mail you send from the app lands here, and in Gmail.', icon: 'paper-plane-outline' };
    case 'drafts':
      return { title: 'No drafts', body: 'Anything you start writing is saved here automatically.', icon: 'document-text-outline' };
    case 'trash':
      return { title: 'Trash is empty', body: 'Gmail keeps trashed mail for 30 days, then deletes it.', icon: 'trash-outline' };
    case 'spam':
      return { title: 'No spam', body: 'Gmail filters spam before it reaches the app.', icon: 'shield-checkmark-outline' };
    case 'archive':
    case 'all':
      return { title: 'Nothing here', body: 'Archived conversations show up under All mail.', icon: 'archive-outline' };
    default:
      return { title: 'Nothing with this label', body: 'Use Move to label on a conversation to file it here.', icon: 'pricetag-outline' };
  }
}
