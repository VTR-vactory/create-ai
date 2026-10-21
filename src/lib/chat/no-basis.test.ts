import { describe, expect, it, vi } from "vitest";
import { createNoBasisResponse, NO_BASIS_TEXT } from "./no-basis";

describe("createNoBasisResponse", () => {
  it("输出无依据文案，并在流结束后回调 onFinish", async () => {
    const onFinish = vi.fn();

    const response = createNoBasisResponse({
      originalMessages: [],
      onFinish,
    });

    const body = await response.text();
    expect(body).toContain("没有找到依据");
    expect(body).toContain(NO_BASIS_TEXT.slice(0, 10));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });
});
