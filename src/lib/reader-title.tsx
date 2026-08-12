import { createContext, useContext, useEffect } from "react";

/**
 * The titlebar appends the open transcript's name ("WinWhisper — Board sync").
 * The reader is several routes below the shell, so it publishes the title here
 * rather than the shell reaching down into the route.
 */
const ReaderTitleContext = createContext<(title: string | null) => void>(() => {});

export const ReaderTitleProvider = ReaderTitleContext.Provider;

/** Publishes a title while mounted and clears it on the way out. */
export function useSetReaderTitle(title: string | null | undefined) {
  const set = useContext(ReaderTitleContext);
  useEffect(() => {
    set(title ?? null);
    return () => set(null);
  }, [set, title]);
}
