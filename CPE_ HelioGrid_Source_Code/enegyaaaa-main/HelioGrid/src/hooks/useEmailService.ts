import { useState, useCallback } from 'react';

// ============================================================================
// EMAIL SERVICE CONFIGURATION
// ============================================================================

// [FIX] Use relative URL so remote clients (192.168.254.130) work correctly.
// Vite proxy will forward /email-api/* to http://localhost:5001/api/*
// Add to vite.config.ts:  '/email-api': { target: 'http://localhost:5001', rewrite: ... }
//
// If you're NOT using Vite proxy, use the Pi's LAN IP instead:
//   const EMAIL_SERVICE_URL = 'http://192.168.254.XXX:5001';
//
// ⚠️  DO NOT use 'http://localhost:5001' — localhost on the remote browser
//    (tablet/phone) points to THAT device, not the Pi.
const EMAIL_SERVICE_URL = '/email-api';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface AlertEmailData {
  faultType: string;
  severity: 'critical' | 'warning' | 'info';
  source: string;
  systemAction: string;
  gridVoltage: string;
  solarPower: string;
  batterySOC: string;
  affectedLoad: string;
  timestamp: string;
  temperature: string;
}

interface EmailResponse {
  status: 'success' | 'error';
  message: string;
  emailStatus?: 'Sent' | 'Failed' | 'Queued';
  recipients?: string[];
  timestamp?: string;
}

// ============================================================================
// EMAIL SERVICE HOOK
// ============================================================================
export function useEmailService() {
  const [isHealthy, setIsHealthy] = useState(false);

  /**
   * 🏥 CHECK EMAIL SERVICE HEALTH
   */
  const checkHealth = useCallback(async (): Promise<boolean> => {
    try {
      const response = await fetch(`${EMAIL_SERVICE_URL}/api/health`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      if (response.ok) {
        const data = await response.json();
        const healthy = data.status === 'healthy';
        setIsHealthy(healthy);
        return healthy;
      }

      setIsHealthy(false);
      return false;
    } catch (error) {
      console.error('❌ Email service health check failed:', error);
      setIsHealthy(false);
      return false;
    }
  }, []);

  /**
   * 📧 SEND ALERT EMAIL
   */
  const sendAlert = useCallback(async (data: AlertEmailData): Promise<EmailResponse> => {
    try {
      const response = await fetch(`${EMAIL_SERVICE_URL}/api/send-alert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.message || 'Failed to send email');
      }

      return { ...result, emailStatus: 'Sent' };
    } catch (error) {
      console.error('❌ Failed to send alert email:', error);
      return {
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        emailStatus: 'Failed',
      };
    }
  }, []);

  /**
   * ✉️ SEND TEST EMAIL
   */
  const sendTestEmail = useCallback(async (email: string): Promise<EmailResponse> => {
    try {
      const response = await fetch(`${EMAIL_SERVICE_URL}/api/test-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.message || 'Failed to send test email');
      }

      return { ...result, emailStatus: 'Sent' };
    } catch (error) {
      console.error('❌ Failed to send test email:', error);
      return {
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        emailStatus: 'Failed',
      };
    }
  }, []);

  /**
   * 📋 GET RECIPIENTS LIST
   */
  const getRecipients = useCallback(async (): Promise<string[]> => {
    try {
      const response = await fetch(`${EMAIL_SERVICE_URL}/api/recipients`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      const result = await response.json();

      if (!response.ok) throw new Error('Failed to get recipients');

      return result.recipients || [];
    } catch (error) {
      console.error('❌ Failed to get recipients:', error);
      return [];
    }
  }, []);

  /**
   * 💾 UPDATE RECIPIENTS LIST
   */
  const updateRecipients = useCallback(async (emails: string[]): Promise<EmailResponse> => {
    try {
      const response = await fetch(`${EMAIL_SERVICE_URL}/api/recipients`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emails }),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.message || 'Failed to update recipients');
      }

      return result;
    } catch (error) {
      console.error('❌ Failed to update recipients:', error);
      throw error;
    }
  }, []);

  return {
    isHealthy,
    checkHealth,
    sendAlert,
    sendTestEmail,
    getRecipients,
    updateRecipients,
  };
}
