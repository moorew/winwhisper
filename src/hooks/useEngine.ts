import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

export function useEngineHealth(engineReady: boolean) {
  const [healthy, setHealthy] = useState(false);

  const check = useCallback(async () => {
    try {
      const res = await api.health();
      setHealthy(res.status === "ok");
    } catch {
      setHealthy(false);
    }
  }, []);

  useEffect(() => {
    if (!engineReady) return;
    check();
    const id = setInterval(check, 5000);
    return () => clearInterval(id);
  }, [engineReady, check]);

  return { healthy };
}
