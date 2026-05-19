import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

export function useEngineHealth() {
  const [healthy, setHealthy] = useState(false);
  const [checking, setChecking] = useState(true);

  const check = useCallback(async () => {
    try {
      const res = await api.health();
      setHealthy(res.status === "ok");
    } catch {
      setHealthy(false);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    check();
    const interval = setInterval(check, 5000);
    return () => clearInterval(interval);
  }, [check]);

  return { healthy, checking, retry: check };
}
