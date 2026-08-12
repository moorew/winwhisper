import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

export type EngineState = "starting" | "ready" | "offline";

/**
 * Health of the Python engine, as three states rather than two.
 *
 * The distinction matters because the shell learns the port the moment the
 * engine prints it, which is well before uvicorn binds — the engine still has
 * to import torch and open the database, which is tens of seconds on a cold
 * start. Treating "not answering yet" as offline made a normal launch look like
 * a failure, complete with errors, for the first minute.
 *
 * So: "starting" until the first successful health check, and only "offline"
 * once it has answered at least once and then stopped.
 */
export function useEngineHealth(portKnown: boolean) {
  const [state, setState] = useState<EngineState>("starting");
  const everHealthy = useRef(false);

  const check = useCallback(async () => {
    try {
      const res = await api.health();
      if (res.status === "ok") {
        everHealthy.current = true;
        setState("ready");
        return;
      }
      setState(everHealthy.current ? "offline" : "starting");
    } catch {
      setState(everHealthy.current ? "offline" : "starting");
    }
  }, []);

  useEffect(() => {
    if (!portKnown) return;
    check();
    // Poll briskly until it comes up, then back off — a cold start is the only
    // time anyone is waiting on this.
    const id = setInterval(check, everHealthy.current ? 5000 : 1000);
    return () => clearInterval(id);
  }, [portKnown, check, state]);

  return { state, healthy: state === "ready" };
}

/**
 * Shared engine state.
 *
 * App polls once and publishes here; the rail and the dashboard both read it.
 * Two independent pollers would double the request rate and, worse, could
 * briefly disagree — the rail showing "starting" while the header said ready.
 */
const EngineStateContext = createContext<EngineState>("starting");

export const EngineStateProvider = EngineStateContext.Provider;

export function useEngineState(): EngineState {
  return useContext(EngineStateContext);
}
