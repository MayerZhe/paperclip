// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SwipeToArchive } from "./SwipeToArchive";

// Tell React this environment uses act() for event flushing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function dispatchTouchEvent(
  node: Element,
  type: "touchstart" | "touchmove" | "touchend",
  coords: { x: number; y: number },
) {
  const event = new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches: type === "touchend" ? [] : [{ clientX: coords.x, clientY: coords.y } as Touch],
    changedTouches: [{ clientX: coords.x, clientY: coords.y } as Touch],
  });
  node.dispatchEvent(event);
}

describe("SwipeToArchive", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    container.remove();
  });

  it("suppresses descendant clicks after a horizontal swipe and archives the row", async () => {
    const onArchive = vi.fn();
    const onClick = vi.fn();
    const root = createRoot(container);

    act(() => {
      root.render(
        <SwipeToArchive onArchive={onArchive}>
          <button type="button" onClick={onClick}>
            Open issue
          </button>
        </SwipeToArchive>,
      );
    });

    const wrapper = container.firstElementChild as HTMLDivElement;
    const button = container.querySelector("button");
    expect(button).not.toBeNull();

    Object.defineProperty(wrapper, "offsetWidth", { configurable: true, value: 200 });
    Object.defineProperty(wrapper, "offsetHeight", { configurable: true, value: 48 });

    // The SwipeToArchive gesture pipeline:
    //   touchstart  → records start coords + layout width in refs
    //   touchmove   → detects horizontal drag > 6 px, sets suppressClickRef
    //                 (ref) and calls setOffsetX (React state). React 19
    //                 classifies touchmove as ContinuousEventPriority which
    //                 does not commit state updates synchronously in jsdom.
    //   touchend    → compares |offsetX| against COMMIT_THRESHOLD and fires
    //                 commitArchive → setTimeout(onArchive, 140 ms).
    //
    // To work around React 19's continuous-event batching, we dispatch
    // touchstart and touchmove inside the same act() callback so they share
    // a flushSync boundary, then advance timers to let the deferred state
    // commit resolve before touchend runs.
    act(() => {
      dispatchTouchEvent(wrapper, "touchstart", { x: 180, y: 20 });
      dispatchTouchEvent(wrapper, "touchmove", { x: 80, y: 22 });
    });

    // Advance timers to release React's internal scheduler deferrals
    act(() => {
      vi.advanceTimersByTime(0);
    });

    act(() => {
      dispatchTouchEvent(wrapper, "touchend", { x: 80, y: 22 });
    });

    act(() => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    // suppressClickRef is a ref — synchronous regardless of state flush
    expect(onClick).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(140);
    });

    expect(onArchive).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });

  it("does not suppress a normal tap click", async () => {
    const onArchive = vi.fn();
    const onClick = vi.fn();
    const root = createRoot(container);

    act(() => {
      root.render(
        <SwipeToArchive onArchive={onArchive}>
          <button type="button" onClick={onClick}>
            Open issue
          </button>
        </SwipeToArchive>,
      );
    });

    const button = container.querySelector("button");
    expect(button).not.toBeNull();

    act(() => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onArchive).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it("renders the selected inbox treatment on the swipe surface", async () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <SwipeToArchive onArchive={() => {}} selected>
          <button type="button">Open issue</button>
        </SwipeToArchive>,
      );
    });

    const surface = container.querySelector("[data-inbox-row-surface]") as HTMLDivElement | null;
    expect(surface).not.toBeNull();
    expect(surface?.className).toContain("bg-zinc-100");
    expect(surface?.className).toContain("dark:bg-zinc-800");
    expect(surface?.className).not.toContain("bg-card");
    expect(surface?.style.backgroundColor).toBe("");
    expect(surface?.style.boxShadow).toBe("");

    act(() => {
      root.unmount();
    });
  });
});
