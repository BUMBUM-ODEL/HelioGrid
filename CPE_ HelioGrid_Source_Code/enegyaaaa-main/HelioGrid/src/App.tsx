import { useState, useEffect, useCallback } from "react";
import { Sidebar } from "./components/Sidebar";
import { DashboardView } from "./components/DashboardView";
// import { LCDPreview } from "./components/LCDPreview"; // Hidden — using KioskLCD instead
import { AnomalyLogView } from "./components/AnomalyLogView";
import { SensorDataLogsView } from "./components/SensorDataLogsView";
import { NotificationsView as AlertConfigView } from "./components/NotificationsView";
import { AdminView } from "./components/AdminView";
import { LoginPage } from "./components/LoginPage";
import { SplashScreen } from "./components/SplashScreen";
import { SystemModulesView } from "./components/SystemModulesView";

import { SolarPanelsStatusCard } from "./components/cards/SolarPanelsStatusCard";
import { PowerHistoryCard, CumulativeConsumptionCard, AnomalyHistoryCard, DCVoltageAnomalyCard } from "./components/cards/PowerHistoryCard";
import { UnifiedSSROutletCard } from "./components/cards/UnifiedSSROutletCard";

import { Menu, X } from "lucide-react";
import { EnergySystemProvider, useEnergySystem } from "./contexts/EnergySystemContext";
import { useAutoRefresh } from "./hooks/useAutoRefresh";
import { KioskLCD } from "./components/KioskLCD";

export type ViewType =
  | "dashboard"
  | "pv-array"
  | "analytics"
  | "power-control"
  | "lcd"
  | "kiosk"
  | "history"
  | "alert-config"
  | "sensor-logs"
  | "system-modules"
  | "admin";

export interface GoogleUser {
  name: string;
  email: string;
  picture: string;
}

// ── Session helpers ──────────────────────────────────────────────────────────
const SESSION_KEY = "heliogrid_user";

function saveSession(user: GoogleUser): void {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(user)); } catch { /* ignore */ }
}

function loadSession(): GoogleUser | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? (JSON.parse(raw) as GoogleUser) : null;
  } catch { return null; }
}

function clearSession(): void {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}
// ────────────────────────────────────────────────────────────────────────────

/**
 * Hook: tracks viewport width and returns breakpoint helpers.
 * Updates on resize and orientation change (important for iOS Safari).
 */
function useViewport() {
  const [width, setWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    let raf: number;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setWidth(window.innerWidth));
    };

    window.addEventListener("resize", update);
    // orientationchange fires earlier than resize on iOS
    window.addEventListener("orientationchange", update);
    // Also handle iOS safe-area changes from keyboard
    window.visualViewport?.addEventListener("resize", update);

    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      window.visualViewport?.removeEventListener("resize", update);
      cancelAnimationFrame(raf);
    };
  }, []);

  return {
    width,
    isMobile: width < 640,        // < sm
    isTablet: width >= 640 && width < 1024,  // sm → lg
    isDesktop: width >= 1024,     // ≥ lg
  };
}

function PageWrapper({ title, subtitle, children }: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="p-3 sm:p-4 lg:p-6 xl:p-8 space-y-4 sm:space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl lg:text-3xl font-bold text-slate-800">{title}</h1>
        <p className="text-xs sm:text-sm text-slate-500 mt-0.5">{subtitle}</p>
      </div>
      {children}
    </div>
  );
}

// Sidebar widths
const SIDEBAR_FULL = 220;
const SIDEBAR_COLLAPSED = 60;

