/**
 * Shared pieces of the Gmail surface: the folder rail, a thread row, the
 * thread reader, the label picker, and the compose hand-off. Used by
 * `/inbox`, `/inbox/[threadId]`, `/inbox/compose` and the CRM's Email pane.
 */
export { FolderRail, FolderStrip } from './FolderRail';
export { ThreadRow } from './ThreadRow';
export { ThreadView, type ThreadChange } from './ThreadView';
export { LabelPicker } from './LabelPicker';
export { composeRouteParams, stashCompose, takeCompose } from './composeStash';
export {
  SYSTEM_FOLDERS,
  attachmentIcon,
  emptyFolderCopy,
  folderTitle,
  formatSize,
  formatWhen,
  labelLeaf,
  relativeTime,
} from './format';
