"use client";

import { useEffect, useState } from "react";

export function useBuildTimeTicker(): number | null {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    const update = () => setNow(Date.now());
    const initial = window.setTimeout(update, 0);
    const ticker = window.setInterval(update, 1_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(ticker);
    };
  }, []);

  return now;
}