function AppContent() {
  const isKiosk = window.location.search.includes("kiosk=true");
  const savedUser = loadSession();

  const { isMobile, isTablet, isDesktop } = useViewport();

  const [showSplash, setShowSplash]         = useState(!isKiosk && savedUser === null);
  const [isLoggedIn, setIsLoggedIn]         = useState(isKiosk || savedUser !== null);
  const [activeView, setActiveView]         = useState<ViewType>(isKiosk ? "kiosk" : "dashboard");
  const [sidebarOpen, setSidebarOpen]       = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [googleUser, setGoogleUser]         = useState<GoogleUser | null>(savedUser);

  // Auto-collapse sidebar on mobile/tablet; restore on desktop
  useEffect(() => {
    if (isMobile || isTablet) {
      setSidebarOpen(false);       // always close drawer on resize
    }
    if (isDesktop) {
      setSidebarOpen(false);       // not used on desktop
    }
  }, [isMobile, isTablet, isDesktop]);

  // Close drawer when navigating (mobile UX)
  const handleSetActiveView = useCallback((view: ViewType) => {
    setActiveView(view);
    if (!isDesktop) setSidebarOpen(false);
  }, [isDesktop]);

  // ── Handle Google OAuth callback ────────────────────────────────────────────
  useEffect(() => {
    if (window.location.pathname === "/auth/callback") {
      const hash = new URLSearchParams(window.location.hash.replace("#", ""));
      const idToken = hash.get("id_token");
      if (idToken) {
        try {
          const payload = JSON.parse(atob(idToken.split(".")[1]));
          const user = { email: payload.email, name: payload.name || payload.email, picture: payload.picture || "" };
          handleLogin(user);
          window.history.replaceState({}, "", "/");
          return;
        } catch { /* fall through */ }
      }
      const params = new URLSearchParams(window.location.search);
      const email = params.get("email");
      const name  = params.get("name");
      const picture = params.get("picture") || "";
      if (email && name) {
        handleLogin({ email, name, picture });
        window.history.replaceState({}, "", "/");
      }
    }
  }, []);

  const { refreshData } = useEnergySystem();

  useAutoRefresh({
    onRefresh: refreshData,
    idleTimeout: 5 * 60 * 1000,
    enableIdleRefresh: true,
    enablePeriodicRefresh: false,
  });

  const handleLogin = (user: GoogleUser) => {
    saveSession(user);
    setGoogleUser(user);
    setIsLoggedIn(true);
  };

  const handleLogout = () => {
    clearSession();
    setIsLoggedIn(false);
    setGoogleUser(null);
  };

  // ── Kiosk mode ──────────────────────────────────────────────────────────────
  if (isKiosk) {
    return (
      <div style={{ width: "100vw", height: "100vh", overflow: "hidden", background: "#000" }}>
        <KioskLCD />
      </div>
    );
  }

  if (showSplash) return <SplashScreen onComplete={() => setShowSplash(false)} />;
  if (!isLoggedIn) return <LoginPage onLogin={handleLogin} />;

  // ── Sidebar width logic ─────────────────────────────────────────────────────
  // Mobile/tablet: sidebar is a drawer (overlay), no space reserved in flex layout
  // Desktop: sidebar is static, width depends on sidebarCollapsed
  const desktopSidebarWidth = sidebarCollapsed ? SIDEBAR_COLLAPSED : SIDEBAR_FULL;

  return (
    <div
      className="flex bg-slate-50 font-sans"
      style={{
        // Use dvh (dynamic viewport height) so iOS Safari bottom bar is handled.
        // Falls back to 100vh for older browsers.
        height: "100dvh",
        overflow: "hidden",
      }}
    >
      {/* ── Mobile/Tablet overlay backdrop ──────────────────────────────────── */}
      {sidebarOpen && !isDesktop && (
        <div
          className="fixed inset-0 bg-black/50 z-20"
          style={{ touchAction: "none" }} // prevent scroll bleed on iOS
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* ── Sidebar ─────────────────────────────────────────────────────────── */}
      {/*
        Mobile/Tablet : fixed drawer that slides in from the left (z-30).
                        Does NOT occupy space in the flex row.
        Desktop       : static flex child, width animates with sidebarCollapsed.
      */}
      <div
        className={[
          // positioning
          isDesktop
            ? "relative flex-shrink-0"
            : "fixed inset-y-0 left-0 z-30",
          // slide animation (mobile/tablet only)
          !isDesktop
            ? `transform transition-transform duration-300 ease-in-out ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`
            : "",
        ].join(" ")}
        style={
          isDesktop
            ? {
                width: desktopSidebarWidth,
                minWidth: desktopSidebarWidth,
                transition: "width 300ms ease, min-width 300ms ease",
              }
            : {
                // Drawer: fixed width on mobile/tablet
                width: SIDEBAR_FULL,
                // Support iOS safe area (notch / home indicator)
                paddingLeft: "env(safe-area-inset-left)",
              }
        }
      >
        <Sidebar
          activeView={activeView}
          setActiveView={handleSetActiveView}
          onClose={() => setSidebarOpen(false)}
          onLogout={handleLogout}
          collapsed={isDesktop ? sidebarCollapsed : false}
          onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
        />
      </div>

      {/* ── Main content ────────────────────────────────────────────────────── */}
      <div
        className="flex flex-col min-w-0"
        style={{
          flex: 1,
          overflow: "hidden",
          // On mobile/tablet the sidebar is a drawer (doesn't take space),
          // so main always fills 100%. On desktop it naturally fills the rest.
        }}
      >
        {/* Mobile / Tablet top bar */}
        {!isDesktop && (
          <header
            className="flex items-center justify-between bg-white border-b border-slate-200 shadow-sm flex-shrink-0"
            style={{
              padding: "0 16px",
              height: 56,
              // Respect iOS notch at the top
              paddingLeft: `calc(16px + env(safe-area-inset-left))`,
              paddingRight: `calc(16px + env(safe-area-inset-right))`,
            }}
          >
            <button
              onClick={() => setSidebarOpen(true)}
              className="p-2 hover:bg-slate-100 rounded-lg active:bg-slate-200"
              aria-label="Open menu"
              style={{ touchAction: "manipulation" }} // removes 300ms tap delay
            >
              <Menu className="w-6 h-6 text-slate-600" />
            </button>
            <h1 className="text-lg font-bold text-slate-800">HelioGrid</h1>
            {/* Close button visible when drawer is open */}
            {sidebarOpen ? (
              <button
                onClick={() => setSidebarOpen(false)}
                className="p-2 hover:bg-slate-100 rounded-lg active:bg-slate-200"
                aria-label="Close menu"
                style={{ touchAction: "manipulation" }}
              >
                <X className="w-6 h-6 text-slate-600" />
              </button>
            ) : (
              <div style={{ width: 40 }} aria-hidden="true" />
            )}
          </header>
        )}

        {/* Scrollable content area */}
        <main
          className="flex-1 overflow-auto bg-[#f8fafc]"
          style={{
            // iOS momentum scrolling
            WebkitOverflowScrolling: "touch",
            overscrollBehavior: "contain",
            // Bottom safe area for iPhones with home indicator
            paddingBottom: "env(safe-area-inset-bottom)",
          }}
        >
          {activeView === "dashboard"      && <DashboardView />}

          {activeView === "pv-array"       && (
            <PageWrapper title="PV Array Status" subtitle="Individual panel performance">
              <SolarPanelsStatusCard />
            </PageWrapper>
          )}

          {activeView === "analytics"      && (
            <PageWrapper title="Real-Time Analytics" subtitle="Power trends and data">
              <div className="space-y-6">
                <AnomalyHistoryCard onNavigateToLogs={() => handleSetActiveView("history")} />
                <DCVoltageAnomalyCard onNavigateToLogs={() => handleSetActiveView("history")} />
                <PowerHistoryCard />
                <CumulativeConsumptionCard />
              </div>
            </PageWrapper>
          )}

          {activeView === "power-control"  && (
            <PageWrapper title="Power & Load Control" subtitle="SSR and Outlets Management">
              <UnifiedSSROutletCard />
            </PageWrapper>
          )}

          {/* {activeView === "lcd" && <LCDPreview />} */}

          {activeView === "kiosk"          && (
            <div
              style={{
                position: "fixed",
                inset: 0,
                zIndex: 9999,
                overflow: "hidden",
              }}
            >
              <KioskLCD />
            </div>
          )}

          {activeView === "history"        && <AnomalyLogView />}
          {activeView === "alert-config"   && <AlertConfigView setActiveView={handleSetActiveView} />}
          {activeView === "sensor-logs"    && <SensorDataLogsView />}
          {activeView === "system-modules" && <SystemModulesView />}
          {activeView === "admin"          && <AdminView googleUser={googleUser} onLogout={handleLogout} />}
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <EnergySystemProvider>
      <AppContent />
    </EnergySystemProvider>
  );
}
