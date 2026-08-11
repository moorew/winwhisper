import { describe, expect, it, vi, afterEach } from "vitest";
import {
  formatDuration,
  formatFileSize,
  formatRelativeTime,
  parseEngineDate,
  safeFilename,
} from "./utils";

describe("safeFilename", () => {
  it("keeps ordinary titles intact", () => {
    expect(safeFilename("Team standup 2026-08-11")).toBe("Team standup 2026-08-11");
  });

  it("strips every character Windows forbids", () => {
    // A realistic YouTube title — ":" and "|" are extremely common in them.
    expect(safeFilename('Ep 12: Rust vs Go | "the truth"')).toBe(
      "Ep 12- Rust vs Go - -the truth-"
    );
    expect(safeFilename("a/b\\c*d?e<f>g")).toBe("a-b-c-d-e-f-g");
  });

  it("removes trailing dots and spaces, which Windows rejects", () => {
    expect(safeFilename("report...")).toBe("report");
    expect(safeFilename("  spaced  ")).toBe("spaced");
  });

  it("falls back when nothing usable is left", () => {
    expect(safeFilename("")).toBe("transcript");
    expect(safeFilename("...")).toBe("transcript");
    expect(safeFilename("", "fallback-name")).toBe("fallback-name");
  });

  it("avoids reserved Windows device names", () => {
    expect(safeFilename("CON")).toBe("transcript");
    expect(safeFilename("nul")).toBe("transcript");
    expect(safeFilename("COM1")).toBe("transcript");
    // Only exact matches are reserved.
    expect(safeFilename("console")).toBe("console");
  });

  it("caps the length so the full path stays under the Windows limit", () => {
    expect(safeFilename("x".repeat(300))).toHaveLength(120);
  });
});

describe("parseEngineDate", () => {
  afterEach(() => vi.useRealTimers());

  it("reads the engine's naive timestamps as UTC, not local time", () => {
    // Without the "Z", ECMAScript parses this as local time and every
    // timestamp in the UI is wrong by the user's UTC offset.
    expect(parseEngineDate("2026-08-11T18:49:59.677994").toISOString()).toBe(
      "2026-08-11T18:49:59.677Z"
    );
  });

  it("leaves timestamps that already carry a zone alone", () => {
    expect(parseEngineDate("2026-08-11T18:49:59Z").toISOString()).toBe(
      "2026-08-11T18:49:59.000Z"
    );
    expect(parseEngineDate("2026-08-11T20:49:59+02:00").toISOString()).toBe(
      "2026-08-11T18:49:59.000Z"
    );
  });

  it("reports a just-created transcript as recent regardless of timezone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T18:50:00Z"));
    expect(formatRelativeTime("2026-08-11T18:49:59.677994")).toBe("just now");
  });
});

describe("formatDuration", () => {
  it("formats under an hour as m:ss", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(65)).toBe("1:05");
  });

  it("formats an hour or more as h:mm:ss", () => {
    expect(formatDuration(3725)).toBe("1:02:05");
  });
});

describe("formatFileSize", () => {
  it("scales units", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2.0 KB");
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatFileSize(3 * 1024 ** 3)).toBe("3.00 GB");
  });
});
