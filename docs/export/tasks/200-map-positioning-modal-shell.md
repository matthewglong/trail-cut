# Task 200 — Map Positioning modal shell

**Step**: Layout & Export UI (positioning track)
**Estimated effort**: ~0.5 day
**Status**: pending
**Depends on**: —
**Companion plan**: `docs/export/plans/layout-ui.md`

## Goal

Add an entry-point button to `MapToolbar` that opens an empty modal scaffold. Modal body is a "coming next task" placeholder. After this task:

- Clicking a layout icon button in `MapToolbar` opens a centered modal.
- Modal has a header (title "Map Positioning" + close X), placeholder body, and dismisses on Esc / backdrop click / X.
- No layout state mutations yet — pure chrome.

## Files to touch

- **New** `src/components/MapPositioningModal/MapPositioningModal.tsx` — controlled component (`open`, `onClose`).
- **New** `src/components/MapPositioningModal/index.ts` — barrel.
- **New** `src/components/MapPositioningModal/__tests__/MapPositioningModal.test.tsx`.
- **Modified** `src/components/MapToolbar/MapToolbar.tsx` — layout icon button; calls parent-supplied `onOpenPositioning?: () => void`.
- **Modified** `src/screens/ProjectView.tsx` — `positioningModalOpen` state + plumbing to MapToolbar and modal.

## Implementation notes

- Render via React portal (`createPortal` to `document.body`) to escape z-index conflicts with the 3-pane layout.
- Backdrop: semi-transparent black, click closes.
- Esc handler attached at `document` level only while `open`; cleanup on unmount.
- Sizing: `width: min(80vw, 1200px); min-width: 720px; height: 70vh`.
- Icon choice: simple layout glyph (e.g. two stacked rectangles); tooltip "Map positioning" — see `layout-ui.md` §7.

## Acceptance

- [ ] Layout button visible in `MapToolbar`.
- [ ] Click opens modal.
- [ ] Modal dismisses via backdrop click, X button, and Esc.
- [ ] Existing `MapToolbar` controls (project/clip scope, style, etc.) unaffected.

## Tests

- Component test: open/close via prop transitions; backdrop click; X click; Esc key; handler cleanup on unmount.
- Manual: open modal, confirm video preview, timeline, and map still render and are not stuck behind the backdrop.
