"use client";

import { useEffect, useState } from "react";

import { controlPlaneRequest } from "@/lib/control-plane-client";

// Read-only is a property of the credential backend, not of any one feature, so the
// settings forms share this single lookup instead of each view type carrying the flag.
const QUERY = `query CredentialStoreWritability {
  credentialStoreStatus { readOnly }
}`;

type Response = { credentialStoreStatus: { readOnly: boolean } };

let cached: boolean | null = null;

export function useCredentialStoreReadOnly(): boolean {
  const [readOnly, setReadOnly] = useState(cached ?? false);

  useEffect(() => {
    // A resolved lookup is already the initial state, so only a cold cache needs the query.
    if (cached !== null) return;
    let cancelled = false;
    void controlPlaneRequest<Response>(QUERY)
      .then((data) => {
        cached = data.credentialStoreStatus.readOnly;
        if (!cancelled) setReadOnly(cached);
      })
      .catch(() => {
        // A failed probe must never lock a writable install out of its own settings.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return readOnly;
}
