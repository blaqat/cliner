/**
 * Slots in the where pill for the per-thread worktree toggle (PLAN step 8). Both render nothing until
 * step 8 wires in its self-contained `WorktreeToggle`:
 * - `WorktreeToggleSlot`: the "Workspace" section of the pill's menu (heading + toggle).
 * - `WorktreeBadgeSlot`: the pill's own workspace hint (e.g. " · ⑂" when the thread is isolated).
 */
export const WorktreeToggleSlot = (_props: { threadId?: string }) => null

export const WorktreeBadgeSlot = (_props: { threadId?: string }) => null
