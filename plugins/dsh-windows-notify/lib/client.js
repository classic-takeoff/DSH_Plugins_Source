// Client half of the Windows notification bridge.
//
// The Host injects `__DSH_DESKTOP_NOTIFY__` into the index boot payload. This
// half reports whether the window is focused/visible (so the Host can suppress
// toasts while the user is already looking at the app) and repeatedly asks the
// Host for "open session" activations produced by a toast click.
//
// It deliberately renders nothing: the notification surface is the Windows
// Action Center, never an HTML overlay.

window.__ModuleLoader__.load({
  id: "dsh-windows-notify",
  factory() {
    const POLL_MS = 2500;
    const PRESENCE_MS = 5000;

    function start(ctx, config) {
      const base = String(config.path || "").replace(/\/+$/, "");
      const key = String(config.key || "");
      if (!base || !key) return () => {};
      if (typeof window === "undefined" || typeof window.fetch !== "function") return () => {};

      const controller = new AbortController();
      const seen = new Set();
      let stopped = false;
      let pollTimer;
      let presenceTimer;

      const headers = () => ({
        "content-type": "application/json",
        "x-dsh-notify-key": key,
      });

      async function report() {
        if (stopped || typeof document === "undefined") return;
        const body = JSON.stringify({
          focused: document.hasFocus(),
          visible: document.visibilityState === "visible",
        });
        try {
          await fetch(base + "/presence", {
            method: "POST",
            headers: headers(),
            body,
            signal: controller.signal,
            keepalive: true,
          });
        } catch {
          // The Host may be starting or stopping; the next heartbeat retries.
        }
      }

      async function acknowledge(tokens) {
        if (tokens.length === 0) return;
        try {
          await fetch(base + "/ack", {
            method: "POST",
            headers: headers(),
            body: JSON.stringify({ tokens }),
            signal: controller.signal,
          });
        } catch {
          // Leaving the activation pending is safer than losing it.
        }
      }

      async function poll() {
        if (stopped) return;
        await report();
        try {
          const response = await fetch(base + "/pending?key=" + encodeURIComponent(key), {
            signal: controller.signal,
            cache: "no-store",
          });
          if (!response.ok) return;
          const data = await response.json();
          const opens = Array.isArray(data?.opens) ? data.opens : [];
          for (const open of opens) {
            if (stopped || !open || typeof open.token !== "string" || typeof open.sessionId !== "string") continue;
            if (seen.has(open.token)) {
              void acknowledge([open.token]);
              continue;
            }
            seen.add(open.token);
            if (seen.size > 200) seen.clear();
            try {
              ctx.uiWorkspace.openSession(open.sessionId);
              await acknowledge([open.token]);
            } catch {
              // The session may still be loading; retry on the next poll.
              seen.delete(open.token);
            }
          }
        } catch {
          // Network/abort while the Host restarts: retry on the next interval.
        }
      }

      const onActivity = () => {
        void report();
        void poll();
      };
      const onPageHide = () => {
        void report();
      };

      window.addEventListener("focus", onActivity);
      window.addEventListener("blur", onActivity);
      document.addEventListener("visibilitychange", onActivity);
      window.addEventListener("pagehide", onPageHide);

      pollTimer = window.setInterval(() => { void poll(); }, POLL_MS);
      presenceTimer = window.setInterval(() => { void report(); }, PRESENCE_MS);
      void poll();

      return () => {
        stopped = true;
        controller.abort();
        if (pollTimer !== undefined) window.clearInterval(pollTimer);
        if (presenceTimer !== undefined) window.clearInterval(presenceTimer);
        window.removeEventListener("focus", onActivity);
        window.removeEventListener("blur", onActivity);
        document.removeEventListener("visibilitychange", onActivity);
        window.removeEventListener("pagehide", onPageHide);
      };
    }

    return {
      inject: ["uiWorkspace"],
      apply(ctx) {
        const config = globalThis.__DSH_DESKTOP_NOTIFY__;
        if (!config || typeof config !== "object") return;
        if (typeof config.path !== "string" || typeof config.key !== "string") return;
        ctx.effect(() => start(ctx, config), "windows-notify: client bridge");
      },
    };
  },
});
