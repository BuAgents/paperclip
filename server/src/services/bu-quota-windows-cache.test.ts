// bu-fork: refresh-on-read quota cache — no timer, one refresh at a time.
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../middleware/logger.js", () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));
import {
  QUOTA_WINDOWS_CACHE_TTL_MS,
  pendingQuotaWindowsRefreshForTests,
  readCachedQuotaWindows,
  resetCachedQuotaWindowsForTests,
} from "./bu-quota-windows-cache.js";

const result = { provider: "openai", ok: true, windows: [] };

describe("bu quota windows cache", () => {
  beforeEach(() => resetCachedQuotaWindowsForTests());

  it("returns null and starts one refresh when empty, then serves the snapshot", async () => {
    const fetchWindows = vi.fn().mockResolvedValue([result]);
    expect(readCachedQuotaWindows({ now: 1_000, fetchWindows })).toBeNull();
    expect(readCachedQuotaWindows({ now: 1_000, fetchWindows })).toBeNull();
    await pendingQuotaWindowsRefreshForTests();
    expect(fetchWindows).toHaveBeenCalledOnce();
    const now = Date.now();
    expect(readCachedQuotaWindows({ now, fetchWindows })).toMatchObject({ results: [result] });
    expect(fetchWindows).toHaveBeenCalledOnce();
  });

  it("serves a stale snapshot immediately while refreshing it in the background", async () => {
    const fetchWindows = vi.fn().mockResolvedValue([result]);
    readCachedQuotaWindows({ fetchWindows });
    await pendingQuotaWindowsRefreshForTests();
    const first = readCachedQuotaWindows({ fetchWindows });
    const later = Date.now() + QUOTA_WINDOWS_CACHE_TTL_MS + 1;
    let release!: (value: unknown[]) => void;
    fetchWindows.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    expect(readCachedQuotaWindows({ now: later, fetchWindows })).toBe(first);
    expect(fetchWindows).toHaveBeenCalledTimes(2);
    release([{ ...result, provider: "anthropic" }]);
    await pendingQuotaWindowsRefreshForTests();
    expect(readCachedQuotaWindows({ now: Date.now(), fetchWindows })?.results[0]?.provider).toBe("anthropic");
  });

  it("keeps the previous snapshot when a refresh fails", async () => {
    const fetchWindows = vi.fn().mockResolvedValue([result]);
    readCachedQuotaWindows({ fetchWindows });
    await pendingQuotaWindowsRefreshForTests();
    fetchWindows.mockRejectedValueOnce(new Error("down"));
    readCachedQuotaWindows({ now: Date.now() + QUOTA_WINDOWS_CACHE_TTL_MS + 1, fetchWindows });
    await pendingQuotaWindowsRefreshForTests();
    expect(readCachedQuotaWindows({ now: Date.now(), fetchWindows })).toMatchObject({ results: [result] });
  });
});
