"use client";

import { apiKeyClient } from "@better-auth/api-key/client";
import { createAuthClient } from "better-auth/react";
import { adminClient, oneTimeTokenClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [adminClient(), apiKeyClient(), oneTimeTokenClient()],
});
