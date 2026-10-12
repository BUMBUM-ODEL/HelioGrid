import { useEffect, useRef, useCallback } from 'react';

export interface UseAutoRefreshOptions {
  /** Callback function to execute when refresh is triggered */
  onRefresh: () => void;

  /**
   * How long (ms) the tab must be hidden before triggering a refresh on return.
   * Default: 2 minutes
   */
  idleTimeout?: number;

  /**
   * Interval (ms) for periodic background refresh.
   * Default: 60 seconds — set higher than Context poll intervals to avoid double-firing.
   * Set to 0 or pass enablePeriodicRefresh=false to disable entirely.
   *
   * ⚠️  NOTE: EnergySystemContext already polls every 5–10s on its own.
   * useAutoRefresh periodic refresh should NOT duplicate those — it is only
   * for a full page-level "stale data" refresh (e.g. after long idle).
   * Keep this ≥ 60s or disable it.
   */
  refreshInterval?: number;

  /** Enable refresh when returning to tab after being away. Default: true */
  enableIdleRefresh?: boolean;

  /**
   * Enable periodic refresh while tab is active. Default: FALSE
   *
   * [FIX] Changed default to false — EnergySystemContext already has its own
   * poll loops (5s sensor, 10s logs, etc.). Enabling periodic refresh here
   * causes every fetch to fire twice, doubling backend requests.
   * Only enable this if you're NOT using EnergySystemContext polling.
   */
  enablePeriodicRefresh?: boolean;
}

/**
 * Auto-refresh hook — handles stale-data refresh when returning to tab.
 *
 * 1. TAB VISIBILITY REFRESH — when you switch back to this tab after
 *    being away for `idleTimeout` ms, it immediately refreshes.
 *
 * 2. PERIODIC REFRESH — disabled by default when used alongside
 *    EnergySystemContext (which has its own poll intervals).
 *    Enable only for standalone pages without their own polling.
 *
 * Uses the Page Visibility API (document.visibilitychange).
 */
export function useAutoRefresh({
  onRefresh,
  idleTimeout = 2 * 60 * 1000,    // 2 minutes
  refreshInterval = 60 * 1000,     // 60s if periodic enabled (was 30s — doubled requests)
  enableIdleRefresh = true,
  enablePeriodicRefresh = false,   // [FIX] Default OFF — Context handles polling
}: UseAutoRefreshOptions) {
  const hiddenAt = useRef<number | null>(null);
  const periodicTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Stable ref so effects don't re-run when onRefresh identity changes
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => { onRefreshRef.current = onRefresh; }, [onRefresh]);

  // ─── Tab visibility handler ──────────────────────────────────────────────
  const handleVisibilityChange = useCallback(() => {
    if (document.hidden) {
      hiddenAt.current = Date.now();
    } else {
      const awayMs = hiddenAt.current ? Date.now() - hiddenAt.current : 0;

      if (enableIdleRefresh && awayMs >= idleTimeout) {
        console.log(`[AutoRefresh] Tab returned after ${Math.round(awayMs / 1000)}s — refreshing`);
        onRefreshRef.current();
      }

      hiddenAt.current = null;
    }
  }, [enableIdleRefresh, idleTimeout]);

  // ─── Tab visibility detection ────────────────────────────────────────────
  useEffect(() => {
    if (!enableIdleRefresh) return;

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [enableIdleRefresh, handleVisibilityChange]);

  // ─── Periodic refresh (disabled by default — Context has its own polls) ──
  useEffect(() => {
    if (!enablePeriodicRefresh || refreshInterval <= 0) return;

    periodicTimer.current = setInterval(() => {
      if (document.hidden) return; // skip if tab not visible
      console.log('[AutoRefresh] Periodic refresh');
      onRefreshRef.current();
    }, refreshInterval);

    console.log(`[AutoRefresh] Periodic refresh every ${refreshInterval / 1000}s`);

    return () => {
      if (periodicTimer.current) clearInterval(periodicTimer.current);
    };
  }, [enablePeriodicRefresh, refreshInterval]);

  // ─── Initial load ────────────────────────────────────────────────────────
  useEffect(() => {
    onRefreshRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    forceRefresh: () => onRefreshRef.current(),
    isTabHidden: () => document.hidden,
    getHiddenDuration: () => hiddenAt.current ? Date.now() - hiddenAt.current : 0,
  };
}
