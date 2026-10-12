# HelioGrid Frontend Structure

Quick guide para mas mabilis mag-debug at maintindihan ang frontend.

## Main entry points

- `main.tsx` – app bootstrap.
- `App.tsx` – main layout, auth/session gate, route-like view switching.

## Core folders

- `components/`
  - High-level screens/views (`DashboardView`, `AdminView`, `SystemModulesView`, etc.)
  - `cards/` – feature cards/widgets na ginagamit sa dashboard at analytics.
  - `ui/` – reusable low-level UI primitives (buttons, dialogs, tabs, etc.).
- `contexts/`
  - Global state layer (`EnergySystemContext`) for sensor/system data and refresh flow.
- `hooks/`
  - Reusable logic (`useAutoRefresh`, `useEmailService`).
- `utils/`
  - API/network utilities (`api.ts`).
- `styles/`
  - Shared styling (`globals.css`).
- `assets/`
  - Static images used by UI.

## Debug flow (recommended)

1. **UI issue** → start in `App.tsx` or relevant file in `components/`.
2. **Wrong data in UI** → trace from component → `contexts/EnergySystemContext.tsx`.
3. **API/network issue** → check `utils/api.ts` endpoints and request payloads.
4. **Auto-refresh behavior** → inspect `hooks/useAutoRefresh.ts`.

## Cleanup done

Unused frontend backup files (`*.bak`) under `src/components/cards/` were removed to reduce noise during debugging.
