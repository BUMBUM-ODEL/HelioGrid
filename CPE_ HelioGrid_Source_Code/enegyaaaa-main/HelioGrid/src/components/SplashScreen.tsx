import { useEffect, useState } from 'react';
import { Zap } from 'lucide-react';

interface SplashScreenProps {
  onComplete: () => void;
}

export function SplashScreen({ onComplete }: SplashScreenProps) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    // Simulate loading progress
    const interval = setInterval(() => {
      setProgress((prev) => {
        
        if (prev >= 100) {
          clearInterval(interval);
          setTimeout(() => onComplete(), 300);
          return 100;
        }
        return prev + 2;
      });
    }, 30);

    return () => clearInterval(interval);
  }, [onComplete]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900 flex items-center justify-center relative overflow-hidden">
      {/* Animated background elements */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute w-96 h-96 bg-blue-500/20 rounded-full blur-3xl -top-48 -left-48 animate-pulse" />
        <div className="absolute w-96 h-96 bg-sky-500/20 rounded-full blur-3xl -bottom-48 -right-48 animate-pulse" style={{ animationDelay: '700ms' }} />
        <div className="absolute w-64 h-64 bg-cyan-500/20 rounded-full blur-3xl top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 animate-pulse" style={{ animationDelay: '300ms' }} />
      </div>

      {/* Grid pattern overlay */}
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:50px_50px]" />

      {/* Logo and loading animation */}
      <div className="relative z-10 flex flex-col items-center gap-8 animate-in fade-in duration-700">
        {/* Logo */}
        <div className="relative">
          {/* Outer ring animation */}
          <div className="absolute inset-0 -m-8">
            <div className="w-40 h-40 border-4 border-sky-500/30 rounded-full animate-spin" style={{ animationDuration: '3s' }} />
          </div>
          <div className="absolute inset-0 -m-6">
            <div className="w-36 h-36 border-4 border-blue-500/20 rounded-full animate-spin" style={{ animationDuration: '2s', animationDirection: 'reverse' }} />
          </div>

          {/* Logo container */}
          <div className="relative w-24 h-24 bg-gradient-to-br from-sky-400 to-blue-600 rounded-3xl flex items-center justify-center shadow-2xl shadow-blue-500/50 animate-pulse">
            <Zap className="w-14 h-14 text-white" />
          </div>
        </div>

        {/* Title */}
        <div className="text-center space-y-2">
          <h1 className="text-4xl sm:text-5xl text-white animate-in slide-in-from-bottom duration-700" style={{ animationDelay: '200ms' }}>
            HelioGrid
          </h1>
          <p className="text-xl text-blue-300 animate-in slide-in-from-bottom duration-700" style={{ animationDelay: '400ms' }}>
            Campus Resilience System
          </p>
        </div>

        {/* Progress bar */}
        <div className="w-64 sm:w-80 animate-in slide-in-from-bottom duration-700" style={{ animationDelay: '600ms' }}>
          <div className="h-1.5 bg-white/10 rounded-full overflow-hidden backdrop-blur-sm">
            <div 
              className="h-full bg-gradient-to-r from-sky-400 to-blue-600 rounded-full transition-all duration-300 ease-out shadow-lg shadow-blue-500/50"
              style={{ width: `${progress}%` }}
            />
          </div>
          <div className="mt-3 text-center">
            <span className="text-sm text-blue-300">Initializing system...</span>
          </div>
        </div>

        {/* Feature badges */}
        <div className="flex items-center gap-4 text-xs text-blue-200 animate-in slide-in-from-bottom duration-700" style={{ animationDelay: '800ms' }}>
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            <span>Secure</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" style={{ animationDelay: '300ms' }} />
            <span>Automated</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" style={{ animationDelay: '600ms' }} />
            <span>Real-Time</span>
          </div>
        </div>
      </div>
    </div>
  );
}
